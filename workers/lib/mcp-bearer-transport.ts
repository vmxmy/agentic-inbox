// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Heap-only Bearer transport helpers for L4 P8 Phase 2.
 *
 * The important property: Bearer auth is injected through a `fetch` closure,
 * never through `transport.headers`. The Agents SDK persists `transport` via
 * JSON.stringify; function values are dropped there, while headers would be
 * stored as plaintext in the SDK's SQLite table.
 */

export type ResolveBearerConnId = () => string;
export type ReadBearerToken = (connId: string) => string;

export interface BearerTransportOptions {
	type: "streamable-http";
	fetch: typeof fetch;
}

export function buildBearerFetch(
	resolveConnId: ResolveBearerConnId,
	readBearerToken: ReadBearerToken,
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	const bearerFetch: typeof fetch = async (input, init) => {
		const token = readBearerToken(resolveConnId());
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		if (init?.headers) {
			new Headers(init.headers).forEach((value, key) => headers.set(key, value));
		}
		headers.set("Authorization", `Bearer ${token}`);
		return baseFetch(input, { ...init, headers });
	};
	return bearerFetch;
}

export function buildBearerTransport(
	bearerFetch: typeof fetch,
): BearerTransportOptions {
	return {
		type: "streamable-http",
		fetch: bearerFetch,
	};
}

type BearerMcpConnectionResult =
	| { state: "failed"; error: string }
	| { state: "authenticating"; authUrl: string; clientId?: string }
	| { state: "connected" };

type BearerMcpDiscoveryResult = {
	success: boolean;
	state: string;
	error?: string;
};

export interface BearerMcpManager {
	registerServer(
		id: string,
		options: {
			url: string;
			name: string;
			transport: BearerTransportOptions;
		},
	): Promise<string>;
	connectToServer(id: string): Promise<BearerMcpConnectionResult>;
	discoverIfConnected(id: string): Promise<BearerMcpDiscoveryResult | undefined>;
	removeServer(id: string): Promise<void>;
}

/**
 * Register via MCPClientManager's low-level API instead of
 * Agent.addMcpServer. The high-level helper persists safely, but it also
 * normalizes HTTP transport options down to type/headers before constructing
 * the live transport, which would drop our fetch closure too early.
 */
export async function registerBearerMcpServer(args: {
	manager: BearerMcpManager;
	id?: string;
	serverName: string;
	url: string;
	bearerFetch: typeof fetch;
	generateId?: () => string;
}): Promise<{ id: string; state: "ready" }> {
	const id = args.id ?? args.generateId?.() ?? crypto.randomUUID();
	const transport = buildBearerTransport(args.bearerFetch);
	let registered = false;
	try {
		await args.manager.registerServer(id, {
			url: args.url,
			name: args.serverName,
			transport,
		});
		registered = true;
		const result = await args.manager.connectToServer(id);
		if (result.state === "failed") {
			throw new Error(
				`Failed to connect to MCP server at ${args.url}: ${result.error}`,
			);
		}
		if (result.state === "authenticating") {
			throw new Error(
				"Bearer MCP server unexpectedly requested OAuth authentication",
			);
		}
		const discovery = await args.manager.discoverIfConnected(id);
		if (discovery && !discovery.success) {
			throw new Error(
				`Failed to discover MCP server capabilities: ${discovery.error}`,
			);
		}
		return { id, state: "ready" };
	} catch (err) {
		if (registered) {
			await args.manager.removeServer(id).catch(() => undefined);
		}
		throw err;
	}
}
