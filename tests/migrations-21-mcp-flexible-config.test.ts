// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { mailboxMigrations } from "../workers/durableObject/migrations";

describe("Migration 21 — MCP flexible config columns", () => {
	const m21 = mailboxMigrations.find(
		(m) => m.name === "21_add_mcp_flexible_config_columns",
	);

	it("is registered and is the newest migration", () => {
		expect(m21).toBeDefined();
		const last = mailboxMigrations[mailboxMigrations.length - 1];
		expect(last?.name).toBe("21_add_mcp_flexible_config_columns");
	});

	it("comes immediately after migration 20", () => {
		const idx = mailboxMigrations.findIndex(
			(m) => m.name === "21_add_mcp_flexible_config_columns",
		);
		expect(idx).toBeGreaterThan(0);
		const prev = mailboxMigrations[idx - 1];
		expect(prev?.name).toBe("20_add_mcp_audit_auth_type");
	});

	it("adds both config columns as nullable TEXT", () => {
		const sql = m21!.sql;

		expect(sql).toMatch(/ALTER TABLE mcp_connections ADD COLUMN server_config_json TEXT/);
		expect(sql).toMatch(
			/ALTER TABLE mcp_connections ADD COLUMN enterprise_credentials_encrypted_json TEXT/,
		);
		expect(sql).not.toMatch(/server_config_json\s+TEXT\s+NOT NULL/);
		expect(sql).not.toMatch(
			/enterprise_credentials_encrypted_json\s+TEXT\s+NOT NULL/,
		);
	});

	it("does not drop or rename existing tables or columns", () => {
		const sql = m21!.sql;

		expect(sql).not.toMatch(/DROP\s+COLUMN/i);
		expect(sql).not.toMatch(/RENAME\s+COLUMN/i);
		expect(sql).not.toMatch(/DROP\s+TABLE/i);
		expect(sql).not.toMatch(/RENAME\s+TABLE/i);
	});
});
