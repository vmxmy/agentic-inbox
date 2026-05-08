// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { mailboxMigrations } from "../workers/durableObject/migrations";

// Migration 20 is intentionally additive: it annotates audit rows with the
// connection auth mode without rewriting any historical audit data.

describe("Migration 20 — mcp_audit_log.auth_type", () => {
	const m20 = mailboxMigrations.find(
		(m) => m.name === "20_add_mcp_audit_auth_type",
	);

	it("is registered", () => {
		expect(m20).toBeDefined();
	});

	it("comes immediately after migration 19", () => {
		const idx = mailboxMigrations.findIndex(
			(m) => m.name === "20_add_mcp_audit_auth_type",
		);
		expect(idx).toBeGreaterThan(0);
		const prev = mailboxMigrations[idx - 1];
		expect(prev?.name).toBe("19_add_mcp_connections_auth_type");
	});

	it("adds auth_type as TEXT NOT NULL DEFAULT 'oauth'", () => {
		const sql = m20!.sql;

		expect(sql).toMatch(/ALTER TABLE mcp_audit_log ADD COLUMN auth_type/);
		expect(sql).toMatch(/auth_type\s+TEXT\s+NOT NULL\s+DEFAULT\s+'oauth'/);
	});

	it("adds an auth_type index for future observability slices", () => {
		expect(m20!.sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_mcp_audit_auth_type/);
		expect(m20!.sql).toMatch(/ON mcp_audit_log\(auth_type\)/);
	});

	it("does not drop, rename, or mutate mcp_connections", () => {
		const sql = m20!.sql;

		expect(sql).not.toMatch(/DROP\s+COLUMN/i);
		expect(sql).not.toMatch(/RENAME\s+COLUMN/i);
		expect(sql).not.toMatch(/DROP\s+TABLE/i);
		expect(sql).not.toMatch(/RENAME\s+TABLE/i);
		expect(sql).not.toMatch(/mcp_connections/i);
	});
});
