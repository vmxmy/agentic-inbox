// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	buildBearerFetch,
	buildBearerTransport,
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
