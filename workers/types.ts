// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Most fields (DOMAINS, EMAIL_ADDRESSES, ADMINS, DO / R2 / AI bindings) come
// from the wrangler-generated `Cloudflare.Env`. Wrangler's typegen omits
// secrets — declare them explicitly here so callers stay typed.
export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/**
	 * Shared secret for internal worker-to-worker calls (inbound email →
	 * EmailAgent / InvoiceAgent auto-trigger). Without it, the agents cannot
	 * bypass per-mailbox ACL on the system-originated path. Set via:
	 *   wrangler secret put INTERNAL_SECRET
	 */
	INTERNAL_SECRET?: string;
	/**
	 * DeepRead API key for PDF OCR fallback. Optional: if unset the
	 * PDF OCR MCP tool will return a clear error. Set via:
	 *   wrangler secret put DEEPREAD_API_KEY
	 */
	DEEPREAD_API_KEY?: string;
}
