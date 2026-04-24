// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Manual-upload fallback for invoice emails whose body only contains a
 * SPA-style short link (百望 `u.baiwang.com/...`, etc.) — there's no
 * downloadable file anywhere in the email, so the pipeline has no entry
 * unit. The user downloads the XML / OFD / PDF themselves via a browser
 * and uploads it through this flow; we persist the file with
 * `origin='manual-upload'` and run the same extraction pipeline used for
 * real attachments.
 *
 * The "字段真源必须来自真实发票文件" rule still holds: the uploaded bytes
 * sit in R2 and are what the parser reads.
 */

import { getMailboxStub } from "./email-helpers";
import type { Env } from "../types";
import {
	extractFromUnit,
	type ChildRegistrar,
	type ExtractionUnit,
} from "./invoice-source-extractors";

function sanitizeFilename(name: string): string {
	return (name || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

const EXT_TO_MIME: Record<string, string> = {
	xml: "application/xml",
	pdf: "application/pdf",
	ofd: "application/ofd",
	zip: "application/zip",
};
function guessMimetype(filename: string, fallback = "application/octet-stream"): string {
	const idx = filename.lastIndexOf(".");
	if (idx < 0) return fallback;
	const ext = filename.slice(idx + 1).toLowerCase();
	return EXT_TO_MIME[ext] ?? fallback;
}

export interface ManualUploadResult {
	attachmentId: string;
	invoiceId?: string;
	invoice_number?: string;
	reason?: string;
}

export async function uploadInvoiceFileAndExtract(
	env: Env,
	mailboxId: string,
	emailId: string,
	args: {
		filename: string;
		mimetype?: string;
		content: Uint8Array;
	},
): Promise<ManualUploadResult> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify the email exists in this mailbox.
	const email = await stub.getEmail(emailId);
	if (!email) {
		return { attachmentId: "", reason: `Email ${emailId} not found in mailbox` };
	}

	const sanitized = sanitizeFilename(args.filename);
	const mimetype = args.mimetype?.trim() || guessMimetype(sanitized);
	const attachmentId = crypto.randomUUID();
	const r2Key = `attachments/${emailId}/${attachmentId}/${sanitized}`;
	await env.BUCKET.put(r2Key, args.content);
	await stub.saveDerivedAttachment(emailId, {
		id: attachmentId,
		filename: sanitized,
		mimetype,
		size: args.content.byteLength,
		origin: "manual-upload",
	});

	// Build a registrar for container children (ZIP/OFD unpack) — same
	// pattern as the pipeline's own registrar, but scoped to this single
	// upload so we don't touch other entry units.
	const registrar: ChildRegistrar = async ({
		filename,
		bytes,
		parentAttachmentId,
	}) => {
		const childSanitized = sanitizeFilename(filename);
		const childId = crypto.randomUUID();
		const childMime = guessMimetype(childSanitized);
		const childKey = `attachments/${emailId}/${childId}/${childSanitized}`;
		await env.BUCKET.put(childKey, bytes);
		await stub.saveDerivedAttachment(emailId, {
			id: childId,
			filename: childSanitized,
			mimetype: childMime,
			size: bytes.byteLength,
			origin: "unpacked",
			parent_attachment_id: parentAttachmentId,
		});
		return childId;
	};

	const unit: ExtractionUnit = {
		attachmentId,
		filename: sanitized,
		mimetype,
		bytes: args.content,
		origin: "manual-upload",
	};

	let extracted;
	try {
		extracted = await extractFromUnit(unit, registrar);
	} catch (e) {
		return {
			attachmentId,
			reason: `Uploaded + saved to R2, but extraction failed: ${(e as Error).message}`,
		};
	}

	if (!extracted) {
		return {
			attachmentId,
			reason:
				"Uploaded + saved to R2, but parser could not find invoice fields (not a recognised XML / OFD-XBRL / XML-in-ZIP).",
		};
	}

	// Dedupe by invoice_number — consistent with pipeline semantics.
	const existing = await stub.listInvoices({
		invoiceNumber: extracted.parsed.invoice_number,
		limit: 1,
	});
	if (existing.totalCount > 0) {
		return {
			attachmentId,
			reason: `duplicate invoice_number=${extracted.parsed.invoice_number} already saved in this mailbox`,
		};
	}

	const invoiceId = await stub.saveInvoice(
		emailId,
		extracted.authoritativeAttachmentId,
		extracted.parsed,
	);
	return {
		attachmentId,
		invoiceId,
		invoice_number: extracted.parsed.invoice_number,
	};
}
