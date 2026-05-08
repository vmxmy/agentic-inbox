## Context

MCP connections are stored in the `mcp_connections` SQLite table inside each mailbox's Durable Object. The current schema has fixed columns for bearer-token encryption (`encrypted_token_b64`, `token_iv_b64`, `token_salt_b64`, `token_envelope_version`, `token_kek_version`) and a single JSON column (`enabled_tools_json`). There is no mechanism for:

- Storing provider-specific non-sensitive config (scopes, provider type, display metadata).
- Storing BYOC OAuth credentials per connection.
- Resolving platform-level OAuth app credentials from Workers Secrets.

The Cloudflare Agents SDK (`Agent.addMcpServer`) drives the MCP Authorization flow via `MailboxBoundOAuthProvider` (`DurableObjectOAuthClientProvider` subclass). Credentials are injected at server-registration time, before the OAuth redirect begins.

## Goals / Non-Goals

**Goals:**
- Add `server_config_json` (plaintext) for non-sensitive provider metadata — zero migration per new provider.
- Add `enterprise_credentials_encrypted_json` (encrypted blob) for BYOC credentials using the existing three-layer key envelope.
- Add platform-level credential resolution: Workers Secrets → enterprise column → error.
- Google People API MCP server (`https://people.googleapis.com/mcp/v1`) works via UI with zero code changes after this feature lands.
- Existing bearer and generic OAuth connections are unaffected (all new columns are nullable).

**Non-Goals:**
- Token refresh logic (handled by SDK).
- Multi-provider credential federation or credential rotation UI.
- Syncing contacts locally / autocomplete in compose UI (separate capability).
- Support for CardDAV (different auth model — future change).

## Decisions

### D1: Two columns, not one

**Decision**: Separate `server_config_json` (plaintext) from `enterprise_credentials_encrypted_json` (encrypted) rather than one unified encrypted blob.

**Rationale**: Non-sensitive config (scopes, providerType) is needed frequently for display and routing logic. Decrypting a blob for every read is wasteful. Sensitive fields (clientSecret) must always be encrypted. Separating them makes the access pattern explicit and auditable.

**Alternative considered**: Single `config_encrypted_json` blob — rejected because it encrypts non-sensitive data unnecessarily and adds decryption overhead to read-only display paths.

### D2: Reuse existing encryption infrastructure

**Decision**: `enterprise_credentials_encrypted_json` uses the same `encryptBearerToken` / `decryptBearerToken` functions with a JSON-serialized payload.

**Rationale**: The existing three-layer key envelope (DEK + KEK + versioning) already provides the security properties needed. Introducing a parallel encryption path would duplicate key management and audit surface.

### D3: Platform credentials via Workers Secrets, not DB

**Decision**: Operator-level OAuth app credentials (`GOOGLE_CONTACTS_CLIENT_ID`, `GOOGLE_CONTACTS_CLIENT_SECRET`, etc.) live in Workers Secrets bound to `Env`, never in the DB.

**Rationale**: Platform credentials serve all users — storing them per-row would replicate them across every connection row. Workers Secrets are encrypted at rest by Cloudflare and rotatable without DB migrations. This maps to standard SaaS practice (Zapier, Linear, Notion all use platform-level OAuth app registration).

### D4: Credential resolution order

```
resolveOAuthCredentials(connection, env):
  1. enterprise_credentials_encrypted_json (per-connection BYOC) → highest priority
  2. env.GOOGLE_CONTACTS_CLIENT_ID / _SECRET (platform-level)
  3. throw ProviderCredentialsNotConfiguredError
```

This allows enterprise tenants to override platform credentials without any special flags.

### D5: `server_config_json` schema is provider-typed

```typescript
type ServerConfig =
  | { providerType: "google-contacts"; scopes: string[]; [k: string]: unknown }
  | { providerType: "microsoft-graph"; scopes: string[]; tenantId?: string; [k: string]: unknown }
  | { providerType: "generic"; [k: string]: unknown }
```

`providerType` drives which env-var prefix to look up. Unknown provider types fall through to `generic` (no platform credentials, enterprise BYOC only).

## Risks / Trade-offs

- **[Risk] Enterprise credential decryption on every tool call** → Mitigation: Cache decrypted credentials in Durable Object memory (DO lifetime = request lifetime for most flows); re-decrypt only after DO eviction.
- **[Risk] Workers Secrets key naming collisions across providers** → Mitigation: Enforce `{PROVIDER_SCREAMING_SNAKE}_CLIENT_ID` convention; document in operator runbook.
- **[Risk] `server_config_json` schema drift** → Mitigation: Validate against a Zod discriminated union at write time; unknown fields pass through (open schema).
- **[Risk] Migration on existing rows** → Mitigation: Both new columns are `NULL`-default; no backfill required. Existing connections continue working unchanged.

## Migration Plan

1. Add Drizzle migration: `ALTER TABLE mcp_connections ADD COLUMN server_config_json TEXT; ALTER TABLE mcp_connections ADD COLUMN enterprise_credentials_encrypted_json TEXT;`
2. Deploy worker with new columns (reads tolerate `NULL` gracefully).
3. No data backfill needed — existing connections default to `NULL` (generic provider, platform credentials only).
4. **Rollback**: Columns can be ignored by reverting the worker; SQLite `ALTER TABLE DROP COLUMN` is available for full cleanup if needed.

## Open Questions

- Should `providerType` be enforced as an enum at the API layer, or remain open for third-party MCP servers? Current decision: open with known values for type-narrowing only.
- Should the UI surface enterprise credential fields behind a feature flag or a plan tier check? TBD by product — the backend supports it either way.
