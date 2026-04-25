// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * End-to-end orchestration for turning an inbound email into persisted invoice
 * rows. Called from both {@link receiveEmail} (fresh email) and
 * {@link MailboxDO.reprocessInvoicesForEmail} (after a parser fix).
 *
 * Invariants enforced here:
 *  1. Every invoice row points at a real R2 object (the authoritative XML).
 *  2. Every derived / downloaded file is also persisted to R2 + attachments
 *     with the correct provenance (`origin` + `parent_attachment_id`).
 *  3. No duplicate invoices: we dedupe by `invoice_number` per mailbox.
 *  4. Idempotent: re-running on the same email reuses existing derived /
 *     external-url rows instead of re-downloading or duplicating.
 */

import type { Env } from "../types";
import type { ParsedInvoice } from "./invoice-parser";
import { fetchInvoiceFile, InvoiceFetchError } from "./invoice-fetch";
import { scanInvoiceLinks, type InvoiceDownloadLink } from "./invoice-link-scanner";
import {
	extractFromUnit,
	type ChildRegistrar,
	type ExtractionUnit,
} from "./invoice-source-extractors";
import { validateParsedShape } from "./invoice-ocr";

/**
 * Minimal surface the pipeline needs from a MailboxDO. Both the worker-side
 * (via `DurableObjectStub<MailboxDO>`) and the DO itself (via a
 * `this`-bound adapter) satisfy this shape.
 */
export interface PipelineStub {
	listInvoices(filters: {
		invoiceNumber?: string;
		limit?: number;
	}): Promise<{ totalCount: number }>;
	saveInvoice(
		emailId: string,
		attachmentId: string,
		parsed: ParsedInvoice,
		opts?: { sourceKind?: "xml" | "pdf-ocr"; needsReview?: boolean },
	): Promise<string>;
	saveDerivedAttachment(
		emailId: string,
		args: {
			id: string;
			filename: string;
			mimetype: string;
			size: number;
			origin: "unpacked" | "external-url" | "manual-upload";
			parent_attachment_id?: string;
			source_url?: string;
		},
	): Promise<string>;
}

export interface EntryUnit {
	attachmentId: string;
	filename: string;
	mimetype: string;
	bytes: Uint8Array;
}

export interface ExistingAttachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	origin: string;
	source_url: string | null;
	parent_attachment_id: string | null;
}

export interface PipelineInput {
	env: Env;
	stub: PipelineStub;
	emailId: string;
	entryUnits: EntryUnit[];
	bodyHtml: string | null | undefined;
	/** All current attachment rows for this email (includes prior derived ones
	 *  when re-running). Caller queries once before invoking. */
	existingAttachments: ExistingAttachment[];
	/** Merged whitelist (defaults + mailbox extras) for body-link scanning and
	 *  outbound fetches. Required — callers must resolve via
	 *  `resolveInvoiceSourceDomains(env, mailboxId)` before invoking. */
	allowedDomains: readonly string[];
}

export interface PipelineResult {
	saved: {
		invoiceId: string;
		invoice_number: string;
		source_attachment_id: string;
		source: "email" | "unpacked" | "external-url";
	}[];
	skipped: { source: string; reason: string }[];
}

function sanitizeFilename(name: string): string {
	return (name || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

const EXT_TO_MIME: Record<string, string> = {
	xml: "application/xml",
	pdf: "application/pdf",
	ofd: "application/ofd",
	zip: "application/zip",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	txt: "text/plain",
};
function guessMimetype(filename: string): string {
	const idx = filename.lastIndexOf(".");
	if (idx < 0) return "application/octet-stream";
	const ext = filename.slice(idx + 1).toLowerCase();
	return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/** Derive a filename for a downloaded external URL. */
function filenameFromLink(link: InvoiceDownloadLink, finalUrl: string): string {
	// Prefer the final URL's path basename if it has an extension.
	try {
		const path = new URL(finalUrl).pathname;
		const base = path.split("/").filter(Boolean).pop() ?? "";
		if (base.includes(".")) return base;
	} catch {
		/* fall through */
	}
	// Fall back to `<Fphm>.<kind>` if the invoice number is in the query.
	try {
		const q = new URL(finalUrl).searchParams;
		const fphm = q.get("Fphm") || q.get("fphm") || q.get("invoiceNumber");
		if (fphm) {
			const ext = link.kind === "unknown" ? "bin" : link.kind;
			return `${fphm}.${ext}`;
		}
	} catch {
		/* fall through */
	}
	const ext = link.kind === "unknown" ? "bin" : link.kind;
	return `invoice-${Date.now()}.${ext}`;
}

export async function processEmailForInvoices(
	input: PipelineInput,
): Promise<PipelineResult> {
	const { env, stub, emailId, entryUnits, bodyHtml, existingAttachments, allowedDomains } =
		input;

	const saved: PipelineResult["saved"] = [];
	const skipped: PipelineResult["skipped"] = [];
	const seenInvoiceNumbers = new Set<string>();

	/** Check if this mailbox already has an invoice with this number. */
	const invoiceNumberExists = async (num: string): Promise<boolean> => {
		if (seenInvoiceNumbers.has(num)) return true;
		const res = await stub.listInvoices({ invoiceNumber: num, limit: 1 });
		return res.totalCount > 0;
	};

	/** Derived attachment registrar: used while walking ZIP/OFD containers. */
	const registrar: ChildRegistrar = async ({
		filename,
		bytes,
		parentAttachmentId,
	}) => {
		const sanitized = sanitizeFilename(filename);
		// Idempotent reuse: if this exact child was persisted previously under the
		// same parent, reuse the prior row + R2 object instead of duplicating.
		const prior = existingAttachments.find(
			(a) =>
				a.origin === "unpacked" &&
				a.parent_attachment_id === parentAttachmentId &&
				a.filename === sanitized,
		);
		if (prior) return prior.id;

		const attId = crypto.randomUUID();
		const mimetype = guessMimetype(sanitized);
		const r2Key = `attachments/${emailId}/${attId}/${sanitized}`;
		await env.BUCKET.put(r2Key, bytes);
		await stub.saveDerivedAttachment(emailId, {
			id: attId,
			filename: sanitized,
			mimetype,
			size: bytes.byteLength,
			origin: "unpacked",
			parent_attachment_id: parentAttachmentId,
		});
		existingAttachments.push({
			id: attId,
			filename: sanitized,
			mimetype,
			size: bytes.byteLength,
			origin: "unpacked",
			source_url: null,
			parent_attachment_id: parentAttachmentId,
		});
		return attId;
	};

	const trySave = async (
		extracted: { parsed: ParsedInvoice; authoritativeAttachmentId: string },
		sourceLabel: string,
		sourceKind: "email" | "unpacked" | "external-url",
	): Promise<void> => {
		const invoiceNumber = extracted.parsed.invoice_number;
		if (await invoiceNumberExists(invoiceNumber)) {
			seenInvoiceNumbers.add(invoiceNumber);
			skipped.push({
				source: sourceLabel,
				reason: `duplicate invoice_number=${invoiceNumber} already saved in this mailbox`,
			});
			return;
		}
		const shapeCheck = validateParsedShape(extracted.parsed);
		const needsReview = !shapeCheck.ok;
		const invoiceId = await stub.saveInvoice(
			emailId,
			extracted.authoritativeAttachmentId,
			extracted.parsed,
			{ needsReview },
		);
		seenInvoiceNumbers.add(invoiceNumber);
		saved.push({
			invoiceId,
			invoice_number: invoiceNumber,
			source_attachment_id: extracted.authoritativeAttachmentId,
			source: sourceKind,
		});
	};

	// ── 1) Walk each email-origin entry attachment ─────────────────────
	for (const entry of entryUnits) {
		const unit: ExtractionUnit = {
			attachmentId: entry.attachmentId,
			filename: entry.filename,
			mimetype: entry.mimetype,
			bytes: entry.bytes,
			origin: "email",
		};
		try {
			const result = await extractFromUnit(unit, registrar);
			if (result) {
				// authoritative attachment could be email or unpacked — infer from
				// whether the returned id matches the entry id.
				const sourceKind: "email" | "unpacked" =
					result.authoritativeAttachmentId === entry.attachmentId ? "email" : "unpacked";
				await trySave(result, entry.filename, sourceKind);
			}
		} catch (e) {
			skipped.push({
				source: entry.filename,
				reason: `extraction failed: ${(e as Error).message}`,
			});
		}
	}

	// ── 2) Scan body HTML for external download links ──────────────────
	const links = scanInvoiceLinks(bodyHtml, { domains: allowedDomains });
	for (const link of links) {
		let bytes: Uint8Array;
		let downloadedAttId: string;
		let storedFilename: string;
		let mimetype: string;

		const priorExternal = existingAttachments.find(
			(a) => a.origin === "external-url" && a.source_url === link.url,
		);

		if (priorExternal) {
			const r2Key = `attachments/${emailId}/${priorExternal.id}/${priorExternal.filename}`;
			const obj = await env.BUCKET.get(r2Key);
			if (!obj) {
				skipped.push({ source: link.url, reason: "prior external-url R2 object missing" });
				continue;
			}
			bytes = new Uint8Array(await obj.arrayBuffer());
			downloadedAttId = priorExternal.id;
			storedFilename = priorExternal.filename;
			mimetype = priorExternal.mimetype;
		} else {
			try {
				const res = await fetchInvoiceFile(link.url, { allowedDomains });
				bytes = res.bytes;
				mimetype = res.contentType.split(";", 1)[0].trim() || "application/octet-stream";
				storedFilename = sanitizeFilename(filenameFromLink(link, res.finalUrl));
				downloadedAttId = crypto.randomUUID();
				const r2Key = `attachments/${emailId}/${downloadedAttId}/${storedFilename}`;
				await env.BUCKET.put(r2Key, bytes);
				await stub.saveDerivedAttachment(emailId, {
					id: downloadedAttId,
					filename: storedFilename,
					mimetype,
					size: bytes.byteLength,
					origin: "external-url",
					source_url: res.finalUrl,
				});
				existingAttachments.push({
					id: downloadedAttId,
					filename: storedFilename,
					mimetype,
					size: bytes.byteLength,
					origin: "external-url",
					source_url: res.finalUrl,
					parent_attachment_id: null,
				});
			} catch (e) {
				const reason =
					e instanceof InvoiceFetchError
						? `${e.code}: ${e.message}`
						: (e as Error).message;
				skipped.push({ source: link.url, reason });
				continue;
			}
		}

		const unit: ExtractionUnit = {
			attachmentId: downloadedAttId,
			filename: storedFilename,
			mimetype,
			bytes,
			origin: "external-url",
		};
		try {
			const result = await extractFromUnit(unit, registrar);
			if (result) {
				const sourceKind: "external-url" | "unpacked" =
					result.authoritativeAttachmentId === downloadedAttId ? "external-url" : "unpacked";
				await trySave(result, link.url, sourceKind);
			} else if (link.kind === "xml") {
				// XML downloaded but parser couldn't find fields — surface it.
				skipped.push({
					source: link.url,
					reason: "XML downloaded but parser returned null (unknown schema?)",
				});
			}
			// For PDF/OFD-only links that yield no XML: silent, file is in R2 for audit.
		} catch (e) {
			skipped.push({
				source: link.url,
				reason: `extraction failed: ${(e as Error).message}`,
			});
		}
	}

	return { saved, skipped };
}
