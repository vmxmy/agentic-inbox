// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Most bindings come from the wrangler-generated `Cloudflare.Env`. The fields
// below are optional secrets / bindings that typegen omits.
// PUBLIC_BASE_URL and ADMINS keep their literal types from typegen so this
// interface still satisfies the `Cloudflare.Env` constraint required by some
// upstream generics (e.g. McpAgent).
export interface Env extends Cloudflare.Env {
	/** Cloudflare Access policy AUD; if set, Access JWTs are honored as a
	 *  fallback so existing Access-only users keep working during migration. */
	POLICY_AUD?: string;
	TEAM_DOMAIN?: string;
	/**
	 * DeepRead API key for PDF OCR fallback. Optional: if unset the
	 * PDF OCR MCP tool will return a clear error. Set via:
	 *   wrangler secret put DEEPREAD_API_KEY
	 */
	DEEPREAD_API_KEY?: string;
	/** D1 database holding users / sessions / email_tokens. */
	DB: D1Database;
	/**
	 * Bearer token for the LLM endpoint. Optional secret:
	 *   wrangler secret put LLM_API_KEY
	 *
	 * `LLM_BASE_URL` and `LLM_DEFAULT_MODEL` are declared in `wrangler.jsonc`
	 * vars and reach this interface via the typegen extension of
	 * `Cloudflare.Env`.
	 */
	LLM_API_KEY?: string;
	/**
	 * L4 (MCP Client) feature flag. Phase 6 declares the var in
	 * `wrangler.jsonc` ("false" by default; the cutover commit flips it to
	 * "true"), so the typegen-generated narrow literal on
	 * `Cloudflare.Env` is the source of truth. We do not redeclare the
	 * field here because narrowing it back to `string | undefined` would
	 * conflict with the typegen literal — `isL4McpEnabled(env)` already
	 * widens via `String(...)` so callers stay flexible.
	 */
	/**
	 * L4 P8 — Bearer auth Key Encryption Key. Base64-encoded 32 raw bytes,
	 * deployed as a wrangler secret:
	 *   wrangler secret put MCP_BEARER_KEK_CURRENT
	 * `MCP_BEARER_KEK_PREVIOUS` is set during a graceful KEK rotation so the
	 * decrypt path can fall back when a row's `kekVersion` predates the
	 * rotation. `MCP_BEARER_KEK_VERSION` stamps every freshly encrypted blob;
	 * defaults to "1" when unset.
	 *
	 * All three are optional at the type level: Phase 1 ships the helpers
	 * dormant; Phase 2-5 every external code path must guard with
	 * `isL4BearerEnabled(env)` so an unset KEK never throws at runtime.
	 */
	MCP_BEARER_KEK_CURRENT?: string;
	MCP_BEARER_KEK_PREVIOUS?: string;
	MCP_BEARER_KEK_VERSION?: string;
}
