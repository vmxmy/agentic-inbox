// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * L4 Phase 7 — MCP transport-type probe.
 *
 * Plan §573 ("transport probe") asks: when the user adds an external
 * MCP server, does the SDK negotiate the right transport (HTTP+SSE
 * vs. streamable-http)?
 *
 * We can't reach the network from this CI runner — outbound traffic
 * to mcp.deepwiki.com is gated by repo policy. So this suite validates
 * the **transport-type contract surface** the metadata layer exposes
 * (the `transport_type` column + the `MCP_TRANSPORT_TYPES` enum) and
 * leaves the real-network probe as `it.skip` ready for staging.
 *
 * What this suite proves:
 *   ✔ Both transport tokens the SDK can produce ("sse",
 *     "streamable-http") round-trip through the metadata layer.
 *   ✔ `isMcpTransportType` rejects unknown / future transports
 *     (defensive against an SDK upgrade that adds a transport without
 *     widening our enum).
 *   ✘ Real negotiation against a hosted server — see "Skipped tests
 *     requiring staging" in the PR description.
 */

import { describe, it, expect } from "vitest";
import {
	buildBearerFetch,
	buildBearerTransport,
} from "../../workers/lib/mcp-bearer-transport";
import {
	MCP_TRANSPORT_TYPES,
	isMcpTransportType,
	mcpConnectionToRow,
	rowToMcpConnection,
	type McpConnectionInput,
} from "../../workers/lib/mcp-connections";

describe("MCP transport probe (Phase 7)", () => {
	function connectionInput(
		overrides: Partial<McpConnectionInput>,
	): McpConnectionInput {
		return {
			id: "conn-1",
			serverName: "test",
			displayName: null,
			serverUrl: "https://mcp.example.com/endpoint",
			transportType: null,
			addedByUserId: "u-1",
			addedAt: 1700000000000,
			lastState: "ready",
			enabledTools: null,
			authType: "oauth",
			encryptedTokenB64: null,
			tokenIvB64: null,
			tokenSaltB64: null,
			tokenEnvelopeVersion: null,
			tokenKekVersion: null,
			...overrides,
		};
	}

	describe("transport-type enum surface", () => {
		it("includes both Cloudflare addMcpServer overloads", () => {
			// #given the closed set of transports the metadata layer recognises
			// #then it exactly matches the SDK's supported list
			expect([...MCP_TRANSPORT_TYPES].sort()).toEqual(
				["sse", "streamable-http"].sort(),
			);
		});

		it.each(MCP_TRANSPORT_TYPES)(
			"%s round-trips through mcpConnectionToRow / rowToMcpConnection",
			(transport) => {
				// #given a metadata input carrying the candidate transport
				const input = connectionInput({
					transportType: transport,
				});
				// #when serialised then deserialised
				const back = rowToMcpConnection(mcpConnectionToRow(input));
				// #then the transport survives intact (NOT collapsed to null)
				expect(back.transportType).toBe(transport);
			},
		);

		it("rejects unknown transport tokens (forward-compat guard)", () => {
			// #given a transport string the SDK does not yet emit
			// #then the type narrower refuses to widen unsafely
			expect(isMcpTransportType("ws")).toBe(false);
			expect(isMcpTransportType("websocket")).toBe(false);
			expect(isMcpTransportType("http")).toBe(false);
			expect(isMcpTransportType("STREAMABLE-HTTP")).toBe(false); // case-sensitive
		});

		it("treats null transport as 'unknown / not yet probed'", () => {
			// #given a fresh row where the SDK didn't surface a transport hint
			const input = connectionInput({
				transportType: null,
				addedAt: 0,
				lastState: "authenticating",
			});
			const back = rowToMcpConnection(mcpConnectionToRow(input));
			expect(back.transportType).toBeNull();
		});
	});

	describe("Bearer transport cutover", () => {
		it("injects Authorization on the wire while JSON persistence drops the fetch closure", async () => {
			const token = "ghp_transport_probe_token";
			const calls: Parameters<typeof fetch>[1][] = [];
			const fakeFetch: typeof fetch = async (_input, init) => {
				calls.push(init);
				return new Response("ok");
			};
			const bearerFetch = buildBearerFetch(
				() => "conn-bearer",
				() => token,
				fakeFetch,
			);
			const transport = buildBearerTransport(bearerFetch);

			await transport.fetch("https://mcp.example.test/mcp", {
				headers: { accept: "application/json" },
			});

			expect(calls).toHaveLength(1);
			const headers = new Headers(calls[0]?.headers);
			expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
			expect(headers.get("accept")).toBe("application/json");
			expect(JSON.stringify(transport)).toBe('{"type":"streamable-http"}');
			expect(JSON.stringify(transport)).not.toContain(token);
		});
	});

	describe("real-network probe (deferred to staging)", () => {
		it.skip("negotiates SSE transport against mcp.deepwiki.com", () => {
			// REASON: outbound network is gated by repo policy. The plan defers
			// real-network E2E to staging (§573). The negotiation logic itself
			// is owned by the Cloudflare `agents` SDK — a staged run on the
			// hosted env will exercise it via the existing `addExternalMcpServer`
			// → MCPClientManager pipeline. No production code change is
			// required here when the .skip is removed; the staging worker
			// instance will need outbound access + an `MCP_E2E_TEST_TARGET`
			// env var set to a hosted MCP endpoint.
		});

		it.skip("negotiates streamable-http transport against an HTTP-only server", () => {
			// REASON: same as above — needs network + a known streamable-http
			// test target. Skeleton kept so the staging pass can drop the .skip
			// without re-architecting.
		});
	});
});
