// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { decodeJwt, jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { authApp } from "./routes/auth";
import { EmailMCP } from "./mcp";
import {
	assertMailboxAccess,
	AuthzError,
	INTERNAL_USER_HEADER,
	INTERNAL_SYSTEM_HEADER,
	normalizeEmail,
	type AuthUser,
} from "./lib/auth";
import {
	buildSessionCookie,
	createSession,
	findSession,
	readSessionCookie,
} from "./lib/session";
import { ensureUser, findUserById } from "./lib/users";
import { touchApiKey, verifyApiKey } from "./lib/api-keys";
import type { Env } from "./types";

type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { InvoiceAgent } from "./invoice-agent";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

const app = new Hono<AppEnv>();

// ── Public path predicate ─────────────────────────────────────────
// These paths must be reachable without an authenticated session so the user
// can sign in / register / reset password. Static SPA assets are served by
// React Router's catch-all and are also public.
function isPublicPath(pathname: string): boolean {
	if (pathname.startsWith("/api/v1/auth/")) return true;
	if (pathname === "/api/v1/config") return true;
	if (pathname === "/login" || pathname === "/register") return true;
	if (pathname === "/forgot-password" || pathname === "/reset-password") return true;
	if (pathname === "/verify-email" || pathname === "/magic") return true;
	if (
		pathname === "/" ||
		pathname.startsWith("/assets/") ||
		pathname.startsWith("/favicon") ||
		pathname.startsWith("/__manifest")
	) return true;
	return false;
}

// ── Identity middleware ───────────────────────────────────────────
//
// Order of resolution:
//   1. Internal system header (worker-to-worker calls).
//   2. Dev override header (DEV mode only).
//   3. Bearer API key (Authorization header) — for MCP / programmatic clients.
//   4. Cookie session in D1 — for browsers.
//   5. Cloudflare Access JWT fallback (only if POLICY_AUD/TEAM_DOMAIN set):
//      verify the JWT, ensure a user record exists, mint a fresh cookie
//      session so subsequent requests skip JWT verification.
//   6. Public path → continue without user.
//   7. Otherwise → 401.
app.use("*", async (c, next) => {
	const url = new URL(c.req.url);

	// (1) Internal system call (e.g. inbound email → auto-draft agent).
	const sysHeader = c.req.header(INTERNAL_SYSTEM_HEADER);
	if (sysHeader && c.env.INTERNAL_SECRET && sysHeader === c.env.INTERNAL_SECRET) {
		c.set("user", {
			id: "__system__",
			email: "__system__",
			role: "admin",
			system: true,
		});
		return next();
	}

	// (2) Dev override.
	if (import.meta.env.DEV) {
		const devOverride = c.req.header("x-dev-user");
		const email = devOverride ? normalizeEmail(devOverride) : "dev@local.test";
		const user = await ensureUser(c.env, email, { emailVerified: true });
		c.set("user", { id: user.id, email: user.email, role: user.role });
		return next();
	}

	// (3) Bearer API key.
	const authz = c.req.header("authorization");
	if (authz && authz.toLowerCase().startsWith("bearer ")) {
		const raw = authz.slice(7).trim();
		if (raw) {
			const hit = await verifyApiKey(c.env, raw).catch(() => null);
			if (hit) {
				const user = await findUserById(c.env, hit.userId);
				if (user) {
					c.executionCtx.waitUntil(touchApiKey(c.env, hit.id));
					c.set("user", { id: user.id, email: user.email, role: user.role });
					return next();
				}
			}
		}
	}

	// (4) Cookie session.
	const sid = readSessionCookie(c);
	if (sid) {
		const session = await findSession(c.env, sid).catch(() => null);
		if (session) {
			const user = await findUserById(c.env, session.userId);
			if (user) {
				c.set("user", { id: user.id, email: user.email, role: user.role });
				return next();
			}
		}
	}

	// (5) Cloudflare Access JWT fallback (legacy compatibility).
	const accessToken = c.req.header("cf-access-jwt-assertion");
	if (accessToken && c.env.POLICY_AUD && c.env.TEAM_DOMAIN) {
		try {
			const { issuer, certsUrl } = getAccessUrls(c.env.TEAM_DOMAIN);
			const JWKS = createRemoteJWKSet(certsUrl);
			await jwtVerify(accessToken, JWKS, {
				issuer,
				audience: c.env.POLICY_AUD,
			});
			const claims = decodeJwt(accessToken) as { email?: unknown };
			const email = typeof claims.email === "string" ? normalizeEmail(claims.email) : "";
			if (email) {
				const user = await ensureUser(c.env, email, { emailVerified: true });
				const sess = await createSession(c.env, {
					userId: user.id,
					userAgent: c.req.header("user-agent") ?? null,
					ip: c.req.header("cf-connecting-ip") ?? null,
				});
				c.header("Set-Cookie", buildSessionCookie(sess.id, sess.expiresAt));
				c.set("user", { id: user.id, email: user.email, role: user.role });
				return next();
			}
		} catch {
			// fall through to public-path check / 401
		}
	}

	// (6) Public path → allow through with no user.
	if (isPublicPath(url.pathname)) return next();

	// (7) Anything else: 401 with a redirect hint for browsers.
	const acceptsHtml = (c.req.header("accept") ?? "").includes("text/html");
	if (acceptsHtml) {
		const next_url = url.pathname + url.search;
		return c.redirect(`/login?next=${encodeURIComponent(next_url)}`, 302);
	}
	return c.json({ error: "Not authenticated" }, 401);
});

// Mount the auth API. The middleware above lets these paths through unauthenticated.
app.route("/api/v1/auth", authApp);

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// We inject the authenticated user email via an internal header so the MCP DO
// can enforce per-mailbox ACL without re-parsing auth. Any client-supplied
// value of the header is stripped first so callers cannot spoof.
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
function forwardToMcp(c: import("hono").Context<AppEnv>) {
	const user = c.var.user;
	if (!user) return c.json({ error: "Not authenticated" }, 401);
	const headers = new Headers(c.req.raw.headers);
	headers.delete(INTERNAL_USER_HEADER);
	headers.set(INTERNAL_USER_HEADER, user.email);
	const req = new Request(c.req.raw, { headers });
	return mcpHandler.fetch(req, c.env, c.executionCtx as ExecutionContext);
}
app.all("/mcp", (c) => forwardToMcp(c));
app.all("/mcp/*", (c) => forwardToMcp(c));

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all.
// Enforce per-mailbox ACL before handing off to the Agents SDK.
app.all("/agents/*", async (c) => {
	const user = c.var.user;
	if (!user) return c.json({ error: "Not authenticated" }, 401);
	// URL shape: /agents/<ClassName>/<mailboxId>/...
	const url = new URL(c.req.url);
	const segments = url.pathname.split("/").filter(Boolean);
	const mailboxId = segments[2] ? decodeURIComponent(segments[2]) : undefined;
	if (mailboxId) {
		try {
			await assertMailboxAccess(c.env, mailboxId, user);
		} catch (e) {
			if (e instanceof AuthzError) return c.text(e.message, e.status);
			throw e;
		}
	}
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
