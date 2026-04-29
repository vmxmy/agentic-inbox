// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, vi } from "vitest";
import {
	formatAuditRow,
	wrapExternalTool,
	type McpAuditRow,
} from "../workers/lib/mcp-audit";

describe("MCP audit auth_type attribution", () => {
	it("formats OAuth and Bearer rows with explicit auth_type", () => {
		const base = {
			id: "row-1",
			connId: "conn-1",
			toolName: "search",
			startedAt: 1,
			endedAt: 2,
			args: { q: "x" },
			error: null,
			flagged: false,
		};

		expect(formatAuditRow({ ...base, authType: "oauth" }).auth_type).toBe(
			"oauth",
		);
		expect(formatAuditRow({ ...base, authType: "bearer" }).auth_type).toBe(
			"bearer",
		);
	});

	it("wrapExternalTool writes Bearer auth_type and categorised errors", async () => {
		const rows: McpAuditRow[] = [];
		const token = "ghp_bearer_secret_123456";
		const wrapped = wrapExternalTool({
			tool: {
				execute: async () => {
					throw new Error(`401 Unauthorized: Bearer ${token}`);
				},
			},
			connId: "conn-bearer",
			toolName: "read_repo",
			authType: "bearer",
			appendMcpAudit: async (row) => {
				rows.push(row);
			},
			screener: vi.fn(async () => false),
			now: vi.fn(() => 1000),
			newId: vi.fn(() => "row-bearer"),
		});

		await expect(wrapped.execute!({ repo: "vmxmy/agentic-inbox" })).rejects.toThrow(
			"Unauthorized",
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "row-bearer",
			conn_id: "conn-bearer",
			tool_name: "read_repo",
			auth_type: "bearer",
			error: "unauthorized",
		});
		expect(JSON.stringify(rows[0])).not.toContain(token);
	});
});
