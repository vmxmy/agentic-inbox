-- D1 migration: admin-managed team/user mailbox model.
--
-- Additive control-plane tables for team primary addresses
-- (`team@root-domain`) and team-user addresses (`team.user@root-domain`).
-- The full address remains the transitional MailboxDO/mailbox_id identity.
-- Existing owner/member mailbox rows are left untouched.

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  primary_address TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_active_idx
  ON teams(slug)
  WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teams_primary_address_active_idx
  ON teams(primary_address)
  WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS teams_created_by_idx
  ON teams(created_by_user_id);

CREATE TABLE IF NOT EXISTS team_users (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS team_users_team_slug_active_idx
  ON team_users(team_id, slug)
  WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_users_user_active_idx
  ON team_users(user_id)
  WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS team_users_mailbox_address_active_idx
  ON team_users(mailbox_address)
  WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS team_users_team_idx
  ON team_users(team_id);
CREATE INDEX IF NOT EXISTS team_users_created_by_idx
  ON team_users(created_by_user_id);

CREATE TABLE IF NOT EXISTS address_registry (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'team_user', 'legacy_fixed')),
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  team_user_id TEXT REFERENCES team_users(id) ON DELETE CASCADE,
  -- Transitional identity: today this is the full email address passed to
  -- MAILBOX.idFromName(...). Future work can move this to an inbox id.
  mailbox_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE INDEX IF NOT EXISTS address_registry_mailbox_idx
  ON address_registry(mailbox_id);
CREATE INDEX IF NOT EXISTS address_registry_team_idx
  ON address_registry(team_id);
CREATE INDEX IF NOT EXISTS address_registry_team_user_idx
  ON address_registry(team_user_id);
CREATE INDEX IF NOT EXISTS address_registry_kind_active_idx
  ON address_registry(kind, active);
