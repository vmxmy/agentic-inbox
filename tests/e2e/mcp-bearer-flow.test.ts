// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Node-side E2E simulation for the L4 P8 Bearer lane. The repo's default
 * vitest environment does not boot Worker Durable Objects, so this stitches
 * together the production pure helpers that sit on the add -> wire -> audit
 * path and uses an in-memory connection registry as the DO metadata stand-in.
 */

import { describe, it, expect, vi } from "vitest";
import { buildBearerFetch } from "../../workers/lib/mcp-bearer-transport";
import {
	buildConnectionFromSdkResult,
	mcpConnectionToRow,
	rowToMcpConnection,
	toPublicMcpConnection,
} from "../../workers/lib/mcp-connections";
import {
	decryptBearerToken,
	encryptBearerToken,
} from "../../workers/lib/mcp-token-crypto";
import { wrapExternalTool, type McpAuditRow } from "../../workers/lib/mcp-audit";

function kekB64(): string {
	const bytes = Array.from({ length: 32 }, (_, i) => i + 1);
	return btoa(String.fromCharCode(...bytes));
}

describe("MCP Bearer E2E flow (Phase 6)", () => {
	it("walks add -> tool wire auth -> audit -> delete without persisting plaintext", async () => {
		const token = "ghp_e2e_fixture_token_123456";
		const env = { MCP_BEARER_KEK_CURRENT: kekB64() };
		const encryptedBlob = await encryptBearerToken(env, token);
		const decrypted = await decryptBearerToken(env, encryptedBlob);

		const connection = buildConnectionFromSdkResult({
			serverName: "fixture",
			serverUrl: "https://mcp.example.test/mcp",
			displayName: "Fixture MCP",
			addedByUserId: "user-1",
			addedAt: 1714389600000,
			sdk: { id: "conn-bearer", state: "ready" },
			authType: "bearer",
			encryptedBlob,
			transportType: "streamable-http",
		});
		const registry = new Map([[connection.id, connection]]);

		expect(decrypted).toBe(token);
		expect(connection.authType).toBe("bearer");
		const storedConnection = rowToMcpConnection(mcpConnectionToRow(connection));
		expect(toPublicMcpConnection(storedConnection)).not.toHaveProperty(
			"encryptedTokenB64",
		);
		expect(JSON.stringify(mcpConnectionToRow(connection))).not.toContain(token);

		const wireHeaders: Headers[] = [];
		const bearerFetch = buildBearerFetch(
			() => connection.id,
			(connId) => {
				const row = registry.get(connId);
				if (!row) throw new Error("connection_missing");
				return decrypted;
			},
			async (_input, init) => {
				wireHeaders.push(new Headers(init?.headers));
				return Response.json({ tools: ["fixture.echo"] });
			},
		);

		const toolList = await bearerFetch("https://mcp.example.test/mcp");
		expect(await toolList.json()).toEqual({ tools: ["fixture.echo"] });
		expect(wireHeaders[0]?.get("Authorization")).toBe(`Bearer ${token}`);

		const auditRows: McpAuditRow[] = [];
		const wrappedTool = wrapExternalTool({
			tool: {
				execute: async (input) => ({ echoed: input }),
			},
			connId: connection.id,
			toolName: "fixture.echo",
			authType: connection.authType,
			appendMcpAudit: async (row) => {
				auditRows.push(row);
			},
			screener: vi.fn(async () => false),
			now: vi.fn(() => 1714389600100),
			newId: vi.fn(() => "audit-1"),
		});

		await expect(wrappedTool.execute!({ message: "hello" })).resolves.toBe(
			JSON.stringify({ echoed: { message: "hello" } }),
		);
		expect(auditRows).toHaveLength(1);
		expect(auditRows[0]).toMatchObject({
			conn_id: connection.id,
			tool_name: "fixture.echo",
			auth_type: "bearer",
			error: null,
		});
		expect(JSON.stringify(auditRows[0])).not.toContain(token);

		registry.delete(connection.id);
		expect(registry.has(connection.id)).toBe(false);
	});
});
