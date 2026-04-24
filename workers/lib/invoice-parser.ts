// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Deterministic XML → ParsedInvoice for Chinese 全电发票 / 增值税电子发票.
 *
 * Zero deps; single regex walker. Multiple candidate tag names per field cover
 * the common variants we've seen in the wild (国家税务总局 EleInv-V_5.0/6.0
 * Pinyin abbreviations + a few CamelCase variants from third-party ERPs).
 *
 * Returns null for anything we cannot recognise as an invoice (no Fphm /
 * invoice number, or no parseable issue date).
 */

import { decodeBytes } from "./attachment-extract";

export interface ParsedInvoiceItem {
	item_name: string | null;
	spec: string | null;
	unit: string | null;
	quantity: number | null;
	unit_price: number | null;
	amount: number | null;
	tax_rate: number | null;
	tax_amount: number | null;
}

export interface ParsedInvoice {
	invoice_number: string;
	invoice_code: string | null;
	invoice_type: string | null;
	issue_date: string;
	seller: { name: string | null; tax_id: string | null };
	buyer: { name: string | null; tax_id: string | null };
	amount_excl_tax: number | null;
	tax_amount: number | null;
	amount_incl_tax: number | null;
	remark: string | null;
	items: ParsedInvoiceItem[];
	raw_xml: string;
}

// Tags that delimit a single item row inside a list. When the parser opens
// one, all leaf text inside (until the matching close) is collected into that
// item rather than the header field map.
const ITEM_CONTAINERS = new Set([
	"commodityinformation",
	"detail",
	"item",
	"items",
	"spxx",
	"xminfo",
	"xmxx",
	"xmlist",
	"commodity",
	"invoiceitem",
	"goodsitem",
]);

const HEADER_FIELDS = {
	invoice_number: ["fphm", "fp_hm", "invoicenumber", "invoice_number", "invno"],
	invoice_code: ["fpdm", "fp_dm", "invoicecode", "invoice_code"],
	invoice_type: [
		"fplx",
		"fp_lx",
		"fplxdm",
		"invoicetype",
		"invoicetypename",
		"fplxmc",
	],
	issue_date: ["kprq", "kp_rq", "invoicedate", "issuedate", "kpsj"],
	seller_name: ["xfmc", "xf_mc", "sellername", "seller_name"],
	seller_tax_id: [
		"xfsbh",
		"xf_sbh",
		"sellertaxid",
		"seller_taxno",
		"sellertaxno",
		"sellerid",
	],
	buyer_name: ["gfmc", "gf_mc", "buyername", "buyer_name"],
	buyer_tax_id: [
		"gfsbh",
		"gf_sbh",
		"buyertaxid",
		"buyer_taxno",
		"buyertaxno",
		"buyerid",
	],
	amount_excl_tax: [
		"hjje",
		"hj_je",
		"totalamwithouttax",
		"totalamtwithouttax",
		"sumamtnotax",
		"totalexcludetax",
		"je",
	],
	tax_amount: [
		"hjse",
		"hj_se",
		"taxtotalamount",
		"totaltax",
		"totaltaxamount",
		"sumtax",
	],
	amount_incl_tax: [
		"jshj",
		"js_hj",
		"totalamwithtax",
		"totalamtwithtax",
		"sumamttax",
		"totalincludetax",
		"priceandtaxtotal",
	],
	remark: ["bz", "remark", "remarks", "memo"],
} as const;

const ITEM_FIELDS = {
	item_name: ["spmc", "sp_mc", "commodityname", "goods_name", "name", "xmmc"],
	spec: ["ggxh", "gg_xh", "spec", "specifications"],
	unit: ["dw", "unit", "measureunit"],
	quantity: ["spsl", "sp_sl", "num", "quantity", "qty"],
	unit_price: ["dj", "unitprice", "price"],
	amount: ["je", "detailamount", "amount", "amt"],
	tax_rate: ["sl", "tax_rate", "taxrate"],
	tax_amount: ["se", "detailtax", "tax", "taxamount"],
} as const;

function pickStr(
	map: Map<string, string>,
	keys: readonly string[],
): string | null {
	for (const k of keys) {
		const v = map.get(k);
		if (v && v.trim()) return v.trim();
	}
	return null;
}

function pickNum(
	map: Map<string, string>,
	keys: readonly string[],
): number | null {
	const s = pickStr(map, keys);
	if (!s) return null;
	// Strip thousands separators, currency marks, whitespace.
	const cleaned = s.replace(/,/g, "").replace(/[¥￥\s]/g, "");
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a date string to ISO `YYYY-MM-DD`. Returns null if no recognisable
 * date can be extracted. Accepts:
 *   - 2024-01-15 / 2024/01/15 / 2024.01.15
 *   - 20240115
 *   - 2024年1月15日
 *   - 2024-01-15T08:00:00 (truncated to date)
 */
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

interface WalkEvent {
	type: "open" | "close" | "text";
	tag?: string;
	text?: string;
}

/**
 * Walk the XML producing open/close/text events. Self-closing tags emit
 * both open and close.
 */
function walkXml(s: string): WalkEvent[] {
	const stripped = s
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\?[^?]*\?>/g, " ")
		.replace(/<!DOCTYPE[^>]*>/gi, " ")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

	const events: WalkEvent[] = [];
	const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g;
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(stripped)) !== null) {
		const between = stripped.slice(lastIdx, m.index);
		const trimmed = between.replace(/\s+/g, " ").trim();
		if (trimmed) events.push({ type: "text", text: trimmed });

		const isClose = m[1] === "/";
		const isSelfClose = m[3] === "/";
		const tag = m[2].toLowerCase();

		if (isClose) {
			events.push({ type: "close", tag });
		} else {
			events.push({ type: "open", tag });
			if (isSelfClose) events.push({ type: "close", tag });
		}
		lastIdx = m.index + m[0].length;
	}
	const tail = stripped.slice(lastIdx).replace(/\s+/g, " ").trim();
	if (tail) events.push({ type: "text", text: tail });
	return events;
}

/** Materialise events into header field map + item maps. */
function collect(events: WalkEvent[]): {
	flat: Map<string, string>;
	items: Map<string, string>[];
} {
	const flat = new Map<string, string>();
	const items: Map<string, string>[] = [];
	const stack: string[] = [];
	let currentItem: Map<string, string> | null = null;
	let itemDepth = -1;

	for (const ev of events) {
		if (ev.type === "open") {
			stack.push(ev.tag!);
			if (!currentItem && ITEM_CONTAINERS.has(ev.tag!)) {
				currentItem = new Map();
				itemDepth = stack.length;
			}
		} else if (ev.type === "close") {
			if (currentItem && stack.length === itemDepth) {
				if (currentItem.size > 0) items.push(currentItem);
				currentItem = null;
				itemDepth = -1;
			}
			stack.pop();
		} else {
			const tag = stack[stack.length - 1];
			if (!tag) continue;
			const target = currentItem ?? flat;
			// First non-empty wins for the same tag inside one container.
			const existing = target.get(tag);
			if (!existing) target.set(tag, ev.text!);
		}
	}

	return { flat, items };
}

export function parseChinaEInvoiceXml(
	bytes: ArrayBuffer | Uint8Array,
): ParsedInvoice | null {
	const raw = decodeBytes(bytes);
	if (!raw) return null;

	const { flat, items } = collect(walkXml(raw));

	const invoiceNumber = pickStr(flat, HEADER_FIELDS.invoice_number);
	if (!invoiceNumber) return null;

	const issueDate = normalizeDate(pickStr(flat, HEADER_FIELDS.issue_date));
	if (!issueDate) return null;

	const parsedItems: ParsedInvoiceItem[] = items
		.map((it) => ({
			item_name: pickStr(it, ITEM_FIELDS.item_name),
			spec: pickStr(it, ITEM_FIELDS.spec),
			unit: pickStr(it, ITEM_FIELDS.unit),
			quantity: pickNum(it, ITEM_FIELDS.quantity),
			unit_price: pickNum(it, ITEM_FIELDS.unit_price),
			amount: pickNum(it, ITEM_FIELDS.amount),
			tax_rate: pickNum(it, ITEM_FIELDS.tax_rate),
			tax_amount: pickNum(it, ITEM_FIELDS.tax_amount),
		}))
		// Drop empty rows (containers that matched but had no recognisable fields).
		.filter(
			(it) =>
				it.item_name ||
				it.amount !== null ||
				it.quantity !== null ||
				it.unit_price !== null,
		);

	return {
		invoice_number: invoiceNumber,
		invoice_code: pickStr(flat, HEADER_FIELDS.invoice_code),
		invoice_type: pickStr(flat, HEADER_FIELDS.invoice_type),
		issue_date: issueDate,
		seller: {
			name: pickStr(flat, HEADER_FIELDS.seller_name),
			tax_id: pickStr(flat, HEADER_FIELDS.seller_tax_id),
		},
		buyer: {
			name: pickStr(flat, HEADER_FIELDS.buyer_name),
			tax_id: pickStr(flat, HEADER_FIELDS.buyer_tax_id),
		},
		amount_excl_tax: pickNum(flat, HEADER_FIELDS.amount_excl_tax),
		tax_amount: pickNum(flat, HEADER_FIELDS.tax_amount),
		amount_incl_tax: pickNum(flat, HEADER_FIELDS.amount_incl_tax),
		remark: pickStr(flat, HEADER_FIELDS.remark),
		items: parsedItems,
		raw_xml: raw,
	};
}
