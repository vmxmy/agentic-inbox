// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	mcpConnectionToRow,
	rowToMcpConnection,
	toPublicMcpConnection,
	encryptJson,
	decryptJson,
	decryptEnterpriseCredentials,
	type McpConnectionInput,
	type McpConnection,
} from "../workers/lib/mcp-connections";
import type { BearerKekEnv } from "../workers/lib/mcp-token-crypto";

// Reproducible KEK helper copied from mcp-token-crypto tests.
function generateKekB64(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

function makeEnv(kek: string): BearerKekEnv {
	return { MCP_BEARER_KEK_CURRENT: kek };
}

const baseInput: McpConnectionInput = {
	id: "test-gc-1",
	serverName: "google-contacts",
	displayName: "Google Contacts",
	serverUrl: "https://people.googleapis.com/mcp/v1",
	transportType: "streamable-http",
	addedByUserId: "user-1",
	addedAt: 1000000,
	lastState: "ready",
	lastError: null,
	enabledTools: null,
	authType: "oauth",
	serverConfig: { providerType: "google-contacts" },
	enterpriseCredentialsEncryptedJson: null,
	encryptedTokenB64: null,
	tokenIvB64: null,
	tokenSaltB64: null,
	tokenEnvelopeVersion: null,
	tokenKekVersion: null,
};

// ── G8.2: serverConfig round-trip ────────────────────────────────────────────

describe("G8.2 — serverConfig persistence round-trip", () => {
	it("mcpConnectionToRow serializes serverConfig to server_config_json as JSON string", () => {
		// #given a connection with a providerType serverConfig
		// #when serialized to a row
		const row = mcpConnectionToRow(baseInput);
		// #then server_config_json is a non-null JSON string
		expect(row.server_config_json).not.toBeNull();
		expect(typeof row.server_config_json).toBe("string");
		const parsed = JSON.parse(row.server_config_json!);
		expect(parsed).toEqual({ providerType: "google-contacts" });
	});

	it("rowToMcpConnection deserializes server_config_json back to the original serverConfig object", () => {
		// #given a row with server_config_json set
		const row = mcpConnectionToRow(baseInput);
		// #when deserialized
		const conn = rowToMcpConnection(row);
		// #then serverConfig matches the original
		expect(conn.serverConfig).toEqual({ providerType: "google-contacts" });
	});

	it("round-trips serverConfig through mcpConnectionToRow + rowToMcpConnection without loss", () => {
		// #given the canonical google-contacts input
		// #when serialized then deserialized
		const back = rowToMcpConnection(mcpConnectionToRow(baseInput));
		// #then serverConfig is identical
		expect(back.serverConfig).toEqual(baseInput.serverConfig);
	});

	it("rowToMcpConnection sets serverConfig to null when server_config_json is null", () => {
		// #given a row without serverConfig
		const row = mcpConnectionToRow({ ...baseInput, serverConfig: null });
		// #when deserialized
		const conn = rowToMcpConnection(row);
		// #then serverConfig is null
		expect(conn.serverConfig).toBeNull();
	});

	it("toPublicMcpConnection exposes serverConfig in the public DTO", () => {
		// #given an internal connection with serverConfig
		const conn = rowToMcpConnection(mcpConnectionToRow(baseInput));
		// #when projected to the public DTO
		const pub = toPublicMcpConnection(conn);
		// #then serverConfig is present with its full value
		expect(pub.serverConfig).toEqual({ providerType: "google-contacts" });
	});

	it("toPublicMcpConnection preserves null serverConfig in the public DTO", () => {
		// #given an internal connection with no serverConfig
		const conn = rowToMcpConnection(
			mcpConnectionToRow({ ...baseInput, serverConfig: null }),
		);
		// #when projected
		const pub = toPublicMcpConnection(conn);
		// #then null is preserved
		expect(pub.serverConfig).toBeNull();
	});
});

// ── G8.3: enterprise credentials encryption ──────────────────────────────────

describe("G8.3 — enterprise credentials encryption", () => {
	it("encryptJson returns a ciphertext string", async () => {
		// #given a KEK and a credential payload
		const kek = generateKekB64();
		const payload = { clientId: "secret-id", clientSecret: "secret-val" };
		// #when encrypted
		const ciphertext = await encryptJson(makeEnv(kek), payload);
		// #then the result is a non-empty string
		expect(typeof ciphertext).toBe("string");
		expect(ciphertext.length).toBeGreaterThan(0);
	});

	it("encryptJson ciphertext does NOT contain plaintext credentials", async () => {
		// #given a KEK and plaintext credentials
		const kek = generateKekB64();
		const payload = { clientId: "secret-id", clientSecret: "secret-val" };
		// #when encrypted
		const ciphertext = await encryptJson(makeEnv(kek), payload);
		// #then neither the clientId nor clientSecret appear in the ciphertext
		expect(ciphertext).not.toContain("secret-id");
		expect(ciphertext).not.toContain("secret-val");
	});

	it("decryptJson restores the original object", async () => {
		// #given a KEK and an encrypted payload
		const kek = generateKekB64();
		const payload = { clientId: "secret-id", clientSecret: "secret-val" };
		const ciphertext = await encryptJson(makeEnv(kek), payload);
		// #when decrypted
		const result = await decryptJson<typeof payload>(makeEnv(kek), ciphertext);
		// #then the decrypted value equals the original
		expect(result).toEqual(payload);
	});

	it("decryptEnterpriseCredentials returns null when column is null", async () => {
		// #given a connection with no enterprise credentials
		const kek = generateKekB64();
		const connection = { enterpriseCredentialsEncryptedJson: null };
		// #when called
		const result = await decryptEnterpriseCredentials(makeEnv(kek), connection);
		// #then null is returned without error
		expect(result).toBeNull();
	});

	it("decryptEnterpriseCredentials returns decrypted object when column is non-null", async () => {
		// #given a KEK and a pre-encrypted enterprise credential blob
		const kek = generateKekB64();
		const payload = { clientId: "ent-id", clientSecret: "ent-secret", scopes: ["scope.read"] };
		const ciphertext = await encryptJson(makeEnv(kek), payload);
		const connection = { enterpriseCredentialsEncryptedJson: ciphertext };
		// #when decrypted
		const result = await decryptEnterpriseCredentials(makeEnv(kek), connection);
		// #then the original payload is recovered
		expect(result).toEqual(payload);
	});

	it("mcpConnectionToRow stores enterpriseCredentialsEncryptedJson verbatim — no double-encryption", async () => {
		// #given a pre-encrypted blob (encryption happens in the DO before calling mcpConnectionToRow)
		const kek = generateKekB64();
		const payload = { clientId: "ent-id", clientSecret: "ent-secret" };
		const ciphertext = await encryptJson(makeEnv(kek), payload);
		const input: McpConnectionInput = {
			...baseInput,
			enterpriseCredentialsEncryptedJson: ciphertext,
		};
		// #when serialized to a row
		const row = mcpConnectionToRow(input);
		// #then the column stores the ciphertext as-is (not re-encrypted)
		expect(row.enterprise_credentials_encrypted_json).toBe(ciphertext);
		// #and decrypting it once yields the original payload
		const recovered = await decryptJson<typeof payload>(makeEnv(kek), row.enterprise_credentials_encrypted_json!);
		expect(recovered).toEqual(payload);
	});
});
