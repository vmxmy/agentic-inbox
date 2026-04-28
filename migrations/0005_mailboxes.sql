-- D1 migration: mailbox directory + membership index.
--
-- Additive control-plane shadow of the per-mailbox R2 ACL blobs in
-- `mailboxes/<id>.json`. PR 3 dual-writes; PR 4 cuts reads over.
--
-- Apply locally with: pnpm wrangler d1 migrations apply DB --local
-- Apply remote with:  pnpm wrangler d1 migrations apply DB --remote

CREATE TABLE IF NOT EXISTS mailboxes (
  -- Mailbox id is the email address, normalized to lowercase. Same value
  -- used as MAILBOX.idFromName(...) in the DO routing.
  id TEXT PRIMARY KEY,
  -- FK to users(id). Nullable because legacy ownerless mailboxes exist;
  -- ON DELETE SET NULL preserves the row when a user account is removed
  -- so an admin can reassign ownership instead of orphaning the inbox.
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalized for join-free reads + bridging the legacy email-keyed ACL
  -- code path. Stays in sync via the mailbox-directory helpers.
  owner_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mailboxes_owner_user_idx
  ON mailboxes(owner_user_id);
CREATE INDEX IF NOT EXISTS mailboxes_owner_email_idx
  ON mailboxes(owner_email);

CREATE TABLE IF NOT EXISTS mailbox_members (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  -- Email is the canonical key — invited members may not yet be registered
  -- users at the time of insert. user_id is best-effort populated when a
  -- matching D1 user exists; backfilled on next touch otherwise.
  email TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  -- Who added this member. Admin grants record the admin's id; invite
  -- acceptance records the inviting owner's id. Nullable for legacy or
  -- system-triggered backfills.
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (mailbox_id, email)
);

CREATE INDEX IF NOT EXISTS mailbox_members_email_idx
  ON mailbox_members(email);
CREATE INDEX IF NOT EXISTS mailbox_members_user_idx
  ON mailbox_members(user_id);
