// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { buildBearerTransport } from "../../workers/lib/mcp-bearer-transport";

describe("MCP Bearer observability events", () => {
	it("can serialise transport options for events without token-bearing closures", () => {
		const token = "ghp_observability_event_secret";
		const bearerFetch: typeof fetch = async () => new Response(token);
		const transport = buildBearerTransport(bearerFetch);

		const eventPayload = JSON.stringify({
			event: "mcp_connection_started",
			connId: "conn-bearer",
			authType: "bearer",
			transport,
		});

		expect(eventPayload).toContain('"authType":"bearer"');
		expect(eventPayload).toContain('"transport":{"type":"streamable-http"}');
		expect(eventPayload).not.toContain(token);
		expect(eventPayload).not.toContain("Authorization");
		expect(eventPayload).not.toContain("Bearer ");
	});
});
