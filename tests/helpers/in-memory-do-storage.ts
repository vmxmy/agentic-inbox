// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Minimal in-memory `DurableObjectStorage` shim for the Phase 7 test
 * harness. Only the four methods Cloudflare's
 * `DurableObjectOAuthClientProvider` actually exercises are
 * implemented (`get`, `put`, `delete`, `list`); anything else throws
 * so we surface accidental dependence on real DO storage features.
 *
 * Why a hand-rolled shim instead of `unstable_dev`:
 *   - vitest.config.ts uses environment: "node" (workers/lib only is
 *     under test). Booting `unstable_dev` would force the workers pool
 *     and inflate the test runtime by 10x for one suite.
 *   - The SDK provider's storage usage is documented in
 *     node_modules/agents/dist/mcp/do-oauth-client-provider.js — it
 *     only calls `storage.get(key)`, `storage.put(key, value)`,
 *     `storage.delete(key)`. Those four lines are easy to model
 *     correctly here.
 *
 * The shim returns the same value reference that was put in (no JSON
 * round-trip), matching Cloudflare's actual behavior — DO storage
 * structured-clones on the wire, but in-process tests get reference
 * identity.
 */

export interface InMemoryStorage {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	delete(key: string | string[]): Promise<boolean | number>;
	list<T = unknown>(options?: {
		prefix?: string;
	}): Promise<Map<string, T>>;
	/** Test-only inspection helper. */
	__dump(): Map<string, unknown>;
}

export function createInMemoryStorage(): InMemoryStorage {
	const map = new Map<string, unknown>();
	return {
		async get<T>(key: string): Promise<T | undefined> {
			return map.get(key) as T | undefined;
		},
		async put<T>(key: string, value: T): Promise<void> {
			map.set(key, value);
		},
		async delete(key: string | string[]): Promise<boolean | number> {
			if (Array.isArray(key)) {
				let n = 0;
				for (const k of key) if (map.delete(k)) n++;
				return n;
			}
			return map.delete(key);
		},
		async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
			const prefix = options?.prefix ?? "";
			const out = new Map<string, T>();
			for (const [k, v] of map.entries()) {
				if (k.startsWith(prefix)) out.set(k, v as T);
			}
			return out;
		},
		__dump() {
			return new Map(map);
		},
	};
}
