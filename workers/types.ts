// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Most fields (DOMAINS, EMAIL_ADDRESSES, ADMINS, INTERNAL_SECRET, DO / R2 / AI
// bindings) come from the wrangler-generated `Cloudflare.Env`. POLICY_AUD and
// TEAM_DOMAIN are Access secrets that wrangler's typegen currently omits —
// declare them here so the Access middleware stays typed.
export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/**
	 * DeepRead API key for PDF OCR fallback. Optional: if unset the
	 * PDF OCR MCP tool will return a clear error. Set via:
	 *   wrangler secret put DEEPREAD_API_KEY
	 */
	DEEPREAD_API_KEY?: string;
}
