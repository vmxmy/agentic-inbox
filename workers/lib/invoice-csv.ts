// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Invoice → CSV serialisation. The list-page export button and the MCP
 * export tool both route through {@link invoicesToCsv}.
 *
 * Output shape:
 *  - RFC 4180 rows, `\r\n` line terminators.
 *  - UTF-8 BOM prefix so Excel opens Chinese columns without mojibake.
 *  - Row order mirrors the API list order (issue_date desc, created_at desc).
 *  - One row per invoice — no line items. An export that includes items would
 *    require a join/repeat-header layout that's not useful as a flat sheet.
 *
 * Called from two places:
 *  1. `workers/index.ts` — `GET /api/v1/mailboxes/:id/invoices.csv`. The
 *     handler loops `listInvoices(page=N)` and feeds each page into
 *     {@link invoicesRowsToCsvBody} so nothing buffers the whole result in
 *     memory.
 *  2. MCP — not yet implemented; when added, wrap the same body helper.
 */

/**
 * The minimum invoice-row shape the CSV cares about. Matches the projection
 * the DO `listInvoices` returns + the two badge fields (`source_kind` /
 * `needs_review`) which the projection was extended to include.
 */
export interface InvoiceCsvRow {
	invoice_number: string;
	issue_date: string;
	invoice_type: string | null;
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
	email_id: string;
	created_at: string;
}

/** UTF-8 BOM (`﻿`) — tells Excel the file is UTF-8. */
export const CSV_BOM = "﻿";

/** Fixed column order — any change requires updating the UI copy too. */
export const INVOICE_CSV_COLUMNS = [
	"invoice_number",
	"issue_date",
	"invoice_type",
	"seller_name",
	"seller_tax_id",
	"buyer_name",
	"buyer_tax_id",
	"amount_excl_tax",
	"tax_amount",
	"amount_incl_tax",
	"currency",
	"source_kind",
	"needs_review",
	"email_id",
	"created_at",
] as const;

/** Header row (bare — caller prepends BOM once at the top of the stream). */
export const INVOICE_CSV_HEADER = INVOICE_CSV_COLUMNS.join(",") + "\r\n";

/** Per-row hard cap to prevent runaway exports. */
export const INVOICE_CSV_ROW_LIMIT = 10_000;

/**
 * Quote a single CSV cell per RFC 4180: wrap in `"` if the value contains
 * `,`, `"`, `\r`, or `\n`; escape inner `"` by doubling.
 */
function csvCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	let s: string;
	if (typeof value === "number") {
		s = Number.isFinite(value) ? String(value) : "";
	} else if (typeof value === "boolean") {
		s = value ? "1" : "0";
	} else {
		s = String(value);
	}
	if (/[",\r\n]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

function rowToCells(row: InvoiceCsvRow): string[] {
	// needs_review arrives as 0/1 from the DO (SQLite integer). The CSV keeps
	// it as 0/1 so downstream spreadsheet filters can match it directly.
	const needsReview =
		row.needs_review === null || row.needs_review === undefined
			? 0
			: typeof row.needs_review === "boolean"
				? row.needs_review
					? 1
					: 0
				: Number(row.needs_review);
	return [
		csvCell(row.invoice_number),
		csvCell(row.issue_date),
		csvCell(row.invoice_type),
		csvCell(row.seller_name),
		csvCell(row.seller_tax_id),
		csvCell(row.buyer_name),
		csvCell(row.buyer_tax_id),
		csvCell(row.amount_excl_tax),
		csvCell(row.tax_amount),
		csvCell(row.amount_incl_tax),
		csvCell(row.currency),
		csvCell(row.source_kind ?? "xml"),
		csvCell(needsReview),
		csvCell(row.email_id),
		csvCell(row.created_at),
	];
}

/** Serialise a batch of rows (no header, no BOM) for streaming append. */
export function invoicesRowsToCsvBody(rows: readonly InvoiceCsvRow[]): string {
	let out = "";
	for (const r of rows) {
		out += rowToCells(r).join(",") + "\r\n";
	}
	return out;
}

/** One-shot: BOM + header + all rows. Useful in tests and MCP payloads. */
export function invoicesToCsv(rows: readonly InvoiceCsvRow[]): string {
	return CSV_BOM + INVOICE_CSV_HEADER + invoicesRowsToCsvBody(rows);
}

/** Filename that Excel picks up cleanly (ASCII only). */
export function invoiceCsvFilename(nowIso: string = new Date().toISOString()): string {
	const stamp = nowIso.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
	return `invoices-${stamp}.csv`;
}
