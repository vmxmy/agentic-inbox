-- D1 migration: LLM provider registry for the admin Settings → System tab.
-- Apply locally with: pnpm wrangler d1 migrations apply DB --local
-- Apply remote with:  pnpm wrangler d1 migrations apply DB --remote

CREATE TABLE IF NOT EXISTS llm_providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  api_key       TEXT NOT NULL,
  default_model TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- At most one row may carry is_default=1 at any moment. The CRUD layer
-- writes (set all to 0, then set target to 1) inside a single batch to keep
-- this invariant; the partial-unique index enforces it as a hard rail.
CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_one_default_idx
  ON llm_providers(is_default)
  WHERE is_default = 1;
