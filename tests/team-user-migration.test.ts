import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const sql = () => readFileSync("migrations/0006_team_user_mailboxes.sql", "utf8");

describe("D1 migration 0006 — team/user mailbox model", () => {
	it("creates teams, team_users, and address_registry additively", () => {
		const text = sql();
		expect(text).toMatch(/CREATE TABLE IF NOT EXISTS teams/);
		expect(text).toMatch(/CREATE TABLE IF NOT EXISTS team_users/);
		expect(text).toMatch(/CREATE TABLE IF NOT EXISTS address_registry/);
		expect(text).not.toMatch(/DROP\s+TABLE/i);
		expect(text).not.toMatch(/ALTER\s+TABLE\s+mailboxes/i);
	});

	it("keeps team slugs unique and team-user slugs unique within a team", () => {
		const text = sql();
		expect(text).toMatch(/teams_slug_active_idx/);
		expect(text).toMatch(/team_users_team_slug_active_idx/);
	});

	it("records address kind and transitional mailbox id", () => {
		const text = sql();
		expect(text).toMatch(/kind TEXT NOT NULL/);
		expect(text).toMatch(/mailbox_id TEXT NOT NULL/);
		expect(text).toMatch(/address_registry_mailbox_idx/);
	});
});
