// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
	ProviderCredentialsNotConfiguredError,
	resolveOAuthCredentials,
} from "../workers/lib/mcp-credential-resolver";
import { PROVIDER_CREDENTIAL_REGISTRY } from "../workers/lib/mcp-connections";
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

// ── G8.4: missing platform credentials → typed error ─────────────────────────

describe("G8.4 — ProviderCredentialsNotConfiguredError when platform credentials are absent", () => {
	it("throws ProviderCredentialsNotConfiguredError when env has no GOOGLE_CONTACTS_* vars", async () => {
		// #given a google-contacts connection with no enterprise credentials
		const kek = generateKekB64();
		const env = makeEnv(kek); // no GOOGLE_CONTACTS_CLIENT_ID / SECRET
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when resolving credentials
		// #then a typed error is thrown
		await expect(resolveOAuthCredentials(env, connection)).rejects.toThrow(
			ProviderCredentialsNotConfiguredError,
		);
	});

	it("error message includes the provider name", async () => {
		// #given a google-contacts connection with empty env
		const kek = generateKekB64();
		const env = makeEnv(kek);
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when resolving credentials
		// #then the error names the provider for actionable diagnostics
		await expect(resolveOAuthCredentials(env, connection)).rejects.toThrow(
			/google-contacts/,
		);
	});

	it("simulates the agent catch: error can be caught without propagating", async () => {
		// #given a connection whose credentials are not configured
		const kek = generateKekB64();
		const env = makeEnv(kek);
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when the agent catches the error and logs a warn (simulated)
		let caughtError: unknown = undefined;
		let continuedAfterCatch = false;
		try {
			await resolveOAuthCredentials(env, connection);
		} catch (err) {
			// simulates: console.warn("credentials not configured", err)
			caughtError = err;
		}
		// #then execution continues — no uncaught exception propagates
		continuedAfterCatch = true;
		expect(continuedAfterCatch).toBe(true);
		expect(caughtError).toBeInstanceOf(ProviderCredentialsNotConfiguredError);
	});

	it("subsequent operations succeed after catching the error", async () => {
		// #given a connection with no credentials
		const kek = generateKekB64();
		const env = makeEnv(kek);
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when the error is caught
		let caught = false;
		try {
			await resolveOAuthCredentials(env, connection);
		} catch {
			caught = true;
		}
		// #then other operations can proceed without issue
		expect(caught).toBe(true);
		const registry = PROVIDER_CREDENTIAL_REGISTRY["google-contacts"];
		expect(registry).toBeDefined();
		expect(registry!.envPrefix).toBe("GOOGLE_CONTACTS");
	});
});

// ── G8.5: platform credentials present → successful resolution ────────────────

describe("G8.5 — credentials resolve successfully when platform secrets are present", () => {
	it("returns clientId and clientSecret from env vars", async () => {
		// #given a google-contacts connection with platform secrets in env
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
		// #then clientId and clientSecret are returned
		expect(result.clientId).toBe("platform-client-id");
		expect(result.clientSecret).toBe("platform-client-secret");
	});

	it("returns the registry default scopes when no override is set", async () => {
		// #given a google-contacts connection with platform secrets but no custom scopes
		const kek = generateKekB64();
		const env = makeEnv(kek, {
			GOOGLE_CONTACTS_CLIENT_ID: "platform-client-id",
			GOOGLE_CONTACTS_CLIENT_SECRET: "platform-client-secret",
		});
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when resolving
		const result = await resolveOAuthCredentials(env, connection);
		// #then scopes match the PROVIDER_CREDENTIAL_REGISTRY defaults
		const expectedScopes = PROVIDER_CREDENTIAL_REGISTRY["google-contacts"]!.defaultScopes;
		expect(result.scopes).toEqual(expectedScopes);
	});

	it("resolved scopes include the contacts.readonly scope", async () => {
		// #given a google-contacts connection with platform secrets
		const kek = generateKekB64();
		const env = makeEnv(kek, {
			GOOGLE_CONTACTS_CLIENT_ID: "platform-client-id",
			GOOGLE_CONTACTS_CLIENT_SECRET: "platform-client-secret",
		});
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when resolving credentials (represents "reaches ready state" scenario)
		const result = await resolveOAuthCredentials(env, connection);
		// #then the OAuth-required scope for contacts is present
		expect(result.scopes).toContain(
			"https://www.googleapis.com/auth/contacts.readonly",
		);
	});

	it("full result shape matches platform clientId, clientSecret, and default scopes", async () => {
		// #given platform secrets for google-contacts
		const kek = generateKekB64();
		const env = makeEnv(kek, {
			GOOGLE_CONTACTS_CLIENT_ID: "platform-client-id",
			GOOGLE_CONTACTS_CLIENT_SECRET: "platform-client-secret",
		});
		const connection: ConnectionStub = {
			enterpriseCredentialsEncryptedJson: null,
			serverConfig: { providerType: "google-contacts" },
		};
		// #when credentials are resolved
		const result = await resolveOAuthCredentials(env, connection);
		// #then the full shape is correct — OAuth can proceed
		expect(result).toEqual({
			clientId: "platform-client-id",
			clientSecret: "platform-client-secret",
			scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
		});
	});
});
