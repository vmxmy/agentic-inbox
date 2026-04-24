// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scan an email's HTML body for "invoice file download" links. Returns ranked
 * candidate links that {@link invoice-fetch.ts} can download, so the resulting
 * XML/OFD/PDF file can be stored in R2 and treated as an authoritative invoice
 * source.
 *
 * Design goals:
 *  - Stay purely declarative: no LLM, no external calls.
 *  - Hostname whitelist to prevent SSRF-ish behaviour. The whitelist lives in
 *    {@link INVOICE_SOURCE_DOMAINS}; edit there to onboard new platforms.
 *  - Prefer XML → OFD → PDF (XML is the authoritative data source, OFD is a
 *    richer container, PDF is human-readable only).
 */

export type InvoiceLinkKind = "xml" | "ofd" | "pdf" | "unknown";

export interface InvoiceDownloadLink {
	url: string;
	kind: InvoiceLinkKind;
	/** Human-readable anchor text (or nearest text node) — used for audit. */
	labelText: string;
}

/**
 * Built-in hostnames allowed for outbound invoice-file fetches. Matches either
 * an exact hostname or a suffix match against a leading-dot entry
 * (`.chinatax.gov.cn` covers `dppt.guangdong.chinatax.gov.cn`).
 *
 * These are the **defaults** — per-mailbox extras live in the settings blob
 * and are merged in by callers that have a mailboxId in scope (see
 * `resolveInvoiceSourceDomains` in `agent-config.ts`). Library functions here
 * fall back to this default list when no explicit set is passed.
 */
export const DEFAULT_INVOICE_SOURCE_DOMAINS: readonly string[] = [
	// 国家税务总局各省 e-invoice delivery endpoints
	".chinatax.gov.cn",
	// 铁路客票
	".rails.com.cn",
	".12306.cn",
	// 票通云 (vpiaotong)
	".vpiaotong.com",
	"vpiaotong.com",
	// 百旺金穗云
	".baiwangjs.com",
	"baiwangjs.com",
	".bwfapiao.com",
	"bwfapiao.com",
	// 航信诺诺网
	".nuonuo.com",
	// 高灯
	".gaodun.com",
	// 用友畅捷通
	".chanjet.com",
];

/** Per-entry validator for user-supplied extras. Hostname or leading-dot
 *  suffix, no slashes/colons/spaces/wildcards/upper-case. */
const VALID_DOMAIN_RE = /^\.?[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
export function isValidInvoiceSourceDomain(entry: unknown): entry is string {
	return typeof entry === "string" && entry.length <= 253 && VALID_DOMAIN_RE.test(entry);
}

export function isUrlAllowed(
	urlStr: string,
	domains: readonly string[] = DEFAULT_INVOICE_SOURCE_DOMAINS,
): boolean {
	let u: URL;
	try {
		u = new URL(urlStr);
	} catch {
		return false;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return false;
	const host = u.hostname.toLowerCase();
	return domains.some((d) =>
		d.startsWith(".") ? host.endsWith(d) || host === d.slice(1) : host === d,
	);
}

/**
 * Heuristic 1: pull `kind` from URL query parameters (many systems include
 * `Wjgs=XML/PDF/OFD` or `type=xml` or `format=ofd`).
 */
function kindFromUrl(urlStr: string): InvoiceLinkKind {
	let u: URL;
	try {
		u = new URL(urlStr);
	} catch {
		return "unknown";
	}
	const q = u.searchParams;
	const candidateKeys = ["Wjgs", "wjgs", "type", "format", "fileType", "filetype"];
	for (const k of candidateKeys) {
		const v = q.get(k);
		if (!v) continue;
		const lower = v.toLowerCase();
		if (lower === "xml") return "xml";
		if (lower === "ofd") return "ofd";
		if (lower === "pdf") return "pdf";
	}
	// Fallback: path extension.
	const path = u.pathname.toLowerCase();
	if (path.endsWith(".xml")) return "xml";
	if (path.endsWith(".ofd")) return "ofd";
	if (path.endsWith(".pdf")) return "pdf";
	return "unknown";
}

/**
 * Heuristic 2: infer `kind` from nearby anchor text ("点击下载XML" etc). Only
 * used when {@link kindFromUrl} is inconclusive.
 */
function kindFromLabel(label: string): InvoiceLinkKind {
	const s = label.toLowerCase();
	if (/\bxml\b/.test(s)) return "xml";
	if (/\bofd\b/.test(s)) return "ofd";
	if (/\bpdf\b/.test(s)) return "pdf";
	return "unknown";
}

/** Decode common HTML entities in anchor text (sufficient for label text). */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Strip inner tags from anchor content to get the plain label text. */
function stripInnerTags(inner: string): string {
	return decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Extract candidate invoice download links from an HTML body. Same URL (after
 * query-parameter normalisation via `URL`) appears at most once; `kind`
 * preference is XML > OFD > PDF > unknown.
 */
export function scanInvoiceLinks(
	html: string | null | undefined,
	opts: { domains?: readonly string[] } = {},
): InvoiceDownloadLink[] {
	if (!html) return [];
	const domains = opts.domains ?? DEFAULT_INVOICE_SOURCE_DOMAINS;

	// Match <a ... href="..."...> INNER </a>. Inner is non-greedy and we don't
	// care about nested anchors because HTML forbids them.
	const anchorRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

	const byUrl = new Map<string, InvoiceDownloadLink>();
	const priority: Record<InvoiceLinkKind, number> = { xml: 3, ofd: 2, pdf: 1, unknown: 0 };

	let m: RegExpExecArray | null;
	while ((m = anchorRe.exec(html)) !== null) {
		const rawHref = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
		if (!rawHref) continue;
		if (!isUrlAllowed(rawHref, domains)) continue;

		// Normalise: strip URL fragments; keep query intact (signed tokens live there).
		let normalised: string;
		try {
			const u = new URL(rawHref);
			u.hash = "";
			normalised = u.toString();
		} catch {
			continue;
		}

		const label = stripInnerTags(m[4] ?? "");
		let kind = kindFromUrl(normalised);
		if (kind === "unknown") kind = kindFromLabel(label);

		const prior = byUrl.get(normalised);
		if (!prior || priority[kind] > priority[prior.kind]) {
			byUrl.set(normalised, { url: normalised, kind, labelText: label });
		}
	}

	return [...byUrl.values()].sort((a, b) => priority[b.kind] - priority[a.kind]);
}
