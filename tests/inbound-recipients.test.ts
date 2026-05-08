import { describe, expect, it } from "vitest";
import { collectInboundRecipientAddresses } from "../workers/lib/inbound-recipients";

describe("inbound recipient collection", () => {
	it("prefers the Cloudflare envelope recipient before header recipients", () => {
		expect(collectInboundRecipientAddresses(
			" Finance@ZIIKOO.com ",
			[{ address: "newsletter@example.com" }],
		)).toEqual(["finance@ziikoo.com", "newsletter@example.com"]);
	});

	it("keeps Bcc/catch-all deliveries routable when the header To omits the mailbox", () => {
		expect(collectInboundRecipientAddresses(
			"team.alice@ziikoo.com",
			[{ address: "undisclosed-recipients:;" }, { address: null }],
		)).toEqual(["team.alice@ziikoo.com"]);
	});

	it("deduplicates envelope and header recipients after normalization", () => {
		expect(collectInboundRecipientAddresses(
			"Team@ZIIKOO.com",
			[{ address: " team@ziikoo.com " }, { address: "other@ziikoo.com" }],
		)).toEqual(["team@ziikoo.com", "other@ziikoo.com"]);
	});
});
