import { describe, expect, it } from "vitest";
import {
	deriveTeamAddress,
	deriveTeamUserAddress,
	getRootDomain,
	normalizeAddressSlug,
	validateAddressSlug,
} from "../workers/lib/team-addresses";

describe("team address slugs", () => {
	it("normalizes by trimming and lowercasing", () => {
		expect(normalizeAddressSlug("  Finance-Ops  ")).toBe("finance-ops");
	});

	it("accepts simple lowercase ascii names", () => {
		expect(validateAddressSlug("finance")).toEqual({ ok: true, value: "finance" });
		expect(validateAddressSlug("ap-2026")).toEqual({ ok: true, value: "ap-2026" });
	});

	it("rejects invalid separators and unsupported characters", () => {
		expect(validateAddressSlug("-finance").ok).toBe(false);
		expect(validateAddressSlug("finance-").ok).toBe(false);
		expect(validateAddressSlug("finance--ops").ok).toBe(false);
		expect(validateAddressSlug("finance_ops").ok).toBe(false);
		expect(validateAddressSlug("财务").ok).toBe(false);
	});

	it("rejects reserved names", () => {
		expect(validateAddressSlug("admin").ok).toBe(false);
		expect(validateAddressSlug("api").ok).toBe(false);
		expect(validateAddressSlug("system").ok).toBe(false);
	});
});

describe("team address derivation", () => {
	const env = { DOMAINS: " ziikoo.com,example.com " };

	it("selects the first configured domain", () => {
		expect(getRootDomain(env)).toBe("ziikoo.com");
	});

	it("derives team and team-user addresses server-side", () => {
		expect(deriveTeamAddress("Finance", env)).toBe("finance@ziikoo.com");
		expect(deriveTeamUserAddress("Finance", "Alice", env)).toBe("finance.alice@ziikoo.com");
	});

	it("requires at least one configured root domain", () => {
		expect(() => getRootDomain({ DOMAINS: " " })).toThrow(/DOMAINS/);
	});
});
