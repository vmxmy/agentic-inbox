-- D1 migration: API keys for MCP / programmatic access.
-- Apply locally with: pnpm wrangler d1 migrations apply DB --local
-- Apply remote with:  pnpm wrangler d1 migrations apply DB --remote

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Human label shown in UI (e.g. "Claude Code on laptop").
  name TEXT NOT NULL,
  -- First 8 chars of the raw key shown in UI so users can identify it
  -- without revealing the secret. Indexed for narrow scans during verify.
  prefix TEXT NOT NULL,
  -- SHA-256 of the full raw key. Primary lookup field at verify time.
  key_hash TEXT NOT NULL UNIQUE,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(prefix);
