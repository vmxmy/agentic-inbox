// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * OAuth credential resolver for MCP connections.
 *
 * Implements the three-step priority chain defined in the OpenSpec design:
 *   1. Per-connection enterprise credentials (encrypted JSON blob).
 *   2. Platform-level credentials from Workers Secrets (Env vars).
 *   3. Fail closed with a typed error when nothing is found.
 *
 * This module is pure — no DO bindings, no I/O — and is unit-testable in Node.
 */

import {
	decryptEnterpriseCredentials,
	PROVIDER_CREDENTIAL_REGISTRY,
	type McpConnection,
} from "./mcp-connections";
import type { BearerKekEnv } from "./mcp-token-crypto";

/**
 * Thrown when {@link resolveOAuthCredentials} exhausts all three resolution
 * steps without finding usable credentials. Callers can catch this distinctly
 * to surface a user-friendly "please configure credentials" message.
 */
export class ProviderCredentialsNotConfiguredError extends Error {
	constructor(public readonly providerType: string) {
		super(`No credentials configured for provider: ${providerType}`);
		this.name = "ProviderCredentialsNotConfiguredError";
	}
}

/**
 * Resolve OAuth credentials for an MCP connection using the three-step chain:
 *
 * 1. **Enterprise BYOC** — if `enterpriseCredentialsEncryptedJson` is non-NULL,
 *    decrypt and return the per-connection credentials (highest priority).
 * 2. **Platform secrets** — if `serverConfig.providerType` is present in
 *    {@link PROVIDER_CREDENTIAL_REGISTRY}, read `env[${PREFIX}_CLIENT_ID]` and
 *    `env[${PREFIX}_CLIENT_SECRET]` and return them alongside the registry's
 *    `defaultScopes`.
 * 3. **Fail closed** — throw {@link ProviderCredentialsNotConfiguredError}.
 */
export async function resolveOAuthCredentials(
	env: BearerKekEnv & Record<string, string | undefined>,
	connection: Pick<
		McpConnection,
		"enterpriseCredentialsEncryptedJson" | "serverConfig"
	>,
): Promise<Record<string, unknown>> {
	// Step 1 — per-connection enterprise credentials (BYOC)
	if (connection.enterpriseCredentialsEncryptedJson !== null) {
		const decrypted = await decryptEnterpriseCredentials(env, connection);
		if (decrypted) return decrypted;
	}

	// Step 2 — platform-level credentials from Workers Secrets
	const providerType = connection.serverConfig?.providerType;
	if (providerType && providerType in PROVIDER_CREDENTIAL_REGISTRY) {
		const registry = PROVIDER_CREDENTIAL_REGISTRY[providerType];
		const clientId = env[`${registry.envPrefix}_CLIENT_ID`];
		const clientSecret = env[`${registry.envPrefix}_CLIENT_SECRET`];
		if (clientId && clientSecret) {
			return {
				clientId,
				clientSecret,
				scopes: connection.serverConfig?.scopes ?? registry.defaultScopes,
			};
		}
	}

	// Step 3 — nothing found, fail closed
	throw new ProviderCredentialsNotConfiguredError(providerType ?? "unknown");
}
