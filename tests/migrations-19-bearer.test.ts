import { describe, it, expect } from "vitest";
import { mailboxMigrations } from "../workers/durableObject/migrations";

// Plan §82 acceptance: Migration 19 must apply cleanly against a fresh DO
// AND a DO already at migration 18. Real `SqlStorage` is only available
// inside the workers pool; the node-only vitest config (vitest.config.ts:13
// `environment: "node"`) cannot exec the SQL directly. We therefore test
// the migration **spec** here — name, position, and SQL contents — and
// defer the live-execution assertion to the workers-pool integration suite
// scheduled in Phase 6 alongside the cutover. The spec checks below catch
// the most common regressions (renamed migration, missing column, missing
// DEFAULT clause, wrong column type).

describe("Migration 19 — auth_type + encrypted token columns", () => {
	const m19 = mailboxMigrations.find(
		(m) => m.name === "19_add_mcp_connections_auth_type",
	);

	it("is registered in mailboxMigrations", () => {
		expect(m19).toBeDefined();
	});

	it("sits immediately before migration 20 (append-only order invariant)", () => {
		// #given the migration runner applies entries in array order
		// #when Phase 5 appends migration 20
		// #then migration 19 must keep its historical position rather than move
		const idx = mailboxMigrations.findIndex(
			(m) => m.name === "19_add_mcp_connections_auth_type",
		);
		const next = mailboxMigrations[idx + 1];
		expect(next?.name).toBe("20_add_mcp_audit_auth_type");
	});

	it("comes immediately after migration 18 (mcp_audit_log)", () => {
		const idx = mailboxMigrations.findIndex(
			(m) => m.name === "19_add_mcp_connections_auth_type",
		);
		expect(idx).toBeGreaterThan(0);
		const prev = mailboxMigrations[idx - 1];
		expect(prev?.name).toBe("18_add_mcp_audit_log");
	});

	it("adds auth_type as TEXT NOT NULL DEFAULT 'oauth'", () => {
		// #given the migration SQL
		const sql = m19!.sql;
		// #then the auth_type column comes through with the right shape so existing
		// rows keep working without a backfill UPDATE
		expect(sql).toMatch(/ALTER TABLE mcp_connections ADD COLUMN auth_type/);
		expect(sql).toMatch(/auth_type\s+TEXT\s+NOT NULL\s+DEFAULT\s+'oauth'/);
	});

	it("adds encrypted-blob columns as nullable", () => {
		const sql = m19!.sql;
		// #then each encrypted-blob column is added (TEXT for base64 blobs;
		// INTEGER for envelope/kek version stamps) and stays nullable so OAuth
		// rows do not need to populate them
		expect(sql).toMatch(/ADD COLUMN encrypted_token_b64 TEXT/);
		expect(sql).toMatch(/ADD COLUMN token_iv_b64 TEXT/);
		expect(sql).toMatch(/ADD COLUMN token_salt_b64 TEXT/);
		expect(sql).toMatch(/ADD COLUMN token_envelope_version INTEGER/);
		expect(sql).toMatch(/ADD COLUMN token_kek_version INTEGER/);
		// #and none of the encrypted-blob columns are NOT NULL — that would
		// break every existing oauth row at the ALTER step
		expect(sql).not.toMatch(/encrypted_token_b64\s+TEXT\s+NOT NULL/);
		expect(sql).not.toMatch(/token_iv_b64\s+TEXT\s+NOT NULL/);
		expect(sql).not.toMatch(/token_salt_b64\s+TEXT\s+NOT NULL/);
	});

	it("does NOT drop or rename existing mcp_connections columns", () => {
		// #given the migration SQL — it must be additive only
		const sql = m19!.sql;
		// #then no DROP / RENAME statement appears
		expect(sql).not.toMatch(/DROP\s+COLUMN/i);
		expect(sql).not.toMatch(/RENAME\s+COLUMN/i);
		expect(sql).not.toMatch(/DROP\s+TABLE/i);
		expect(sql).not.toMatch(/RENAME\s+TABLE/i);
	});

	it("targets only mcp_connections (not mcp_audit_log)", () => {
		// #given audit_log carries auth_type in a separate Phase 5 migration
		// #when this migration runs
		// #then it must not touch the audit log table
		expect(m19!.sql).not.toMatch(/mcp_audit_log/);
	});
});

describe("Migration 19 — idempotency contract", () => {
	it("the migration runner skips already-applied entries by name", () => {
		// #given the migration runner uses d1_migrations.name as the dedup key
		// (see workers/durableObject/migrations.ts applyMigrations:29-35)
		// #when 19 has already been applied
		// #then re-running mailboxMigrations does NOT re-execute its SQL.
		// We can't exercise the live DB here, but we can assert the migration
		// has a stable, unique name — the runner's only dedup signal.
		const names = mailboxMigrations.map((m) => m.name);
		const uniqueCount = new Set(names).size;
		expect(uniqueCount).toBe(names.length);
		// #and migration 19 in particular is uniquely named
		const m19Count = names.filter(
			(n) => n === "19_add_mcp_connections_auth_type",
		).length;
		expect(m19Count).toBe(1);
	});
});
