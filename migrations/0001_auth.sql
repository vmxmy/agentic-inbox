-- D1 migration: native auth tables (users, sessions, email_tokens).
-- Apply locally with: pnpm wrangler d1 migrations apply DB --local
-- Apply remote with:  pnpm wrangler d1 migrations apply DB --remote

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at INTEGER,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_hash_idx ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_tokens_user_purpose_idx ON email_tokens(user_id, purpose);
