import { describe, expect, it } from "vitest";
import { isExplicitLegacyAddress } from "../workers/lib/teams";

describe("team address resolution helpers", () => {
	it("only treats configured fixed addresses as legacy-compatible", () => {
		const env = { EMAIL_ADDRESSES: [" finance@ziikoo.com ", "Support@ZIIKOO.com"] };

		expect(isExplicitLegacyAddress("finance@ziikoo.com", env)).toBe(true);
		expect(isExplicitLegacyAddress("support@ziikoo.com", env)).toBe(true);
		expect(isExplicitLegacyAddress("random@ziikoo.com", env)).toBe(false);
	});

	it("does not grant a legacy fallback when fixed addresses are unset", () => {
		expect(isExplicitLegacyAddress("finance@ziikoo.com", { EMAIL_ADDRESSES: [] })).toBe(false);
		expect(isExplicitLegacyAddress("finance@ziikoo.com", {})).toBe(false);
	});
});
