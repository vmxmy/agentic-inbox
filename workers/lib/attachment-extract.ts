// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Attachment text extraction for rule actions.
 *
 * Phase 1 (this file): synchronous XML extraction — handles Chinese 全电发票
 * and any other text-embedded XML delivered as an email attachment. Zero
 * external deps.
 *
 * Phase 2 (planned): PDF OCR via DeepRead async webhook — see FOLLOWUP below.
 */

/** Get the lowercase file extension (no leading dot). Empty string if none. */
export function extensionOf(filename: string | undefined | null): string {
	if (!filename) return "";
	const lower = filename.toLowerCase();
	const idx = lower.lastIndexOf(".");
	if (idx < 0 || idx === lower.length - 1) return "";
	return lower.slice(idx + 1);
}

/**
 * Best-effort decode bytes to text. Tries UTF-8 first (most invoices), falls
 * back to GBK for older mainland-China XML payloads. Returns "" on failure.
 */
function decodeBytes(bytes: ArrayBuffer | Uint8Array): string {
	const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	try {
		const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
		// crude sanity check: utf-8 replacement chars shouldn't dominate
		const replacementCount = (utf8.match(/�/g) || []).length;
		if (replacementCount * 20 < utf8.length) return utf8;
	} catch { /* fall through */ }
	try {
		return new TextDecoder("gbk", { fatal: false }).decode(buf);
	} catch {
		return "";
	}
}

/**
 * Extract a compact, LLM-friendly text summary from an XML attachment.
 * Strategy: keep tag names as labels, inline their text content, collapse
 * whitespace. Skips empty elements and XML declarations.
 *
 * Truncates output to `maxChars` (default 15000) to keep prompt costs sane —
 * Chinese 全电发票 XML is ~3-10 KB so this is plenty.
 */
export function extractXmlText(
	bytes: ArrayBuffer | Uint8Array,
	opts: { maxChars?: number } = {},
): string {
	const maxChars = opts.maxChars ?? 15000;
	const raw = decodeBytes(bytes);
	if (!raw) return "";

	// Strip XML/HTML comments + processing instructions + DOCTYPE.
	let s = raw
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\?[^?]*\?>/g, " ")
		.replace(/<!DOCTYPE[^>]*>/gi, " ")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

	// Very small tokeniser: for each element, emit "tagName: text". Nested
	// elements each get their own label, which preserves field structure
	// without needing a real XML parser.
	const out: string[] = [];
	const tagRe = /<\/?([A-Za-z_][\w.:-]*)[^>]*>/g;
	let lastIdx = 0;
	let currentTag: string | null = null;
	let textBuf = "";
	const flush = () => {
		const clean = textBuf.replace(/\s+/g, " ").trim();
		if (currentTag && clean) out.push(`${currentTag}: ${clean}`);
		textBuf = "";
	};
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(s)) !== null) {
		const between = s.slice(lastIdx, m.index);
		textBuf += between;
		flush();
		// Opening tag name becomes the label for the following text node.
		if (!m[0].startsWith("</")) {
			currentTag = m[1];
		} else {
			currentTag = null;
		}
		lastIdx = m.index + m[0].length;
	}
	textBuf += s.slice(lastIdx);
	flush();

	// Deduplicate runs of identical labels (e.g. empty-wrapper tags).
	const squashed = out.filter((line, i) => line !== out[i - 1]);
	const joined = squashed.join("\n");
	return joined.length > maxChars ? joined.slice(0, maxChars) + "\n…[truncated]" : joined;
}

export interface AttachmentForExtraction {
	filename: string;
	mimetype?: string;
	content: ArrayBuffer | Uint8Array | string;
}

/** Returns true if the attachment looks like an XML file we can parse. */
export function looksLikeXml(att: { filename: string; mimetype?: string }): boolean {
	const ext = extensionOf(att.filename);
	if (ext === "xml") return true;
	const mt = (att.mimetype || "").toLowerCase();
	return mt.includes("/xml") || mt.endsWith("+xml");
}

/**
 * Walk attachments and produce an LLM-ready context block summarising every
 * extractable text attachment. Returns "" if none.
 *
 * Only handles XML synchronously for now. PDF (and other binary formats)
 * need async processing and are intentionally skipped — see FOLLOWUP.
 */
export function extractAttachmentsInline(
	atts: AttachmentForExtraction[],
	opts: { filterExts?: string[] } = {},
): { text: string; handledExts: string[]; skippedPdf: string[] } {
	const allowExt = opts.filterExts?.map((e) => e.toLowerCase().replace(/^\./, ""));
	const blocks: string[] = [];
	const handledExts = new Set<string>();
	const skippedPdf: string[] = [];

	for (const att of atts) {
		const ext = extensionOf(att.filename);
		if (allowExt && !allowExt.includes(ext)) continue;

		if (looksLikeXml(att)) {
			const bytes = typeof att.content === "string"
				? new TextEncoder().encode(att.content)
				: att.content;
			const text = extractXmlText(bytes);
			if (text) {
				blocks.push(`## Attachment "${att.filename}" (XML, parsed)\n${text}`);
				handledExts.add("xml");
			}
			continue;
		}

		if (ext === "pdf" || (att.mimetype || "").toLowerCase() === "application/pdf") {
			// FOLLOWUP: submit to DeepRead OCR, handle via webhook. Deferred.
			skippedPdf.push(att.filename);
			continue;
		}
		// Other formats: silently skip for now.
	}

	return {
		text: blocks.join("\n\n"),
		handledExts: Array.from(handledExts),
		skippedPdf,
	};
}
