import { describe, it, expect } from "vitest";
import {
	ProviderCredentialsNotConfiguredError,
	resolveOAuthCredentials,
} from "../workers/lib/mcp-credential-resolver";
import { encryptJson } from "../workers/lib/mcp-connections";
import type { McpConnection } from "../workers/lib/mcp-connections";
import type { BearerKekEnv } from "../workers/lib/mcp-token-crypto";

// Reproducible KEK helper copied from mcp-token-crypto tests.
function generateKekB64(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

type ConnectionStub = Pick<
	McpConnection,
	"enterpriseCredentialsEncryptedJson" | "serverConfig"
>;

function makeEnv(
	kek: string,
	overrides: Record<string, string> = {},
): BearerKekEnv & Record<string, string> {
	return {
		MCP_BEARER_KEK_CURRENT: kek,
		...overrides,
	};
}

describe("resolveOAuthCredentials", () => {
	it("ZII-187: enterprise credentials take priority over platform secrets", async () => {
		// #given a KEK and encrypted enterprise credentials
		const kek = generateKekB64();
		const enterprisePayload = {
			clientId: "enterprise-client-id",
			clientSecret: "enterprise-client-secret",
			scopes: ["custom.scope"],
		};
		const encrypted = await encryptJson(
			makeEnv(kek),
			enterprisePayload,
		);

		// #and platform secrets are ALSO present in env
		const env = makeEnv(kek, {
			GOOGLE_CONTACTS_CLIENT_ID: "platform-client-id",
			GOOGLE_CONTACTS_CLIENT_SECRET: "platform-client-secret",
		});

		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: encrypted,
			serverConfig: { providerType: "google-contacts" },
		};

		// #when resolving credentials
		const result = await resolveOAuthCredentials(env, connection);

		// #then enterprise wins (step 1 priority)
		expect(result).toEqual(enterprisePayload);
	});

	it("ZII-187: platform secrets are used when enterprise column is NULL", async () => {
		// #given a connection with no enterprise credentials
		const kek = generateKekB64();
		const env = makeEnv(kek, {
			GOOGLE_CONTACTS_CLIENT_ID: "platform-client-id",
			GOOGLE_CONTACTS_CLIENT_SECRET: "platform-client-secret",
		});

		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};

		// #when resolving credentials
		const result = await resolveOAuthCredentials(env, connection);

		// #then platform secrets are returned with default scopes
		expect(result).toEqual({
			clientId: "platform-client-id",
			clientSecret: "platform-client-secret",
			scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
		});
	});

	it("ZII-188: throws ProviderCredentialsNotConfiguredError when platform secrets are missing", async () => {
		// #given a connection for a known provider but no env vars
		const kek = generateKekB64();
		const env = makeEnv(kek); // no GOOGLE_CONTACTS_CLIENT_ID / SECRET

		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};

		// #when resolving credentials
		// #then a typed error is thrown with the provider name
		await expect(resolveOAuthCredentials(env, connection)).rejects.toThrow(
			ProviderCredentialsNotConfiguredError,
		);
		await expect(resolveOAuthCredentials(env, connection)).rejects.toThrow(
			/google-contacts/,
		);
	});

	it("ZII-188: generic provider skips platform lookup and throws immediately", async () => {
		// #given a generic provider connection
		const kek = generateKekB64();
		const env = makeEnv(kek);

		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "generic" },
		};

		// #when resolving credentials
		// #then it throws because generic has no registry entry
		await expect(resolveOAuthCredentials(env, connection)).rejects.toThrow(
			ProviderCredentialsNotConfiguredError,
		);
		await expect(resolveOAuthCredentials(env, connection)).rejects.toThrow(
			/generic/,
		);
	});
});
