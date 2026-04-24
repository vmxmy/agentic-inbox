// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Chinese-invoice JSON Schema for DeepRead + a mapper from DeepRead's
 * response envelope back into our {@link ParsedInvoice} shape.
 *
 * OCR is the last-resort source: when a PDF comes in alone (no XML, no OFD
 * with XBRL XML), we ask DeepRead to read the PDF and return the typical
 * 数电票 / 增值税发票 fields. Any field flagged `hil_flag=true` by DeepRead
 * sets `needs_review=true` on the stored invoice so the user knows the
 * field cost a tool-human judgement.
 *
 * The raw DeepRead response (serialised JSON) is stored in `ParsedInvoice.
 * raw_xml` for audit — we reuse that column rather than adding another
 * because the semantic is the same: "here's the authoritative blob the
 * fields came from". `source_kind='pdf-ocr'` on the invoice row tells the
 * consumer it's OCR rather than XML.
 */

import type { ParsedInvoice, ParsedInvoiceItem } from "./invoice-parser";
import type { OcrFieldMeta, OcrJobResult } from "./deepread";

/**
 * JSON Schema passed to DeepRead. Field names mirror our ParsedInvoice
 * shape so the mapper stays trivial. Descriptions are in Chinese to match
 * the document language — DeepRead uses them as extraction hints.
 */
export const CHINA_INVOICE_OCR_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		invoice_number: {
			type: "string",
			description:
				"发票号码（通常是 20 位数字的数电票号码或 8 位增值税发票号）。出现在票面顶部 '发票号码' 或 '数电票号码' 字段旁边。",
		},
		invoice_code: {
			type: ["string", "null"],
			description: "发票代码（老式增值税发票才有，数电票可能为空）。",
		},
		invoice_type: {
			type: ["string", "null"],
			description:
				"发票类型，例如 '电子发票（普通发票）', '电子发票（增值税专用发票）', '电子发票（铁路电子客票）' 等。",
		},
		issue_date: {
			type: "string",
			description: "开票日期，返回 YYYY-MM-DD 格式。",
		},
		seller_name: {
			type: ["string", "null"],
			description: "销售方名称（开票方、出票方）。",
		},
		seller_tax_id: {
			type: ["string", "null"],
			description: "销售方统一社会信用代码 / 纳税人识别号。",
		},
		buyer_name: {
			type: ["string", "null"],
			description: "购买方名称（受票方、抬头）。",
		},
		buyer_tax_id: {
			type: ["string", "null"],
			description: "购买方统一社会信用代码 / 纳税人识别号。",
		},
		amount_excl_tax: {
			type: ["number", "null"],
			description: "合计金额（不含税），单位元，数字。",
		},
		tax_amount: {
			type: ["number", "null"],
			description: "合计税额，单位元，数字。",
		},
		amount_incl_tax: {
			type: ["number", "null"],
			description: "价税合计（含税总金额），单位元，数字。",
		},
		remark: {
			type: ["string", "null"],
			description: "备注。",
		},
		items: {
			type: "array",
			description: "发票明细行（项目/商品列表）",
			items: {
				type: "object",
				properties: {
					item_name: { type: ["string", "null"], description: "货物或服务名称" },
					spec: { type: ["string", "null"], description: "规格型号" },
					unit: { type: ["string", "null"], description: "单位，例如 '次'、'件'、'公斤'" },
					quantity: { type: ["number", "null"], description: "数量" },
					unit_price: { type: ["number", "null"], description: "单价（不含税）" },
					amount: { type: ["number", "null"], description: "金额（不含税）" },
					tax_rate: { type: ["number", "null"], description: "税率，小数形式（例如 0.06 代表 6%）" },
					tax_amount: { type: ["number", "null"], description: "税额" },
				},
			},
		},
	},
	required: ["invoice_number", "issue_date"],
};

function unwrap(v: unknown): unknown {
	if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
		return (v as OcrFieldMeta).value;
	}
	return v;
}

function isHilFlagged(v: unknown): boolean {
	return !!(
		v &&
		typeof v === "object" &&
		"hil_flag" in (v as Record<string, unknown>) &&
		(v as OcrFieldMeta).hil_flag === true
	);
}

function toStr(v: unknown): string | null {
	const raw = unwrap(v);
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "string") return raw.trim() || null;
	if (typeof raw === "number") return String(raw);
	return null;
}

function toNum(v: unknown): number | null {
	const raw = unwrap(v);
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const cleaned = raw.replace(/,/g, "").replace(/[¥￥\s]/g, "");
		const n = Number(cleaned);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Loose ISO-date normaliser — same rules as invoice-parser.ts. */
function normalizeDate(s: string | null): string | null {
	if (!s) return null;
	const trimmed = s.trim();
	let m = trimmed.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
	m = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
	m = trimmed.match(/^(\d{4})(\d{2})(\d{2})/);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;
	return null;
}

export interface OcrMappedInvoice {
	parsed: ParsedInvoice;
	needsReview: boolean;
	/** Which field names DeepRead flagged for HIL — for audit / UI. */
	reviewFields: string[];
}

/**
 * Map a completed DeepRead job result into our `ParsedInvoice` shape.
 * Returns null if required fields are missing (invoice_number, issue_date).
 */
export function ocrResultToParsedInvoice(
	ocrResult: OcrJobResult,
	opts: { rawBytes?: Uint8Array } = {},
): OcrMappedInvoice | null {
	const data = ocrResult.result?.data;
	if (!data) return null;

	const invoiceNumberRaw = data.invoice_number;
	const invoiceNumber = toStr(invoiceNumberRaw);
	if (!invoiceNumber) return null;

	const issueDate = normalizeDate(toStr(data.issue_date));
	if (!issueDate) return null;

	const reviewFields: string[] = [];
	for (const [k, v] of Object.entries(data)) {
		if (isHilFlagged(v)) reviewFields.push(k);
	}

	const itemsRaw = unwrap(data.items);
	const items: ParsedInvoiceItem[] = Array.isArray(itemsRaw)
		? itemsRaw
				.map((it: unknown) => {
					const m = (it ?? {}) as Record<string, unknown>;
					return {
						item_name: toStr(m.item_name),
						spec: toStr(m.spec),
						unit: toStr(m.unit),
						quantity: toNum(m.quantity),
						unit_price: toNum(m.unit_price),
						amount: toNum(m.amount),
						tax_rate: toNum(m.tax_rate),
						tax_amount: toNum(m.tax_amount),
					} satisfies ParsedInvoiceItem;
				})
				.filter(
					(it) =>
						it.item_name ||
						it.amount !== null ||
						it.quantity !== null ||
						it.unit_price !== null,
				)
		: [];

	// Preserve the raw DeepRead envelope for audit, same role raw_xml plays
	// for XML-sourced invoices.
	const rawAudit = JSON.stringify({
		source: "deepread-ocr",
		status: ocrResult.status,
		preview_url: ocrResult.preview_url,
		metadata: ocrResult.metadata,
		data,
		pdf_size: opts.rawBytes?.byteLength,
	});

	const parsed: ParsedInvoice = {
		invoice_number: invoiceNumber,
		invoice_code: toStr(data.invoice_code),
		invoice_type: toStr(data.invoice_type),
		issue_date: issueDate,
		seller: {
			name: toStr(data.seller_name),
			tax_id: toStr(data.seller_tax_id),
		},
		buyer: {
			name: toStr(data.buyer_name),
			tax_id: toStr(data.buyer_tax_id),
		},
		amount_excl_tax: toNum(data.amount_excl_tax),
		tax_amount: toNum(data.tax_amount),
		amount_incl_tax: toNum(data.amount_incl_tax),
		remark: toStr(data.remark),
		items,
		raw_xml: rawAudit,
	};

	return {
		parsed,
		needsReview: reviewFields.length > 0,
		reviewFields,
	};
}
