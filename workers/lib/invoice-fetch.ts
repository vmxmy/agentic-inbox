// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Download an invoice file from an external URL, subject to strict guards:
 *
 *  - Hostname must match the supplied whitelist (defaults to the built-in
 *    list; pipeline callers pass the mailbox-merged list; anti-SSRF).
 *  - Timeout (default 10s).
 *  - Max response size (default 5MB).
 *  - Content-Type whitelist (XML / OFD / PDF / generic octet-stream).
 *  - Redirects followed manually (max 3 hops), each hop re-validated against
 *    the hostname whitelist so a redirect can't jump off-whitelist.
 *
 * Returns decoded bytes + the final URL (after redirects) + declared
 * Content-Type. Throws {@link InvoiceFetchError} on any guard failure.
 */

import { DEFAULT_INVOICE_SOURCE_DOMAINS, isUrlAllowed } from "./invoice-link-scanner";

export interface FetchResult {
	bytes: Uint8Array;
	contentType: string;
	finalUrl: string;
}

export class InvoiceFetchError extends Error {
	constructor(
		public readonly code:
			| "not-allowed"
			| "timeout"
			| "too-large"
			| "bad-content-type"
			| "too-many-redirects"
			| "http-error"
			| "network",
		message: string,
		public readonly statusCode?: number,
	) {
		super(message);
		this.name = "InvoiceFetchError";
	}
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const ALLOWED_CONTENT_TYPE_PREFIXES = [
	"application/xml",
	"text/xml",
	"application/pdf",
	"application/ofd",
	// Many government endpoints mislabel everything as octet-stream; accepted
	// because we verify the actual format downstream via magic bytes + parser.
	"application/octet-stream",
	// Some endpoints return binary ZIP of invoices.
	"application/zip",
	"application/x-zip-compressed",
];

function isAllowedContentType(ct: string): boolean {
	const lower = ct.toLowerCase().split(";", 1)[0].trim();
	return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => lower === prefix);
}

export interface FetchOptions {
	timeoutMs?: number;
	maxBytes?: number;
	/** Effective hostname whitelist — defaults to the built-in list. Pipeline
	 *  callers pass the mailbox-merged list so per-mailbox extras apply. */
	allowedDomains?: readonly string[];
}

export async function fetchInvoiceFile(
	url: string,
	opts: FetchOptions = {},
): Promise<FetchResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const allowedDomains = opts.allowedDomains ?? DEFAULT_INVOICE_SOURCE_DOMAINS;

	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!isUrlAllowed(currentUrl, allowedDomains)) {
			throw new InvoiceFetchError(
				"not-allowed",
				`URL host not in invoice-source whitelist: ${currentUrl}`,
			);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		let res: Response;
		try {
			res = await fetch(currentUrl, {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
				headers: {
					// Some endpoints 403 without a UA. Use a neutral one.
					"User-Agent": "agentic-inbox-invoice-fetch/1.0",
					"Accept": "application/xml, application/pdf, application/ofd, */*",
				},
			});
		} catch (e) {
			clearTimeout(timer);
			const err = e as { name?: string; message?: string };
			if (err.name === "AbortError") {
				throw new InvoiceFetchError("timeout", `Timed out after ${timeoutMs}ms: ${currentUrl}`);
			}
			throw new InvoiceFetchError("network", `Network error: ${err.message ?? String(e)}`);
		}
		clearTimeout(timer);

		// Handle redirects manually so we can re-validate the destination.
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("Location");
			if (!loc) {
				throw new InvoiceFetchError(
					"http-error",
					`Redirect without Location header (${res.status})`,
					res.status,
				);
			}
			currentUrl = new URL(loc, currentUrl).toString();
			if (hop === MAX_REDIRECTS) {
				throw new InvoiceFetchError(
					"too-many-redirects",
					`Exceeded ${MAX_REDIRECTS} redirects chasing ${url}`,
				);
			}
			continue;
		}

		if (!res.ok) {
			throw new InvoiceFetchError(
				"http-error",
				`HTTP ${res.status} for ${currentUrl}`,
				res.status,
			);
		}

		const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
		if (!isAllowedContentType(contentType)) {
			throw new InvoiceFetchError(
				"bad-content-type",
				`Content-Type not allowed: ${contentType}`,
			);
		}

		// Content-Length is advisory only — stream and enforce.
		const declaredLen = Number(res.headers.get("Content-Length"));
		if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
			throw new InvoiceFetchError(
				"too-large",
				`Declared Content-Length ${declaredLen} exceeds ${maxBytes} byte cap`,
			);
		}

		if (!res.body) {
			throw new InvoiceFetchError("network", "Response has no body");
		}

		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				reader.cancel().catch(() => {});
				throw new InvoiceFetchError(
					"too-large",
					`Response exceeded ${maxBytes} bytes`,
				);
			}
			chunks.push(value);
		}

		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			bytes.set(c, offset);
			offset += c.byteLength;
		}

		return { bytes, contentType, finalUrl: currentUrl };
	}

	// Unreachable — loop always returns or throws.
	throw new InvoiceFetchError("too-many-redirects", `Redirect loop for ${url}`);
}
