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

/**
 * Inbox processing rules. One row per rule, ordered by `position`. The DO is
 * already mailbox-scoped, so no `mailbox_id` column is needed.
 *
 * `conditions_json` / `actions_json` mirror `RuleSchema.if` / `RuleSchema.then`
 * (see workers/lib/rules.ts) — kept as JSON strings so capability schemas can
 * evolve without ALTER TABLE.
 *
 * `version` is a row-level CAS token: clients pass the version they last read,
 * `replaceRules` fails the row if the stored version has advanced.
 */
export const rules = sqliteTable("rules", {
	id: text("id").primaryKey(),
	position: integer("position").notNull(),
	enabled: integer("enabled").notNull().default(1),
	name: text("name"),
	conditions_json: text("conditions_json").notNull(),
	actions_json: text("actions_json").notNull(),
	version: integer("version").notNull().default(1),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
	updated_by: text("updated_by"),
});

/**
 * Append-only audit log for rules. Survives rule deletion (no FK to rules.id),
 * so a deleted rule's history is recoverable. `seq` is the strictly-increasing
 * audit ordinal; query by `(rule_id, seq DESC)` for most-recent-first views.
 */
export const ruleHistory = sqliteTable("rule_history", {
	seq: integer("seq").primaryKey({ autoIncrement: true }),
	rule_id: text("rule_id").notNull(),
	version: integer("version").notNull(),
	change_kind: text("change_kind").notNull(),
	snapshot_json: text("snapshot_json").notNull(),
	changed_at: text("changed_at").notNull(),
	changed_by: text("changed_by"),
});

/**
 * Mailbox-local agent + UI settings. Singleton row per DO (`id = 'settings'`)
 * because every column applies mailbox-wide. PR 5 + PR 6 of the first-wave
 * architecture migration moved these fields out of the legacy R2 settings
 * blob (`mailboxes/<id>.json`) so writes land transactionally inside the DO
 * and reads no longer need an R2 GET on every agent invocation.
 *
 * Array fields are JSON-serialised text — SQLite has no array type, so the
 * application layer parses on read and stringifies on write.
 *
 * `auto_draft` defaults to NULL meaning "unset"; agent-config callers
 * coalesce to `true` for backward compatibility with mailboxes that pre-date
 * the flag.
 */
export const mailboxSettings = sqliteTable("mailbox_settings", {
	id: text("id").primaryKey(),
	auto_draft: integer("auto_draft"),
	agent_model: text("agent_model"),
	email_reply_model: text("email_reply_model"),
	invoice_model: text("invoice_model"),
	agent_system_prompt: text("agent_system_prompt"),
	invoice_agent_system_prompt: text("invoice_agent_system_prompt"),
	invoice_source_domains_json: text("invoice_source_domains_json"),
	email_reply_enabled_skills_json: text("email_reply_enabled_skills_json"),
	invoice_enabled_skills_json: text("invoice_enabled_skills_json"),
	/**
	 * Opaque JSON object holding the non-agent UI settings that previously
	 * lived in the R2 omnibus blob: `fromName`, `forwarding`, `signature`,
	 * `autoReply`. Stored as a single column so future UI-only fields can be
	 * added without a schema migration.
	 */
	non_agent_settings_json: text("non_agent_settings_json"),
	updated_at: integer("updated_at").notNull(),
});

/**
 * External MCP server connections (Phase 1 of the L4 MCP Client integration).
 *
 * Each row is an external MCP server the mailbox owner attached via
 * Settings → Connected Apps. The Cloudflare Agents SDK already maintains its
 * own MCPClientManager-controlled tables for live connection state + OAuth
 * tokens — this table only carries user-facing metadata + owner audit trail
 * + an optional per-server tool allowlist consumed by Phase 4 streamText
 * merging.
 *
 * `id` is kept identical to the `serverId` returned by `Agent.addMcpServer`
 * so cross-references with `Agent.getMcpServers()` need no extra mapping.
 *
 * `last_state` mirrors the SDK MCPConnectionState recorded at the moment of
 * the last user-initiated mutation (add / remove / refresh) — it is *not*
 * authoritative live state. The live state lives in
 * `Agent.getMcpServers().servers[id].state` and must be queried directly.
 *
 * `enabled_tools_json` is a JSON-serialised `string[]`. `NULL` means
 * "expose every tool the server publishes" (default). An empty array means
 * "expose nothing" — a kill-switch that keeps the connection healthy but
 * hides every tool from the LLM.
 *
 * `transport_type` is filled lazily once the SDK negotiates a transport
 * (`streamable-http` or `sse`); it stays `NULL` until the first successful
 * connection.
 */
export const mcpConnections = sqliteTable("mcp_connections", {
	id: text("id").primaryKey(),
	server_name: text("server_name").notNull().unique(),
	display_name: text("display_name"),
	server_url: text("server_url").notNull(),
	transport_type: text("transport_type"),
	added_by_user_id: text("added_by_user_id").notNull(),
	added_at: integer("added_at").notNull(),
	last_state: text("last_state").notNull(),
	last_error: text("last_error"),
	enabled_tools_json: text("enabled_tools_json"),
	// L4 P8 — Bearer auth additions (migration 19). Defaults to 'oauth' for
	// rows persisted before P8 cutover; the encrypted-blob columns are only
	// populated when auth_type='bearer'.
	auth_type: text("auth_type").notNull().default("oauth"),
	encrypted_token_b64: text("encrypted_token_b64"),
	token_iv_b64: text("token_iv_b64"),
	token_salt_b64: text("token_salt_b64"),
	token_envelope_version: integer("token_envelope_version"),
	token_kek_version: integer("token_kek_version"),
});

/**
 * Append-only audit log for external MCP tool invocations (Phase 5 of the L4
 * MCP Client integration). One row per call from `EmailAgent` /
 * `InvoiceAgent`, regardless of success or failure.
 *
 * `result_flagged_injection` is the integer mirror of the Phase 5
 * prompt-injection screen (1 if `isPromptInjection` flagged the result text,
 * 0 otherwise). `args_json` is the JSON-stringified tool input; `error` is
 * NULL on success and carries the captured error message on failure. Indices
 * support time-range and per-connection queries from the future Phase 6 UI.
 */
export const mcpAuditLog = sqliteTable("mcp_audit_log", {
	id: text("id").primaryKey(),
	conn_id: text("conn_id").notNull(),
	tool_name: text("tool_name").notNull(),
	started_at: integer("started_at").notNull(),
	ended_at: integer("ended_at").notNull(),
	args_json: text("args_json").notNull(),
	error: text("error"),
	result_flagged_injection: integer("result_flagged_injection").notNull().default(0),
});
