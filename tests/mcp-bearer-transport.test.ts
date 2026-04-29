// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	buildBearerFetch,
	buildBearerTransport,
	registerBearerMcpServer,
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

describe("registerBearerMcpServer", () => {
	function makeManager(opts?: {
		connect?: Awaited<ReturnType<BearerMcpManager["connectToServer"]>>;
		discovery?: Awaited<ReturnType<BearerMcpManager["discoverIfConnected"]>>;
	}) {
		const registered: Array<{
			id: string;
			options: Parameters<BearerMcpManager["registerServer"]>[1];
		}> = [];
		const removed: string[] = [];
		const manager: BearerMcpManager = {
			async registerServer(id, options) {
				registered.push({ id, options });
				return id;
			},
			async connectToServer() {
				return opts?.connect ?? { state: "connected" };
			},
			async discoverIfConnected() {
				return opts?.discovery ?? { success: true, state: "ready" };
			},
			async removeServer(id) {
				removed.push(id);
			},
		};
		return { manager, registered, removed };
	}

	it("uses the low-level SDK register path so fetch reaches the live transport but not server_options", async () => {
		const plaintext = "ghp_plaintext_token";
		const bearerFetch = buildBearerFetch(
			() => "conn-bearer",
			() => plaintext,
			async () => new Response("ok"),
		);
		const { manager, registered } = makeManager();

		const result = await registerBearerMcpServer({
			manager,
			id: "conn-bearer",
			serverName: "github",
			url: "https://mcp.example.test/mcp",
			bearerFetch,
		});

		expect(result).toEqual({ id: "conn-bearer", state: "ready" });
		expect(registered).toHaveLength(1);
		expect(registered[0]!.options.transport.fetch).toBe(bearerFetch);
		const sdkServerOptions = JSON.stringify({
			client: undefined,
			transport: registered[0]!.options.transport,
			retry: undefined,
		});
		expect(sdkServerOptions).toBe(
			'{"transport":{"type":"streamable-http"}}',
		);
		expect(sdkServerOptions).not.toContain(plaintext);
	});

	it("removes the SDK row when connect fails before metadata persistence", async () => {
		const { manager, removed } = makeManager({
			connect: { state: "failed", error: "401 Unauthorized" },
		});

		await expect(
			registerBearerMcpServer({
				manager,
				id: "conn-fail",
				serverName: "github",
				url: "https://mcp.example.test/mcp",
				bearerFetch: async () => new Response("ok"),
			}),
		).rejects.toThrow(
			"Failed to connect to MCP server at https://mcp.example.test/mcp: 401 Unauthorized",
		);

		expect(removed).toEqual(["conn-fail"]);
	});

	it("removes the SDK row when capability discovery fails", async () => {
		const { manager, removed } = makeManager({
			discovery: {
				success: false,
				state: "connected",
				error: "listTools failed",
			},
		});

		await expect(
			registerBearerMcpServer({
				manager,
				id: "conn-discovery-fail",
				serverName: "github",
				url: "https://mcp.example.test/mcp",
				bearerFetch: async () => new Response("ok"),
			}),
		).rejects.toThrow(
			"Failed to discover MCP server capabilities: listTools failed",
		);

		expect(removed).toEqual(["conn-discovery-fail"]);
	});
});
