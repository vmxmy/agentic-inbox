// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	buildBearerFetch,
	buildBearerTransport,
	connectBearerMcpServer,
	type BearerMcpManager,
} from "../workers/lib/mcp-bearer-transport";

describe("buildBearerFetch", () => {
	it("injects Authorization while preserving caller headers", async () => {
		const calls: { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }[] = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			calls.push({ input, init });
			return new Response("ok");
		};
		const bearerFetch = buildBearerFetch(
			() => "conn-1",
			() => "ghp_plaintext_token",
			fakeFetch,
		);

		await bearerFetch("https://mcp.example.test/mcp", {
			headers: { accept: "application/json" },
		});

		expect(calls).toHaveLength(1);
		const headers = new Headers(calls[0]!.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer ghp_plaintext_token");
		expect(headers.get("accept")).toBe("application/json");
	});

	it("merges Request headers with init headers", async () => {
		const calls: { init: Parameters<typeof fetch>[1] }[] = [];
		const fakeFetch: typeof fetch = async (_input, init) => {
			calls.push({ init });
			return new Response("ok");
		};
		const bearerFetch = buildBearerFetch(
			() => "conn-1",
			() => "tok",
			fakeFetch,
		);
		const request = new Request("https://mcp.example.test/mcp", {
			headers: { "x-request": "1" },
		});

		await bearerFetch(request, { headers: { "x-init": "2" } });

		const headers = new Headers(calls[0]!.init?.headers);
		expect(headers.get("x-request")).toBe("1");
		expect(headers.get("x-init")).toBe("2");
		expect(headers.get("Authorization")).toBe("Bearer tok");
	});

	it("surfaces bearer_cache_miss instead of blank-fetching", async () => {
		const fakeFetch: typeof fetch = async () => new Response("should-not-run");
		const bearerFetch = buildBearerFetch(
			() => "missing",
			() => {
				throw new Error("bearer_cache_miss");
			},
			fakeFetch,
		);

		await expect(bearerFetch("https://mcp.example.test/mcp")).rejects.toThrow(
			"bearer_cache_miss",
		);
	});
});

describe("buildBearerTransport", () => {
	it("persists only the transport type across JSON.stringify", () => {
		const bearerFetch: typeof fetch = async () => new Response("ok");
		const transport = buildBearerTransport(bearerFetch);

		expect("headers" in transport).toBe(false);
		expect(JSON.stringify(transport)).toBe('{"type":"streamable-http"}');
	});
});

describe("connectBearerMcpServer", () => {
	function makeManager(opts?: {
		connect?: Awaited<ReturnType<BearerMcpManager["connect"]>>;
		connectError?: Error;
	}) {
		const connected: Array<{
			url: string;
			options: Parameters<BearerMcpManager["connect"]>[1];
		}> = [];
		const removed: string[] = [];
		const manager: BearerMcpManager = {
			async connect(url, options) {
				if (opts?.connectError) throw opts.connectError;
				connected.push({ url, options });
				return opts?.connect ?? { id: options.reconnect.id };
			},
			async removeServer(id) {
				removed.push(id);
			},
		};
		return { manager, connected, removed };
	}

	it("uses the non-persistent SDK connect path so fetch reaches the live transport", async () => {
		const plaintext = "ghp_plaintext_token";
		const bearerFetch = buildBearerFetch(
			() => "conn-bearer",
			() => plaintext,
			async () => new Response("ok"),
		);
		const { manager, connected } = makeManager();

		const result = await connectBearerMcpServer({
			manager,
			id: "conn-bearer",
			url: "https://mcp.example.test/mcp",
			bearerFetch,
		});

		expect(result).toEqual({ id: "conn-bearer", state: "ready" });
		expect(connected).toHaveLength(1);
		expect(connected[0]!.url).toBe("https://mcp.example.test/mcp");
		expect(connected[0]!.options.reconnect.id).toBe("conn-bearer");
		expect(connected[0]!.options.transport.fetch).toBe(bearerFetch);
		expect(JSON.stringify(connected[0]!.options.transport)).not.toContain(
			plaintext,
		);
	});

	it("closes the live SDK connection when connect fails before metadata persistence", async () => {
		const { manager, removed } = makeManager({
			connectError: new Error("401 Unauthorized"),
		});

		await expect(
			connectBearerMcpServer({
				manager,
				id: "conn-fail",
				url: "https://mcp.example.test/mcp",
				bearerFetch: async () => new Response("ok"),
			}),
		).rejects.toThrow("401 Unauthorized");

		expect(removed).toEqual(["conn-fail"]);
	});

	it("treats an OAuth redirect request as a Bearer connection failure", async () => {
		const { manager, removed } = makeManager({
			connect: { id: "conn-oauth", authUrl: "https://oauth.example.test" },
		});

		await expect(
			connectBearerMcpServer({
				manager,
				id: "conn-oauth",
				url: "https://mcp.example.test/mcp",
				bearerFetch: async () => new Response("ok"),
			}),
		).rejects.toThrow(
			"Bearer MCP server unexpectedly requested OAuth authentication",
		);

		expect(removed).toEqual(["conn-oauth"]);
	});
});
