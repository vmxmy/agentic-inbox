import { describe, it, expect } from "vitest";
import {
	BearerDecryptError,
	CATEGORIES,
	FALLBACK_CATEGORY,
	MissingKekError,
	categoriseError,
	decryptBearerToken,
	deriveBearerKey,
	encryptBearerToken,
	redactToken,
	redactTokenFromText,
	type EnvelopeV1,
} from "../workers/lib/mcp-token-crypto";

// Reproducible KEK helper. 32 random bytes, base64-encoded.
function generateKekB64(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

describe("encryptBearerToken / decryptBearerToken round-trip", () => {
	it("round-trips a single token", async () => {
		// #given a fresh KEK and a sample token
		const kek = generateKekB64();
		const env = { MCP_BEARER_KEK_CURRENT: kek };
		// #when encrypted and decrypted
		const blob = await encryptBearerToken(env, "ghp_abcdef1234567890");
		const back = await decryptBearerToken(env, blob);
		// #then the plaintext returns intact
		expect(back).toBe("ghp_abcdef1234567890");
	});

	it("round-trips 64 random tokens of varied lengths", async () => {
		// #given a fresh KEK and 64 random tokens (16..512 bytes)
		const kek = generateKekB64();
		const env = { MCP_BEARER_KEK_CURRENT: kek };
		// #when each is encrypted then decrypted
		for (let i = 0; i < 64; i++) {
			const len = 16 + Math.floor(Math.random() * 497);
			const buf = crypto.getRandomValues(new Uint8Array(len));
			const plaintext = btoa(
				Array.from(buf, (b) => String.fromCharCode(b)).join(""),
			);
			const blob = await encryptBearerToken(env, plaintext);
			const back = await decryptBearerToken(env, blob);
			// #then every round-trip returns the original
			expect(back).toBe(plaintext);
		}
	});

	it("emits unique IVs across 100 invocations of the same plaintext", async () => {
		// #given the same plaintext encrypted 100 times under the same KEK
		const kek = generateKekB64();
		const env = { MCP_BEARER_KEK_CURRENT: kek };
		const seen = new Set<string>();
		// #when collecting every IV
		for (let i = 0; i < 100; i++) {
			const blob = await encryptBearerToken(env, "constant-token");
			seen.add(blob.ivB64);
		}
		// #then all 100 IVs are distinct (12-byte random nonces collide ≈ 2^-48)
		expect(seen.size).toBe(100);
	});

	it("stamps kekVersion=1 by default", async () => {
		// #given an env without MCP_BEARER_KEK_VERSION
		const env = { MCP_BEARER_KEK_CURRENT: generateKekB64() };
		// #when encrypting
		const blob = await encryptBearerToken(env, "tok");
		// #then the envelope stamps version 1
		expect(blob.kekVersion).toBe(1);
		expect(blob.version).toBe(1);
	});

	it("stamps kekVersion from MCP_BEARER_KEK_VERSION when set", async () => {
		// #given an explicitly stamped version
		const env = {
			MCP_BEARER_KEK_CURRENT: generateKekB64(),
			MCP_BEARER_KEK_VERSION: "7",
		};
		// #when encrypting
		const blob = await encryptBearerToken(env, "tok");
		// #then the stamp matches
		expect(blob.kekVersion).toBe(7);
	});

	it("throws MissingKekError when MCP_BEARER_KEK_CURRENT is unset", async () => {
		// #given an env without a KEK
		// #when attempting to encrypt
		// #then MissingKekError surfaces
		await expect(encryptBearerToken({}, "tok")).rejects.toBeInstanceOf(
			MissingKekError,
		);
	});

	it("rejects malformed MCP_BEARER_KEK_VERSION at encrypt time", async () => {
		const env = {
			MCP_BEARER_KEK_CURRENT: generateKekB64(),
			MCP_BEARER_KEK_VERSION: "not-a-number",
		};
		await expect(encryptBearerToken(env, "tok")).rejects.toThrow(
			/positive integer/,
		);
	});
});

describe("decryptBearerToken — tamper detection", () => {
	it("rejects ciphertext mutations with BearerDecryptError", async () => {
		// #given a valid envelope
		const env = { MCP_BEARER_KEK_CURRENT: generateKekB64() };
		const blob = await encryptBearerToken(env, "secret-token");
		// #when the ciphertext is mutated by 1 byte
		const tampered: EnvelopeV1 = {
			...blob,
			ciphertextB64: blob.ciphertextB64.slice(0, -2) +
				(blob.ciphertextB64.endsWith("A") ? "B==" : "AA="),
		};
		// #then decryption surfaces a stable error class with no detail leaked
		await expect(decryptBearerToken(env, tampered)).rejects.toBeInstanceOf(
			BearerDecryptError,
		);
	});

	it("rejects IV mutations", async () => {
		const env = { MCP_BEARER_KEK_CURRENT: generateKekB64() };
		const blob = await encryptBearerToken(env, "secret-token");
		// #when the IV is replaced with a different valid IV
		const otherIv = btoa(
			Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
				String.fromCharCode(b),
			).join(""),
		);
		// #then decryption fails
		await expect(
			decryptBearerToken(env, { ...blob, ivB64: otherIv }),
		).rejects.toBeInstanceOf(BearerDecryptError);
	});

	it("rejects salt mutations (wrong derivation key)", async () => {
		const env = { MCP_BEARER_KEK_CURRENT: generateKekB64() };
		const blob = await encryptBearerToken(env, "secret-token");
		const otherSalt = btoa(
			Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
				String.fromCharCode(b),
			).join(""),
		);
		await expect(
			decryptBearerToken(env, { ...blob, saltB64: otherSalt }),
		).rejects.toBeInstanceOf(BearerDecryptError);
	});

	it("throws BearerDecryptError when both KEKs are absent", async () => {
		// #given a valid blob produced under some KEK
		const blob = await encryptBearerToken(
			{ MCP_BEARER_KEK_CURRENT: generateKekB64() },
			"secret",
		);
		// #when neither KEK is in env
		// #then BearerDecryptError surfaces with the stable "decrypt_failed" message
		const err = await decryptBearerToken({}, blob).catch((e) => e);
		expect(err).toBeInstanceOf(BearerDecryptError);
		expect((err as Error).message).toBe("decrypt_failed");
	});
});

describe("KEK rotation drill", () => {
	it("decrypts a v1-encrypted blob after rotation to v2 with v1 as PREVIOUS", async () => {
		// #given a blob encrypted under v1 only
		const kekV1 = generateKekB64();
		const blobV1 = await encryptBearerToken(
			{ MCP_BEARER_KEK_CURRENT: kekV1, MCP_BEARER_KEK_VERSION: "1" },
			"persistent-token",
		);
		expect(blobV1.kekVersion).toBe(1);
		// #when v2 is rotated in (CURRENT) with v1 retained as PREVIOUS
		const kekV2 = generateKekB64();
		const rotated = {
			MCP_BEARER_KEK_CURRENT: kekV2,
			MCP_BEARER_KEK_PREVIOUS: kekV1,
			MCP_BEARER_KEK_VERSION: "2",
		};
		// #then the v1 blob still decrypts via the PREVIOUS slot
		const back = await decryptBearerToken(rotated, blobV1);
		expect(back).toBe("persistent-token");
	});

	it("fails to decrypt a v1 blob after PREVIOUS is dropped", async () => {
		// #given a blob encrypted under v1
		const kekV1 = generateKekB64();
		const env1 = { MCP_BEARER_KEK_CURRENT: kekV1, MCP_BEARER_KEK_VERSION: "1" };
		const blobV1 = await encryptBearerToken(env1, "old-token");
		// #when v2 is rotated in WITHOUT keeping v1 as PREVIOUS
		const env2only = {
			MCP_BEARER_KEK_CURRENT: generateKekB64(),
			MCP_BEARER_KEK_VERSION: "2",
		};
		// #then BearerDecryptError surfaces with the stable error string
		const err = await decryptBearerToken(env2only, blobV1).catch((e) => e);
		expect(err).toBeInstanceOf(BearerDecryptError);
		expect((err as Error).message).toBe("decrypt_failed");
	});
});

describe("deriveBearerKey", () => {
	it("produces an extractable=false AES-GCM key suitable for encrypt/decrypt", async () => {
		const kek = generateKekB64();
		const salt = btoa(
			Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
				String.fromCharCode(b),
			).join(""),
		);
		const key = await deriveBearerKey(kek, salt, 1);
		expect(key.algorithm.name).toBe("AES-GCM");
		// AES-GCM 256-bit
		expect((key.algorithm as { length?: number }).length).toBe(256);
		expect(key.extractable).toBe(false);
		expect(key.usages).toContain("encrypt");
		expect(key.usages).toContain("decrypt");
	});

	it("produces different keys for the same KEK + version when salt differs", async () => {
		const kek = generateKekB64();
		const saltA = btoa("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
		const saltB = btoa("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=");
		const keyA = await deriveBearerKey(kek, saltA, 1);
		const keyB = await deriveBearerKey(kek, saltB, 1);
		// Keys are non-extractable; verify by encrypting the same plaintext+IV
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const plaintext = new TextEncoder().encode("same");
		const cA = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: iv as BufferSource },
				keyA,
				plaintext as BufferSource,
			),
		);
		const cB = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: iv as BufferSource },
				keyB,
				plaintext as BufferSource,
			),
		);
		// Distinct salts must yield distinct ciphertexts under same IV+plaintext
		expect(Buffer.from(cA).toString("hex")).not.toBe(
			Buffer.from(cB).toString("hex"),
		);
	});
});

describe("redactToken", () => {
	it.each([
		"ghp_abc123def456",
		"sk-aBcDeFgHiJ0123456789",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
		"AKIAIOSFODNN7EXAMPLE",
		"x".repeat(4096),
	])("never includes the input substring (input length %#)", (input) => {
		// #given an input token of various shapes
		// #when redacted
		const out = redactToken(input);
		// #then the output is the stable redacted form and contains no substring
		expect(out).toBe(`<bearer:redacted:len=${input.length}>`);
		// Reject any shared 4-char run between input and output (catches partial leaks)
		for (let i = 0; i + 4 <= input.length; i++) {
			expect(out.includes(input.slice(i, i + 4))).toBe(false);
		}
	});

	it("handles the empty string without throwing", () => {
		expect(redactToken("")).toBe("<bearer:redacted:len=0>");
	});
});

describe("redactTokenFromText", () => {
	it("replaces every exact token occurrence with the fixed redaction marker", () => {
		const text = "Authorization: Bearer ghp_secret; retry ghp_secret";

		const redacted = redactTokenFromText(text, "ghp_secret");

		expect(redacted).toBe(
			"Authorization: Bearer <bearer:redacted:len=10>; retry <bearer:redacted:len=10>",
		);
		expect(redacted).not.toContain("ghp_secret");
	});
});

describe("CATEGORIES whitelist", () => {
	it("contains exactly the seven approved codes", () => {
		expect([...CATEGORIES]).toEqual([
			"connect_failed",
			"unauthorized",
			"timeout",
			"transport_error",
			"injection_blocked",
			"decrypt_failed",
			"discovery_failed",
		]);
	});

	it("FALLBACK_CATEGORY is the documented sentinel", () => {
		expect(FALLBACK_CATEGORY).toBe("external_mcp_error");
	});
});

describe("HKDF info string is stable", () => {
	it("derives the same key from the same KEK+salt+version", async () => {
		const kek = generateKekB64();
		const salt = btoa("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=");
		const k1 = await deriveBearerKey(kek, salt, 1);
		const k2 = await deriveBearerKey(kek, salt, 1);
		// Same KEK+salt+version must yield the same encrypt result
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const pt = new TextEncoder().encode("stable-info");
		const c1 = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: iv as BufferSource },
				k1,
				pt as BufferSource,
			),
		);
		const c2 = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv: iv as BufferSource },
				k2,
				pt as BufferSource,
			),
		);
		expect(Buffer.from(c1).toString("hex")).toBe(
			Buffer.from(c2).toString("hex"),
		);
	});
});

// categoriseError lives in its own dedicated suite — see
// `tests/mcp-error-categorise.test.ts`. We keep one smoke test here
// to ensure the export wiring remains intact.
describe("categoriseError export", () => {
	it("returns 'decrypt_failed' for BearerDecryptError instances", () => {
		expect(categoriseError(new BearerDecryptError())).toBe("decrypt_failed");
	});
});
