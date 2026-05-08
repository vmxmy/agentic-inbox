## Why

The current MCP connection model hard-codes a fixed column set (`url`, `name`, `auth_type`, bearer token fields) that cannot accommodate provider-specific OAuth configuration (scopes, client credentials, tenant IDs). Adding support for each new contact or data provider requires a schema migration. The operator has no first-class way to supply platform-level OAuth credentials, forcing end users to manually enter `client_id` / `client_secret` — a pattern that degrades UX and violates SaaS security hygiene.

## What Changes

- Add `server_config_json` column to `mcp_connections` table — stores non-sensitive, provider-specific configuration (provider type, scopes, display metadata) as a plain JSON blob.
- Add `enterprise_credentials_encrypted_json` column to `mcp_connections` table — stores BYOC credentials (client_id, client_secret, tenant_id, etc.) as an encrypted JSON blob, using the existing three-layer key envelope. `NULL` means "use platform credentials".
- Add platform-level credential resolution: operator supplies provider credentials via Workers Secrets (e.g. `GOOGLE_CONTACTS_CLIENT_ID`). The OAuth flow resolves credentials in priority order: enterprise column → platform secrets → error.
- **No breaking change** to the existing bearer-token or generic OAuth flows; new columns are nullable and additive.

## Capabilities

### New Capabilities

- `mcp-provider-config`: Per-connection JSON configuration blob and per-connection enterprise credential override, enabling zero-migration extensibility for any MCP provider.
- `platform-oauth-credentials`: Operator-level credential resolution layer that lets the platform register OAuth apps once and serve all users transparently.

### Modified Capabilities

- `multi-agent-runtime`: OAuth token acquisition now consults the credential resolution layer (platform secrets → enterprise override) before initiating the MCP Authorization flow.

## Impact

- **DB schema**: `mcp_connections` table gains two nullable columns; one additive migration.
- **Encryption layer**: `enterprise_credentials_encrypted_json` reuses the existing `encryptBearerToken` / `decryptBearerToken` infrastructure with a JSON-serialized payload.
- **Worker env**: New optional `GOOGLE_CONTACTS_CLIENT_ID`, `GOOGLE_CONTACTS_CLIENT_SECRET` (and equivalents for other providers) added to `Env` bindings.
- **Agent OAuth flow** (`workers/agent/index.ts`, `workers/lib/mcp-oauth-provider.ts`): credential resolution injected before `addMcpServer` call.
- **API schema** (`PostMcpConnectionBody`): optional `serverConfig` and `enterpriseCredentials` fields added.
- **UI** (`ConnectedApps`): no change for standard users; enterprise credential fields surfaced conditionally for BYOC tenants.
