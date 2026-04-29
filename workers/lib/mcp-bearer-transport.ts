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

export const BEARER_PENDING_CONN_ID = "__pending__";

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
