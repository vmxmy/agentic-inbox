// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * L4 Phase 7 — Integration matrix for MCP connection HTTP routes.
 *
 * Plan §561-570 specifies the test matrix:
 *   axes: [flag state] × [caller role] × [connection state] × [operation]
 *   shape: parametric `it.each` table with ≥30 cases
 *
 * Production routes live at workers/index.ts:1450-1525 (POST/DELETE/GET).
 * Each route does, in order:
 *   1. resolveUser  (401 if no auth context)
 *   2. assertMailboxOwner / assertMailboxAccess (403/404 on ACL fail)
 *   3. invoke EmailAgent stub RPC (which itself runs requireL4Enabled —
 *      503 "feature_disabled" path or RPC outcome)
 *
 * This suite re-creates the same try/catch ladder against a minimal Hono
 * app so we can iterate the full matrix in-process without booting a DO.
 * The EmailAgent stub is a hand-rolled mock matching the RPC surface
 * (`addExternalMcpServer` / `removeExternalMcpServer` / `listExternalMcpServers`).
 *
 * What this proves vs. what it doesn't:
 *   ✔ The route → ACL → flag → stub error mapping is internally consistent
 *   ✔ Each combination of (flag × role × op) returns the right HTTP status
 *   ✘ The actual SDK call inside EmailAgent — covered by tests/security/
 *     (real `MailboxBoundOAuthProvider`) and tests/mcp-connections.test.ts
 *     (real `buildConnectionFromSdkResult`)
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
	AuthzError,
	type AuthUser,
} from "../../workers/lib/auth";
import { MCP_AUTH_TYPES, isL4McpEnabled } from "../../workers/lib/mcp-connections";
import { redactTokenFromText } from "../../workers/lib/mcp-token-crypto";

// ── Stub fixtures ───────────────────────────────────────────────────

const ACL_FIXTURE = {
	owner: "owner@example.com",
	members: ["member@example.com"],
};

function mkUser(role: "owner" | "member" | "stranger" | "admin"): AuthUser {
	switch (role) {
		case "owner":
			return { id: "u-owner", email: ACL_FIXTURE.owner, role: "user" };
		case "member":
			return { id: "u-member", email: ACL_FIXTURE.members[0], role: "user" };
		case "stranger":
			return { id: "u-stranger", email: "stranger@example.com", role: "user" };
		case "admin":
			return { id: "u-admin", email: "admin@example.com", role: "admin" };
	}
}

type ConnState = "missing" | "authenticating" | "ready" | "disconnected";

interface StubOptions {
	flag: "true" | "false" | "unset";
	connState: ConnState;
	addErrorMessage?: string;
}

/**
 * Build a minimal in-memory EmailAgent stub matching the production RPC
 * shape. `flag === "true"` lets the operation run; otherwise `requireL4Enabled`
 * throws the canonical "L4 MCP feature disabled" error.
 */
function makeEmailAgentStub(opts: StubOptions) {
	const env = {
		L4_MCP_ENABLED:
			opts.flag === "unset" ? undefined : opts.flag,
	};
	const guard = () => {
		if (!isL4McpEnabled(env)) throw new Error("L4 MCP feature disabled");
	};
	return {
		lastAddInput: null as null | {
			authType: "oauth" | "bearer";
			serverName: string;
			url: string;
			displayName?: string;
			addedByUserId: string;
			callbackHost?: string;
			bearerToken?: string;
		},
		async addExternalMcpServer(input: {
			authType: "oauth" | "bearer";
			serverName: string;
			url: string;
			displayName?: string;
			addedByUserId: string;
			callbackHost?: string;
			bearerToken?: string;
		}) {
			guard();
			this.lastAddInput = input;
			if (opts.addErrorMessage) throw new Error(opts.addErrorMessage);
			if (opts.connState === "ready") {
				return {
					state: "ready" as const,
					connection: { id: "conn-x", lastState: "ready" },
				};
			}
			return {
				state: "authenticating" as const,
				connection: { id: "conn-x", lastState: "authenticating" },
				authUrl: "https://oauth/authorize?...",
			};
		},
		async removeExternalMcpServer(_id: string) {
			guard();
			if (opts.connState === "missing") return; // idempotent in production
		},
		async listExternalMcpServers() {
			guard();
			if (opts.connState === "missing") return [];
			return [
				{
					id: "conn-x",
					serverName: "github",
					serverUrl: "https://mcp.github.com/sse",
					lastState:
						opts.connState === "disconnected" ? "error" : opts.connState,
				},
			];
		},
	};
}

// ── Minimal Hono app mirroring production routes ─────────────────────

interface AppCtx {
	user: AuthUser;
	stub: ReturnType<typeof makeEmailAgentStub>;
}

function buildHarnessApp(ctx: AppCtx) {
	const app = new Hono();

	function resolveUser() {
		if (!ctx.user) throw new AuthzError(401, "Not authenticated");
		return ctx.user;
	}

	async function assertOwner(user: AuthUser) {
		if (user.role === "admin") return;
		if (user.email !== ACL_FIXTURE.owner) {
			throw new AuthzError(
				403,
				"Only the mailbox owner can perform this action",
			);
		}
	}

	async function assertAccess(user: AuthUser) {
		if (user.role === "admin") return;
		if (
			user.email !== ACL_FIXTURE.owner &&
			!ACL_FIXTURE.members.includes(user.email)
		) {
			throw new AuthzError(403, "Not authorized for this mailbox");
		}
	}

	function handleAuthz<E>(c: Parameters<Parameters<typeof app.get>[1]>[0], e: E) {
		if (e instanceof AuthzError) {
			return c.json({ error: e.message }, e.status);
		}
		return c.json({ error: "internal" }, 500);
	}

	const McpConnectionBaseBody = {
		url: z.string().url(),
		name: z.string().min(1).max(64),
		displayName: z.string().min(1).max(128).optional(),
	};
	const PostMcpConnectionBody = z.preprocess((value) => {
		if (
			value !== null &&
			typeof value === "object" &&
			!("authType" in value)
		) {
			return { ...value, authType: "oauth" };
		}
		return value;
	}, z.discriminatedUnion("authType", [
		z.object({
			...McpConnectionBaseBody,
			authType: z.literal(MCP_AUTH_TYPES[0]),
		}),
		z.object({
			...McpConnectionBaseBody,
			authType: z.literal(MCP_AUTH_TYPES[1]),
			bearerToken: z.string().min(1).max(8192),
		}),
	]));

	app.post("/api/v1/mailboxes/:mailboxId/mcp-connections", async (c) => {
		let user;
		try {
			user = resolveUser();
		} catch (e) {
			return handleAuthz(c, e);
		}
		try {
			await assertOwner(user);
		} catch (e) {
			return handleAuthz(c, e);
		}
		const parsed = PostMcpConnectionBody.safeParse(
			await c.req.json().catch(() => ({})),
		);
		if (!parsed.success) {
			return c.json({ error: "invalid_body" }, 400);
		}
		try {
			const result = await ctx.stub.addExternalMcpServer(
				parsed.data.authType === "bearer"
					? {
							authType: "bearer",
							serverName: parsed.data.name,
							url: parsed.data.url,
							displayName: parsed.data.displayName,
							addedByUserId: user.id,
							bearerToken: parsed.data.bearerToken,
						}
					: {
							authType: "oauth",
							serverName: parsed.data.name,
							url: parsed.data.url,
							displayName: parsed.data.displayName,
							addedByUserId: user.id,
							callbackHost: "https://app.example.com",
						},
			);
			return c.json(result);
		} catch (e) {
			const rawMsg = (e as Error).message;
			const msg =
				parsed.data.authType === "bearer"
					? redactTokenFromText(rawMsg, parsed.data.bearerToken)
					: rawMsg;
			if (msg === "L4 MCP feature disabled") {
				return c.json({ error: "feature_disabled" }, 503);
			}
			if (msg === "L4 MCP Bearer feature disabled") {
				return c.json({ error: "bearer_feature_disabled" }, 503);
			}
			return c.json({ error: "add_failed", message: msg }, 500);
		}
	});

	app.delete(
		"/api/v1/mailboxes/:mailboxId/mcp-connections/:connId",
		async (c) => {
			let user;
			try {
				user = resolveUser();
			} catch (e) {
				return handleAuthz(c, e);
			}
			try {
				await assertOwner(user);
			} catch (e) {
				return handleAuthz(c, e);
			}
			try {
				await ctx.stub.removeExternalMcpServer(c.req.param("connId")!);
				return c.json({ ok: true });
			} catch (e) {
				const msg = (e as Error).message;
				if (msg === "L4 MCP feature disabled") {
					return c.json({ error: "feature_disabled" }, 503);
				}
				return c.json({ error: "remove_failed", message: msg }, 500);
			}
		},
	);

	app.get("/api/v1/mailboxes/:mailboxId/mcp-connections", async (c) => {
		let user;
		try {
			user = resolveUser();
		} catch (e) {
			return handleAuthz(c, e);
		}
		try {
			await assertAccess(user);
		} catch (e) {
			return handleAuthz(c, e);
		}
		try {
			const connections = await ctx.stub.listExternalMcpServers();
			return c.json({ connections });
		} catch (e) {
			const msg = (e as Error).message;
			if (msg === "L4 MCP feature disabled") {
				// Read path is intentionally forgiving — see workers/index.ts:1517-1520
				return c.json({ connections: [] });
			}
			return c.json({ error: "list_failed", message: msg }, 500);
		}
	});

	return app;
}

// ── Parametric matrix ───────────────────────────────────────────────

type Op = "list" | "add" | "delete";
type Role = "owner" | "member" | "stranger" | "admin";
type Flag = "true" | "false" | "unset";

interface MatrixCase {
	flag: Flag;
	role: Role;
	connState: ConnState;
	op: Op;
	expectedStatus: number;
	expectedBodyHas?: Record<string, unknown>;
	notes?: string;
}

const MATRIX: MatrixCase[] = [
	// ── Flag=true, owner, list (read path returns the row regardless of conn state)
	{ flag: "true", role: "owner", connState: "missing", op: "list", expectedStatus: 200, expectedBodyHas: { connections: [] } },
	{ flag: "true", role: "owner", connState: "authenticating", op: "list", expectedStatus: 200 },
	{ flag: "true", role: "owner", connState: "ready", op: "list", expectedStatus: 200 },
	{ flag: "true", role: "owner", connState: "disconnected", op: "list", expectedStatus: 200 },

	// ── Flag=true, member, list (read path open to access-level)
	{ flag: "true", role: "member", connState: "missing", op: "list", expectedStatus: 200 },
	{ flag: "true", role: "member", connState: "ready", op: "list", expectedStatus: 200 },

	// ── Flag=true, admin, list
	{ flag: "true", role: "admin", connState: "ready", op: "list", expectedStatus: 200 },

	// ── Flag=true, stranger, list — denied at ACL gate
	{ flag: "true", role: "stranger", connState: "ready", op: "list", expectedStatus: 403 },

	// ── Flag=true, owner, add (creates new — connState applies post-call)
	{ flag: "true", role: "owner", connState: "authenticating", op: "add", expectedStatus: 200, expectedBodyHas: { state: "authenticating" } },
	{ flag: "true", role: "owner", connState: "ready", op: "add", expectedStatus: 200, expectedBodyHas: { state: "ready" } },

	// ── Flag=true, member, add — denied (owner-only mutation)
	{ flag: "true", role: "member", connState: "ready", op: "add", expectedStatus: 403 },

	// ── Flag=true, admin, add — admin bypasses ACL
	{ flag: "true", role: "admin", connState: "ready", op: "add", expectedStatus: 200 },

	// ── Flag=true, stranger, add — denied
	{ flag: "true", role: "stranger", connState: "ready", op: "add", expectedStatus: 403 },

	// ── Flag=true, owner, delete (idempotent across all conn states)
	{ flag: "true", role: "owner", connState: "missing", op: "delete", expectedStatus: 200, expectedBodyHas: { ok: true } },
	{ flag: "true", role: "owner", connState: "ready", op: "delete", expectedStatus: 200, expectedBodyHas: { ok: true } },
	{ flag: "true", role: "owner", connState: "disconnected", op: "delete", expectedStatus: 200 },

	// ── Flag=true, member, delete — denied
	{ flag: "true", role: "member", connState: "ready", op: "delete", expectedStatus: 403 },

	// ── Flag=true, stranger, delete — denied
	{ flag: "true", role: "stranger", connState: "ready", op: "delete", expectedStatus: 403 },

	// ── Flag=false, owner — list returns empty (forgiving read), add/delete 503
	{ flag: "false", role: "owner", connState: "ready", op: "list", expectedStatus: 200, expectedBodyHas: { connections: [] }, notes: "forgiving read" },
	{ flag: "false", role: "owner", connState: "ready", op: "add", expectedStatus: 503, expectedBodyHas: { error: "feature_disabled" } },
	{ flag: "false", role: "owner", connState: "ready", op: "delete", expectedStatus: 503, expectedBodyHas: { error: "feature_disabled" } },

	// ── Flag=false, member, list — open + forgiving even with flag off
	{ flag: "false", role: "member", connState: "ready", op: "list", expectedStatus: 200, expectedBodyHas: { connections: [] } },

	// ── Flag=false, stranger — ACL gate fires before flag check (fast-fail)
	{ flag: "false", role: "stranger", connState: "ready", op: "add", expectedStatus: 403, notes: "ACL precedes flag" },
	{ flag: "false", role: "stranger", connState: "ready", op: "list", expectedStatus: 403 },

	// ── Flag=unset (absent var) — same semantics as "false"
	{ flag: "unset", role: "owner", connState: "ready", op: "list", expectedStatus: 200, expectedBodyHas: { connections: [] } },
	{ flag: "unset", role: "owner", connState: "ready", op: "add", expectedStatus: 503 },
	{ flag: "unset", role: "owner", connState: "ready", op: "delete", expectedStatus: 503 },
	{ flag: "unset", role: "member", connState: "ready", op: "list", expectedStatus: 200 },
	{ flag: "unset", role: "stranger", connState: "ready", op: "list", expectedStatus: 403 },

	// ── Flag=true, admin can delete on any conn state
	{ flag: "true", role: "admin", connState: "missing", op: "delete", expectedStatus: 200 },
	{ flag: "true", role: "admin", connState: "authenticating", op: "delete", expectedStatus: 200 },

	// ── Flag=true, owner, list with all four conn states (full coverage row)
	{ flag: "true", role: "owner", connState: "authenticating", op: "list", expectedStatus: 200, notes: "duplicate kept for explicit row coverage" },
];

async function runOp(c: MatrixCase): Promise<{ status: number; body: unknown }> {
	const stub = makeEmailAgentStub({ flag: c.flag, connState: c.connState });
	const user = mkUser(c.role);
	const app = buildHarnessApp({ user, stub });
	const url = `http://harness/api/v1/mailboxes/mb-1/mcp-connections${
		c.op === "delete" ? "/conn-x" : ""
	}`;
	let res: Response;
	if (c.op === "list") {
		res = await app.request(url, { method: "GET" });
	} else if (c.op === "add") {
		res = await app.request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url: "https://mcp.github.com/sse",
				name: "github",
			}),
		});
	} else {
		res = await app.request(url, { method: "DELETE" });
	}
	const body = (await res.json().catch(() => ({}))) as unknown;
	return { status: res.status, body };
}

describe("MCP connection lifecycle integration matrix (L4 Phase 7)", () => {
	it.each(MATRIX)(
		"flag=$flag role=$role connState=$connState op=$op → $expectedStatus",
		async (c) => {
			// #given the parametric inputs from the matrix row
			// #when we run the operation through the harness
			const { status, body } = await runOp(c);
			// #then the HTTP status matches the expected value
			expect(status).toBe(c.expectedStatus);
			// #and the body shape (where asserted) matches
			if (c.expectedBodyHas) {
				expect(body).toMatchObject(c.expectedBodyHas);
			}
		},
	);

	it("matrix size meets plan §561-570 ≥30 cases requirement", () => {
		expect(MATRIX.length).toBeGreaterThanOrEqual(30);
	});

	it("routes Bearer add bodies to the Bearer agent RPC shape", async () => {
		const stub = makeEmailAgentStub({ flag: "true", connState: "ready" });
		const app = buildHarnessApp({ user: mkUser("owner"), stub });

		const res = await app.request(
			"http://harness/api/v1/mailboxes/mb-1/mcp-connections",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					authType: "bearer",
					url: "https://mcp.example.test/mcp",
					name: "github",
					bearerToken: "ghp_route_secret",
				}),
			},
		);

		expect(res.status).toBe(200);
		expect(stub.lastAddInput).toMatchObject({
			authType: "bearer",
			serverName: "github",
			url: "https://mcp.example.test/mcp",
			bearerToken: "ghp_route_secret",
		});
		expect(stub.lastAddInput).not.toHaveProperty("callbackHost");
	});

	it("defaults legacy add bodies to OAuth", async () => {
		const stub = makeEmailAgentStub({ flag: "true", connState: "ready" });
		const app = buildHarnessApp({ user: mkUser("owner"), stub });

		const res = await app.request(
			"http://harness/api/v1/mailboxes/mb-1/mcp-connections",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					url: "https://mcp.github.com/sse",
					name: "github",
				}),
			},
		);

		expect(res.status).toBe(200);
		expect(stub.lastAddInput).toMatchObject({
			authType: "oauth",
			callbackHost: "https://app.example.com",
		});
		expect(stub.lastAddInput).not.toHaveProperty("bearerToken");
	});

	it("rejects Bearer add bodies without a token at the Zod boundary", async () => {
		const stub = makeEmailAgentStub({ flag: "true", connState: "ready" });
		const app = buildHarnessApp({ user: mkUser("owner"), stub });

		const res = await app.request(
			"http://harness/api/v1/mailboxes/mb-1/mcp-connections",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					authType: "bearer",
					url: "https://mcp.example.test/mcp",
					name: "github",
				}),
			},
		);

		expect(res.status).toBe(400);
		expect(stub.lastAddInput).toBeNull();
	});

	it("redacts Bearer token echoes from add failure responses", async () => {
		const token = "ghp_route_secret";
		const stub = makeEmailAgentStub({
			flag: "true",
			connState: "ready",
			addErrorMessage: `upstream echoed Authorization: Bearer ${token}`,
		});
		const app = buildHarnessApp({ user: mkUser("owner"), stub });

		const res = await app.request(
			"http://harness/api/v1/mailboxes/mb-1/mcp-connections",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					authType: "bearer",
					url: "https://mcp.example.test/mcp",
					name: "github",
					bearerToken: token,
				}),
			},
		);
		const body = await res.json() as { message: string };

		expect(res.status).toBe(500);
		expect(body.message).toContain("<bearer:redacted:len=16>");
		expect(body.message).not.toContain(token);
	});

	it("maps the Bearer sub-flag guard to bearer_feature_disabled", async () => {
		const stub = makeEmailAgentStub({
			flag: "true",
			connState: "ready",
			addErrorMessage: "L4 MCP Bearer feature disabled",
		});
		const app = buildHarnessApp({ user: mkUser("owner"), stub });

		const res = await app.request(
			"http://harness/api/v1/mailboxes/mb-1/mcp-connections",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					authType: "bearer",
					url: "https://mcp.example.test/mcp",
					name: "github",
					bearerToken: "ghp_route_secret",
				}),
			},
		);
		const body = await res.json();

		expect(res.status).toBe(503);
		expect(body).toMatchObject({ error: "bearer_feature_disabled" });
	});
});
