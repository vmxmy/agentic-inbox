// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
	/** How this attachment came to exist:
	 *  - 'email'         : original MIME attachment from the inbound email
	 *  - 'unpacked'      : a file extracted from a container (ZIP/OFD)
	 *  - 'external-url'  : downloaded by following a link in the email body
	 *  - 'manual-upload' : user uploaded a file through the UI / MCP tool,
	 *                       because the email body only had a short-link to a
	 *                       SPA preview page with no direct file download */
	origin: text("origin").notNull().default("email"),
	/** Set only when origin='external-url' — the final URL we fetched from. */
	source_url: text("source_url"),
	/** Container → child relationship for derived attachments. */
	parent_attachment_id: text("parent_attachment_id"),
});

export const invoices = sqliteTable("invoices", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	attachment_id: text("attachment_id")
		.notNull()
		.references(() => attachments.id, { onDelete: "cascade" }),
	invoice_number: text("invoice_number").notNull(),
	invoice_code: text("invoice_code"),
	invoice_type: text("invoice_type"),
	issue_date: text("issue_date").notNull(),
	seller_name: text("seller_name"),
	seller_tax_id: text("seller_tax_id"),
	buyer_name: text("buyer_name"),
	buyer_tax_id: text("buyer_tax_id"),
	amount_excl_tax: real("amount_excl_tax"),
	tax_amount: real("tax_amount"),
	amount_incl_tax: real("amount_incl_tax"),
	currency: text("currency").default("CNY"),
	remark: text("remark"),
	raw_xml: text("raw_xml"),
	created_at: text("created_at").notNull(),
	/** 'xml' for XML attachments, 'pdf-ocr' for DeepRead results. */
	source_kind: text("source_kind").notNull().default("xml"),
	/** 1 if any OCR'd field tripped DeepRead's HIL flag; user should audit. */
	needs_review: integer("needs_review").notNull().default(0),
	/** 红字发票指向的原票号；普通票为 null。 */
	original_invoice_number: text("original_invoice_number"),
	/** 1 = 此票已被红冲（原票视角）。 */
	is_voided: integer("is_voided").notNull().default(0),
});

export const invoiceItems = sqliteTable("invoice_items", {
	id: text("id").primaryKey(),
	invoice_id: text("invoice_id")
		.notNull()
		.references(() => invoices.id, { onDelete: "cascade" }),
	ord: integer("ord").notNull(),
	item_name: text("item_name"),
	spec: text("spec"),
	unit: text("unit"),
	quantity: real("quantity"),
	unit_price: real("unit_price"),
	amount: real("amount"),
	tax_rate: real("tax_rate"),
	tax_amount: real("tax_amount"),
});

export const bundles = sqliteTable("bundles", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	note: text("note"),
	/** 'draft' | 'submitted' | 'reimbursed' — free-form enum, not enforced. */
	status: text("status").notNull().default("draft"),
	created_at: text("created_at").notNull(),
});

export const bundleInvoices = sqliteTable(
	"bundle_invoices",
	{
		bundle_id: text("bundle_id")
			.notNull()
			.references(() => bundles.id, { onDelete: "cascade" }),
		invoice_id: text("invoice_id")
			.notNull()
			.references(() => invoices.id, { onDelete: "cascade" }),
		position: integer("position").notNull().default(0),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.bundle_id, t.invoice_id] }),
	}),
);
