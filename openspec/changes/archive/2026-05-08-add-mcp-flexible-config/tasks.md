## 1. Database Schema Migration

- [x] 1.1 Add `server_config_json TEXT` (nullable) column to `mcp_connections` table in `workers/db/schema.ts`
- [x] 1.2 Add `enterprise_credentials_encrypted_json TEXT` (nullable) column to `mcp_connections` table in `workers/db/schema.ts`
- [x] 1.3 Write Drizzle migration file for both new columns
- [x] 1.4 Verify migration runs cleanly against existing test databases

## 2. Provider Config Types & Validation

- [x] 2.1 Define `ServerConfig` discriminated union type in `workers/lib/mcp-connections.ts` (`providerType`: `"google-contacts"` | `"microsoft-graph"` | `"generic"`)
- [x] 2.2 Add Zod schema for `ServerConfig` with open passthrough for unknown keys
- [x] 2.3 Add `PROVIDER_CREDENTIAL_REGISTRY` static map: `providerType` → env-var prefix + default scopes
- [x] 2.4 Extend `McpConnectionBaseBody` in `workers/index.ts` with optional `serverConfig` field
- [x] 2.5 Extend `McpConnectionBaseBody` with optional `enterpriseCredentials` field (gated by KEK check)

## 3. Encryption Layer Extension

- [x] 3.1 Extract a generic `encryptJson(env, payload: object)` / `decryptJson(env, ciphertext)` helper that wraps the existing bearer-token encryption in `workers/lib/mcp-connections.ts`
- [x] 3.2 Use `encryptJson` to encrypt `enterpriseCredentials` at write time and store result in `enterprise_credentials_encrypted_json`
- [x] 3.3 Add `decryptEnterpriseCredentials(env, connection)` helper that decrypts and parses the column, returning `null` when the column is NULL

## 4. Credential Resolution Layer

- [x] 4.1 Create `workers/lib/mcp-credential-resolver.ts` with `resolveOAuthCredentials(env, connection)` implementing the three-step priority chain (enterprise → platform secrets → error)
- [x] 4.2 Implement `ProviderCredentialsNotConfiguredError` custom error class
- [x] 4.3 Add unit tests for credential resolution: enterprise override wins, platform fallback, missing credentials error, generic provider skip

## 5. Agent OAuth Flow Integration

- [x] 5.1 Inject `resolveOAuthCredentials` into `addExternalOAuthMcpServer` in `workers/agent/index.ts` before calling `this.addMcpServer`
- [x] 5.2 Extend `MailboxBoundOAuthProvider` (or its factory) to accept resolved `clientId` / `clientSecret` / `scopes`
- [x] 5.3 Propagate resolved scopes into the OAuth Authorization request
- [x] 5.4 Handle `ProviderCredentialsNotConfiguredError` in the agent runtime: log and skip the connection rather than crashing
- [x] 5.5 Ensure DO restore path (`_restoreRpcMcpServers` equivalent for HTTP servers) also calls credential resolution

## 6. API & Persistence Layer

- [x] 6.1 Update `addExternalMcpServer` input type (`AddExternalMcpServerInput`) to carry `serverConfig` and encrypted enterprise credentials blob
- [x] 6.2 Update `upsertMcpConnection` in the Durable Object to persist both new columns
- [x] 6.3 Update `PublicMcpConnection` DTO to expose `serverConfig` (non-sensitive) but omit enterprise credentials
- [x] 6.4 Update `POST /api/v1/mailboxes/:mailboxId/mcp-connections` route to parse, validate, and forward both new fields

## 7. Worker Environment Bindings

- [x] 7.1 Add optional `GOOGLE_CONTACTS_CLIENT_ID`, `GOOGLE_CONTACTS_CLIENT_SECRET` to `Env` type in `workers/lib/env.ts` (or equivalent)
- [x] 7.2 Add optional `MICROSOFT_GRAPH_CLIENT_ID`, `MICROSOFT_GRAPH_CLIENT_SECRET`, `MICROSOFT_GRAPH_TENANT_ID`
- [x] 7.3 Update `wrangler.toml` / deployment docs with new optional secret names

## 8. Tests

- [x] 8.1 Add migration test verifying both new columns exist and are nullable
- [x] 8.2 Add integration test: add Google Contacts connection with `serverConfig`, verify `server_config_json` persisted
- [x] 8.3 Add integration test: add connection with `enterpriseCredentials`, verify column encrypted and plaintext absent
- [x] 8.4 Add agent test: connection with missing platform credentials is skipped, other tools still available
- [x] 8.5 Add agent test: connection with platform credentials resolves and reaches `ready` state

## 9. Operator Documentation

- [x] 9.1 Document the `PROVIDER_SCREAMING_SNAKE_CLIENT_ID` naming convention in operator runbook
- [x] 9.2 Document Google People API MCP server setup steps (Cloud Console → enable API → OAuth consent → Web App credentials → set Workers Secrets)
