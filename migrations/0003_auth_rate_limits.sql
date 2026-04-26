-- D1 migration: rate-limit counters for auth endpoints (magic-link, etc).
-- Apply locally with: pnpm wrangler d1 migrations apply DB --local
-- Apply remote with:  pnpm wrangler d1 migrations apply DB --remote

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_expires_idx ON auth_rate_limits(expires_at);
