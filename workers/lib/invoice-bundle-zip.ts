// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reimbursement-bundle ZIP packer.
 *
 * For each invoice in the bundle we pull the authoritative original file from
 * R2 (the row pointed to by `invoice.attachment_id`) and stuff it into the
 * ZIP under `invoices/`. A `manifest.csv` at the ZIP root mirrors the same
 * column order the standalone CSV export uses (plus an `is_voided` column).
 *
 * The DO RPC already refuses to add voided / red-credit invoices to a bundle,
 * but we double-filter here as a defensive guard against drift if a bundle
 * was assembled before that rule landed.
 */

import { zipSync } from "fflate";
import {
	CSV_BOM,
	INVOICE_CSV_HEADER,
	invoicesRowsToCsvBody,
	type InvoiceCsvRow,
} from "./invoice-csv";
import type { Env } from "../types";

export interface BundleHeaderForZip {
	id: string;
	name: string;
	note: string | null;
	status: string;
	created_at: string;
}

/**
 * Minimum invoice shape the packer needs. Mirrors the row returned by the DO's
 * `getBundle` projection — invoice header fields + is_voided so we can skip
 * defensively.
 */
export interface InvoiceForZip {
	id: string;
	email_id: string;
	attachment_id: string;
	invoice_number: string;
	invoice_code: string | null;
	invoice_type: string | null;
	issue_date: string;
	seller_name: string | null;
	seller_tax_id: string | null;
	buyer_name: string | null;
	buyer_tax_id: string | null;
	amount_excl_tax: number | null;
	tax_amount: number | null;
	amount_incl_tax: number | null;
	currency: string | null;
	source_kind?: string | null;
	needs_review?: number | boolean | null;
	is_voided?: number | boolean | null;
	created_at: string;
}

/** Full path under which the authoritative invoice file lives in R2. */
function r2KeyForAttachment(emailId: string, attachmentId: string, filename: string): string {
	return `attachments/${emailId}/${attachmentId}/${filename}`;
}

/**
 * Strip control characters / path separators from a filename so the ZIP
 * entry name is safe for desktop unzippers across platforms. ZIP itself
 * has no special chars, but Windows Explorer rejects `:*?"<>|`.
 */
function safeZipName(name: string): string {
	return name.replace(/[\x00-\x1f\\/:*?"<>|]/g, "_") || "untitled";
}

interface DOAttachmentLike {
	id: string;
	filename: string;
}

/**
 * Look up an attachment row to get its filename, since the DO bundle
 * projection only carries `attachment_id`. Falls back to `<id>.bin` if
 * the attachment row was orphaned (shouldn't happen but is recoverable).
 */
async function loadAttachmentFilename(
	env: Env,
	mailboxId: string,
	attachmentId: string,
): Promise<string | null> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const att = (await (stub as unknown as {
		findAttachmentById: (id: string) => Promise<DOAttachmentLike | null>;
	}).findAttachmentById(attachmentId));
	return att?.filename ?? null;
}

/** UTC ISO timestamp safe to embed in a filename. */
function tsForFilename(): string {
	return new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\..*$/, "")
		.replace("T", "-");
}

/**
 * Build a download filename for the bundle ZIP. Falls back to "bundle" when
 * the user's chosen name has no ASCII-safe content.
 */
export function bundleZipFilename(bundle: { name: string; id: string }): string {
	const slug = bundle.name
		.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
		.replace(/\s+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	const base = slug || `bundle-${bundle.id.slice(0, 8)}`;
	return `${base}-${tsForFilename()}.zip`;
}

/** CSV column order: same as the public invoice export, with `is_voided` appended. */
const BUNDLE_CSV_HEADER = INVOICE_CSV_HEADER.replace("\r\n", ",is_voided\r\n");

function rowsForCsv(invoices: readonly InvoiceForZip[]): InvoiceCsvRow[] {
	return invoices.map((inv) => ({
		invoice_number: inv.invoice_number,
		issue_date: inv.issue_date,
		invoice_type: inv.invoice_type,
		seller_name: inv.seller_name,
		seller_tax_id: inv.seller_tax_id,
		buyer_name: inv.buyer_name,
		buyer_tax_id: inv.buyer_tax_id,
		amount_excl_tax: inv.amount_excl_tax,
		tax_amount: inv.tax_amount,
		amount_incl_tax: inv.amount_incl_tax,
		currency: inv.currency,
		source_kind: inv.source_kind ?? null,
		needs_review: inv.needs_review ?? null,
		email_id: inv.email_id,
		created_at: inv.created_at,
	}));
}

/**
 * Build a bundle ZIP in-memory. Skips any invoice rows whose `is_voided`
 * is truthy — the DO normally rejects them at add time, but we re-check
 * so a legacy bundle never produces a packet that includes voided receipts.
 *
 * Uses `zipSync` rather than streaming because typical bundles are tens
 * of MB at most (R2 caps individual files at 5MB through this app's
 * pipeline; a bundle of 50 invoices is well under Worker memory).
 */
export async function streamBundleZip(args: {
	env: Env;
	mailboxId: string;
	bundle: BundleHeaderForZip;
	invoices: readonly InvoiceForZip[];
}): Promise<Uint8Array> {
	const { env, mailboxId, bundle, invoices } = args;
	const usable = invoices.filter((inv) => !inv.is_voided);

	const csvBody =
		CSV_BOM + BUNDLE_CSV_HEADER + buildCsvBodyWithVoided(usable);
	const encoder = new TextEncoder();

	const files: Record<string, Uint8Array> = {
		"manifest.csv": encoder.encode(csvBody),
	};

	const usedNames = new Map<string, number>();

	for (const inv of usable) {
		const filename =
			(await loadAttachmentFilename(env, mailboxId, inv.attachment_id)) ??
			`${inv.attachment_id}.bin`;
		const r2Key = r2KeyForAttachment(inv.email_id, inv.attachment_id, filename);
		const obj = await env.BUCKET.get(r2Key);
		if (!obj) {
			// Skip-but-record: the manifest already names the invoice; missing
			// files would otherwise abort the entire ZIP. We append a README
			// at the end with the missing list.
			files[`__missing__/${safeZipName(inv.invoice_number)}.txt`] = encoder.encode(
				`R2 object missing for invoice ${inv.invoice_number} at ${r2Key}\n`,
			);
			continue;
		}
		const bytes = new Uint8Array(await obj.arrayBuffer());

		// De-duplicate within `invoices/` — original filenames clash often
		// (everyone names their invoice file `invoice.pdf`). On collision,
		// prefix with the invoice number.
		const safe = safeZipName(filename);
		let entry = `invoices/${safe}`;
		const seen = usedNames.get(entry);
		if (seen != null) {
			entry = `invoices/${safeZipName(inv.invoice_number)}__${safe}`;
		}
		// If even the prefixed name is taken, append a counter.
		let collisionN = 0;
		while (files[entry]) {
			collisionN += 1;
			entry = `invoices/${safeZipName(inv.invoice_number)}__${collisionN}__${safe}`;
		}
		files[entry] = bytes;
		usedNames.set(`invoices/${safe}`, (seen ?? 0) + 1);
	}

	if (bundle.note) {
		files["README.txt"] = encoder.encode(
			`Bundle: ${bundle.name}\nStatus: ${bundle.status}\nCreated: ${bundle.created_at}\n\n${bundle.note}\n`,
		);
	}

	return zipSync(files, { level: 6 });
}

/** Manifest CSV body: standard rows plus a trailing is_voided column (always 0 here). */
function buildCsvBodyWithVoided(invoices: readonly InvoiceForZip[]): string {
	const baseRows = rowsForCsv(invoices);
	const baseBody = invoicesRowsToCsvBody(baseRows);
	if (!baseBody) return "";
	// Append ",0" before each `\r\n`. All rows in `usable` are non-voided; the
	// column exists for downstream tooling that expects the field to be present.
	return baseBody.replace(/\r\n/g, ",0\r\n");
}
