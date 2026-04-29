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

export interface BearerMcpManager {
	connect(
		url: string,
		options: {
			reconnect: { id: string };
			transport: BearerTransportOptions;
		},
	): Promise<{ id: string; authUrl?: string; clientId?: string }>;
	removeServer(id: string): Promise<void>;
}

/**
 * Connect via MCPClientManager's non-persistent low-level API instead of
 * Agent.addMcpServer. The high-level helper normalizes HTTP transport options
 * down to type/headers before constructing the live transport, which would
 * drop our fetch closure too early. `connect()` keeps the connection live in
 * memory without writing an SDK server row that would later auto-restore
 * without the non-serializable fetch closure.
 */
export async function connectBearerMcpServer(args: {
	manager: BearerMcpManager;
	id?: string;
	url: string;
	bearerFetch: typeof fetch;
	generateId?: () => string;
}): Promise<{ id: string; state: "ready" }> {
	const id = args.id ?? args.generateId?.() ?? crypto.randomUUID();
	const transport = buildBearerTransport(args.bearerFetch);
	try {
		const result = await args.manager.connect(args.url, {
			reconnect: { id },
			transport,
		});
		if (result.authUrl) {
			throw new Error(
				"Bearer MCP server unexpectedly requested OAuth authentication",
			);
		}
		return { id, state: "ready" };
	} catch (err) {
		await args.manager.removeServer(id).catch(() => undefined);
		throw err;
	}
}
