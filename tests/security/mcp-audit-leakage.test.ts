// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Security regression for L4 P8 Phase 5: upstream MCP errors may echo the
 * outbound Authorization header. The audit pipeline must persist only a
 * whitelist category, never any substring of the Bearer token.
 */

import { describe, it, expect, vi } from "vitest";
import { wrapExternalTool, type McpAuditRow } from "../../workers/lib/mcp-audit";

describe("MCP audit leakage guard", () => {
	it("does not persist Bearer token substrings from thrown tool errors", async () => {
		const plaintext = "ghp_secret_token_for_audit_1234567890";
		const rows: McpAuditRow[] = [];
		const wrapped = wrapExternalTool({
			tool: {
				execute: async () => {
					throw new Error(
						`upstream 401 body echoed Authorization: Bearer ${plaintext}`,
					);
				},
			},
			connId: "conn-bearer",
			toolName: "dangerous_tool",
			authType: "bearer",
			appendMcpAudit: async (row) => {
				rows.push(row);
			},
			screener: vi.fn(async () => false),
			now: vi.fn(() => 1234),
			newId: vi.fn(() => "audit-row-1"),
		});

		await expect(wrapped.execute!({ safe: true })).rejects.toThrow(plaintext);

		expect(rows).toHaveLength(1);
		const persisted = JSON.stringify(rows[0]);
		expect(rows[0]?.error).toBe("unauthorized");
		expect(rows[0]?.auth_type).toBe("bearer");
		expect(persisted).not.toContain(plaintext);
		expect(persisted).not.toContain("Authorization");
		expect(persisted).not.toContain("Bearer");
		expect(persisted).not.toContain("ghp_");
	});
});
