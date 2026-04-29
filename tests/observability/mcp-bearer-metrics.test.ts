// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { formatAuditRow } from "../../workers/lib/mcp-audit";

describe("MCP Bearer metrics dimensions", () => {
	it("exposes auth_type as a stable audit dimension for metrics", () => {
		const row = formatAuditRow({
			id: "audit-1",
			connId: "conn-bearer",
			toolName: "fixture.search",
			authType: "bearer",
			startedAt: 100,
			endedAt: 125,
			args: { q: "hello" },
			error: null,
			flagged: false,
		});

		const metricLabels = {
			auth_type: row.auth_type,
			tool_name: row.tool_name,
			result_flagged_injection: String(row.result_flagged_injection),
		};

		expect(metricLabels).toEqual({
			auth_type: "bearer",
			tool_name: "fixture.search",
			result_flagged_injection: "0",
		});
	});
});
