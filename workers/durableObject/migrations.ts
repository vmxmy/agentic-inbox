// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		// No txn() wrapper — runner uses storage.transactionSync(); CREATE TABLE IF NOT EXISTS
		// is idempotent and safe to retry.
		name: "9_add_invoices_tables",
		sql: `
            CREATE TABLE IF NOT EXISTS invoices (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                attachment_id TEXT NOT NULL,
                invoice_number TEXT NOT NULL,
                invoice_code TEXT,
                invoice_type TEXT,
                issue_date TEXT NOT NULL,
                seller_name TEXT,
                seller_tax_id TEXT,
                buyer_name TEXT,
                buyer_tax_id TEXT,
                amount_excl_tax REAL,
                tax_amount REAL,
                amount_incl_tax REAL,
                currency TEXT DEFAULT 'CNY',
                remark TEXT,
                raw_xml TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE,
                FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS invoice_items (
                id TEXT PRIMARY KEY,
                invoice_id TEXT NOT NULL,
                ord INTEGER NOT NULL,
                item_name TEXT,
                spec TEXT,
                unit TEXT,
                quantity REAL,
                unit_price REAL,
                amount REAL,
                tax_rate REAL,
                tax_amount REAL,
                FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_invoices_email_id ON invoices(email_id);
            CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date DESC);
            CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);
            CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);
        `,
	},
	{
		// No txn() wrapper: ALTER TABLE is auto-committed per statement on SQLite,
		// and DO runtime forbids SQL-level BEGIN. Multiple ALTERs are safe to run
		// independently because each one is idempotent in effect (re-running the
		// migration would skip due to the d1_migrations tracking).
		name: "10_extend_attachments_origin",
		sql: `
            ALTER TABLE attachments ADD COLUMN origin TEXT NOT NULL DEFAULT 'email';
            ALTER TABLE attachments ADD COLUMN source_url TEXT;
            ALTER TABLE attachments ADD COLUMN parent_attachment_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_attachments_parent ON attachments(parent_attachment_id);
            CREATE INDEX IF NOT EXISTS idx_attachments_origin ON attachments(origin);
        `,
	},
	{
		name: "11_add_invoice_source_kind_and_review",
		sql: `
            ALTER TABLE invoices ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'xml';
            ALTER TABLE invoices ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
        `,
	},
	{
		name: "12_add_invoice_red_invoice_link",
		sql: `
            ALTER TABLE invoices ADD COLUMN original_invoice_number TEXT;
            ALTER TABLE invoices ADD COLUMN is_voided INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX IF NOT EXISTS idx_invoices_original_number ON invoices(original_invoice_number);
        `,
	},
	{
		// Reimbursement bundles. A bundle is a named collection of invoices —
		// no field copies; the relation table is the source of truth.
		// CREATE TABLE IF NOT EXISTS keeps re-run idempotent.
		name: "13_add_bundles",
		sql: `
            CREATE TABLE IF NOT EXISTS bundles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                note TEXT,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bundle_invoices (
                bundle_id TEXT NOT NULL,
                invoice_id TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (bundle_id, invoice_id),
                FOREIGN KEY(bundle_id) REFERENCES bundles(id) ON DELETE CASCADE,
                FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_bundle_invoices_bundle ON bundle_invoices(bundle_id);
            CREATE INDEX IF NOT EXISTS idx_bundle_invoices_invoice ON bundle_invoices(invoice_id);
            CREATE INDEX IF NOT EXISTS idx_bundles_created_at ON bundles(created_at DESC);
        `,
	},
	{
		// Rules engine moved out of R2 settings JSON into per-mailbox SQLite.
		// Per-mailbox DO scoping means no mailbox_id column. `position` is a
		// dense 10/20/30 sequence — re-numbered on every replaceRules to keep
		// it dense; the UNIQUE index ensures first-match ordering is always
		// well-defined. `rule_history` has no FK to rules so deletion audit
		// trail is preserved.
		name: "14_add_rules",
		sql: `
            CREATE TABLE IF NOT EXISTS rules (
                id TEXT PRIMARY KEY,
                position INTEGER NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                name TEXT,
                conditions_json TEXT NOT NULL,
                actions_json TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                updated_by TEXT
            );

            CREATE UNIQUE INDEX IF NOT EXISTS uq_rules_position ON rules(position);
            CREATE INDEX IF NOT EXISTS idx_rules_enabled_position ON rules(enabled, position);

            CREATE TABLE IF NOT EXISTS rule_history (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                change_kind TEXT NOT NULL CHECK(change_kind IN ('create','update','delete','reorder')),
                snapshot_json TEXT NOT NULL,
                changed_at TEXT NOT NULL,
                changed_by TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_history_rule ON rule_history(rule_id, seq DESC);
        `,
	},
	{
		// PR 5 + PR 6 of the first-wave architecture migration. Carries the
		// agent-config slice that previously lived in the R2 settings blob
		// (`mailboxes/<id>.json`). Singleton row keyed by `id = 'settings'`
		// because every column applies mailbox-wide; array fields are
		// JSON-serialised text. `auto_draft` is nullable on purpose — the
		// agent-config layer treats NULL as "unset" and coalesces to TRUE
		// for backward compatibility.
		name: "15_add_mailbox_settings",
		sql: `
            CREATE TABLE IF NOT EXISTS mailbox_settings (
                id TEXT PRIMARY KEY,
                auto_draft INTEGER,
                agent_model TEXT,
                email_reply_model TEXT,
                invoice_model TEXT,
                agent_system_prompt TEXT,
                invoice_agent_system_prompt TEXT,
                invoice_source_domains_json TEXT,
                email_reply_enabled_skills_json TEXT,
                invoice_enabled_skills_json TEXT,
                updated_at INTEGER NOT NULL
            );
        `,
	},
	{
		// Carries the non-agent UI fields that previously lived alongside ACL
		// in the legacy R2 settings blob (`mailboxes/<id>.json`):
		// `fromName`, `forwarding`, `signature`, `autoReply`, plus any future
		// UI-only knobs. Stored as a single opaque JSON object so additional
		// fields do not require a schema migration. NULL means "no row yet" /
		// use defaults.
		name: "16_add_mailbox_settings_non_agent",
		sql: `
            ALTER TABLE mailbox_settings ADD COLUMN non_agent_settings_json TEXT;
        `,
	},
	{
		// Phase 1 of the L4 (MCP Client) integration. Per-mailbox metadata for
		// external MCP server connections — the user-facing display layer the
		// owner manages from Settings → Connected Apps. The Cloudflare Agents
		// SDK runs its own MCPClientManager-controlled tables for live
		// connection state + OAuth tokens; this table only stores the
		// owner-supplied display fields, audit trail, and an optional per-server
		// tool allowlist that gates Phase 4 streamText merging.
		//
		// `id` matches the `serverId` returned by `Agent.addMcpServer`; using
		// the SDK's id keeps the join with `getMcpServers()` trivial.
		// `last_state` mirrors the SDK MCPConnectionState at the moment of the
		// last user-initiated mutation, NOT the live runtime state — read live
		// state via `Agent.getMcpServers()`.
		// `enabled_tools_json` is JSON-serialised string[]; NULL means
		// "expose all tools the server publishes" (default).
		// `transport_type` filled lazily once the SDK confirms which transport
		// negotiated successfully (`streamable-http` | `sse`).
		name: "17_add_mcp_connections",
		sql: `
            CREATE TABLE IF NOT EXISTS mcp_connections (
                id TEXT PRIMARY KEY,
                server_name TEXT NOT NULL UNIQUE,
                display_name TEXT,
                server_url TEXT NOT NULL,
                transport_type TEXT,
                added_by_user_id TEXT NOT NULL,
                added_at INTEGER NOT NULL,
                last_state TEXT NOT NULL,
                last_error TEXT,
                enabled_tools_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_mcp_connections_state ON mcp_connections(last_state);
        `,
	},
	{
		// Phase 5 of the L4 (MCP Client) integration. Append-only audit log of
		// every external MCP tool invocation made by `EmailAgent` /
		// `InvoiceAgent`. One row per call regardless of success / failure.
		// `result_flagged_injection` is the integer mirror of the Phase 5
		// prompt-injection screen (1 if `isPromptInjection` flagged the result
		// text, 0 otherwise) — flagged results have a `[SYSTEM: external
		// content...]` marker prepended before the LLM sees them.
		// `args_json` is the JSON-stringified tool input. `error` is the
		// captured error message when the original execute threw, NULL on
		// success.
		name: "18_add_mcp_audit_log",
		sql: `
            CREATE TABLE IF NOT EXISTS mcp_audit_log (
                id TEXT PRIMARY KEY,
                conn_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER NOT NULL,
                args_json TEXT NOT NULL,
                error TEXT,
                result_flagged_injection INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_mcp_audit_started ON mcp_audit_log(started_at);
            CREATE INDEX IF NOT EXISTS idx_mcp_audit_conn ON mcp_audit_log(conn_id);
        `,
	},
	{
		// Phase 1 of the L4 P8 (Bearer Auth) integration. Adds the static-secret
		// auth path next to the existing OAuth flow. `auth_type` discriminates
		// the row; the encrypted-blob columns only carry data when
		// `auth_type='bearer'`. The token plaintext NEVER reaches this table —
		// it is encrypted with a KEK derived from `MCP_BEARER_KEK_CURRENT` via
		// HKDF-SHA256, AES-GCM with a per-row 12-byte IV and 32-byte salt, and
		// wrapped in `EnvelopeV1` whose `kek_version` byte enables graceful
		// dual-KEK rotation (`MCP_BEARER_KEK_CURRENT` + `MCP_BEARER_KEK_PREVIOUS`).
		//
		// Existing OAuth rows retain `auth_type='oauth'` via the column DEFAULT;
		// no backfill UPDATE is required because SQLite applies the default to
		// every pre-existing row at ALTER time. Migration 19 is forward-only —
		// rolling back means leaving the columns in place; downstream phases
		// stay dormant while `L4_MCP_BEARER_ENABLED!=="true"`.
		name: "19_add_mcp_connections_auth_type",
		sql: `
            ALTER TABLE mcp_connections ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth';
            ALTER TABLE mcp_connections ADD COLUMN encrypted_token_b64 TEXT;
            ALTER TABLE mcp_connections ADD COLUMN token_iv_b64 TEXT;
            ALTER TABLE mcp_connections ADD COLUMN token_salt_b64 TEXT;
            ALTER TABLE mcp_connections ADD COLUMN token_envelope_version INTEGER;
            ALTER TABLE mcp_connections ADD COLUMN token_kek_version INTEGER;
        `,
	},
	{
		// Phase 5 of the L4 P8 (Bearer Auth) integration. Carries the
		// connection auth discriminator into the append-only audit log so
		// operators can distinguish OAuth vs Bearer external-tool calls without
		// joining against mutable connection metadata. Existing audit rows are
		// OAuth by construction because Bearer calls were not reachable before
		// this migration; the DEFAULT handles them without a backfill UPDATE.
		name: "20_add_mcp_audit_auth_type",
		sql: `
            ALTER TABLE mcp_audit_log ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth';
            CREATE INDEX IF NOT EXISTS idx_mcp_audit_auth_type ON mcp_audit_log(auth_type);
        `,
	},
	{
		// Flexible MCP provider configuration. `server_config_json` carries
		// non-sensitive provider metadata; enterprise credentials are stored
		// only as an encrypted JSON envelope and remain NULL when platform
		// credentials should be used.
		name: "21_add_mcp_flexible_config_columns",
		sql: `
            ALTER TABLE mcp_connections ADD COLUMN server_config_json TEXT;
            ALTER TABLE mcp_connections ADD COLUMN enterprise_credentials_encrypted_json TEXT;
        `,
	},
];
