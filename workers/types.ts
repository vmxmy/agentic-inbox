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
	// RULES_SOURCE is declared in wrangler.jsonc vars (literal "d1" today,
	// "r2" if explicitly overridden) and reaches this interface via the
	// typegen extension of `Cloudflare.Env`. Used by workers/lib/rules-store
	// to pick the active rules backend per request.
}
