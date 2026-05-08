## Context

The current implementation has three overlapping models:

- The production code stores mailbox identity as a full email address in the D1
  mailbox directory and uses that full email as the `MailboxDO` name.
- Admin/member ACL is currently expressed as one owner plus optional members per
  mailbox.
- The active but unimplemented `add-user-owned-ai-inbox-creation` OpenSpec
  proposal describes ordinary users owning `username.subname@root-domain`
  inboxes.

The requested model is different: admins should operate a team directory. A team
owns a top-level mailbox (`teamName@root-domain`), and team users receive
server-derived addresses (`teamName.userName@root-domain`). Ordinary users do not
choose or create inbox namespaces.

Cloudflare constraints remain unchanged: Email Routing should stay catch-all,
unknown inbound addresses must not auto-create records, D1 is the global control
plane, and `MailboxDO` remains the serialized mailbox-local state owner for this
slice.

## Goals / Non-Goals

**Goals:**

- Add team as a first-class admin-managed control-plane entity.
- Add team users as admin-managed accounts under exactly one team for the MVP.
- Derive all new team and team-user mailbox addresses on the server.
- Replace self-serve mailbox creation with admin create-team and create-user
  workflows.
- Make access derivable from team membership rather than manual mailbox
  owner/member editing.
- Resolve inbound recipients through active team address records in D1.
- Keep existing `MailboxDO` and `mailboxId = full email address` behavior as a
  transitional storage implementation.
- Keep legacy mailboxes visible/usable for existing ACL records until explicitly
  migrated.

**Non-Goals:**

- Custom domains per team.
- Multi-team membership per user.
- Team roles beyond global admin and ordinary team user.
- User self-registration for team-scoped users.
- User-chosen global aliases such as `finance@` outside the admin-created team
  namespace.
- Migrating `MailboxDO` identity from full email to stable `inbox_id`.
- Billing, SSO/SAML, or organization hierarchy beyond teams.

## Decisions

### Decision: Team and user slugs are server-governed address components

The system stores normalized `teamName` and `userName` slugs. The team primary
address is derived as `teamName@root-domain`; the user mailbox address is
derived as `teamName.userName@root-domain`.

The root domain comes from configured `DOMAINS`; the current repo configuration
uses `ziikoo.com`. The request's `teamName@example.com` is treated as an example
shape unless custom domains are later specified.

Alternatives considered:

- Let admins type full email addresses: rejected because it reintroduces
  arbitrary mailbox aliases and inconsistent access rules.
- Keep using user email local-parts as usernames: rejected because the requested
  model makes the team namespace authoritative.

### Decision: Add explicit team control-plane tables

Additive D1 tables should represent teams, team users, and active addresses.
Recommended MVP shape:

- `teams`: `id`, `slug`, `display_name`, `primary_address`, `created_by_user_id`,
  `created_at`, `updated_at`, `disabled_at`.
- `team_users`: `id`, `team_id`, `user_id`, `slug`, `mailbox_address`,
  `created_by_user_id`, `created_at`, `updated_at`, `disabled_at`.
- `address_registry`: `address`, `kind`, `team_id`, `team_user_id`,
  `mailbox_id`, `active`, timestamps.

`address_registry.mailbox_id` should remain the full email address in this slice
so existing `MailboxDO` call sites continue working. The table creates a seam
for a future `address -> inbox_id` migration.

Alternatives considered:

- Add only columns to existing `mailboxes`: rejected for MVP because a single
  mailbox row cannot cleanly express team primary vs team-user identity or
  future address registry behavior.
- Reuse `mailbox_members` as the team model: rejected because membership rows do
  not represent team identity, user mailbox addresses, or inbound address
  activation.

### Decision: Admin creates users, not mailboxes

Global admins create a team, then create users under that team. Creating a team
provisions the team primary mailbox record. Creating a user provisions the D1
user record, the team-user relation, and the user's derived mailbox record.

The existing user table remains the login identity table. For admin-created team
users, `users.email` is the derived `teamName.userName@root-domain` address.
`displayName` remains separate from address slugs.

Alternatives considered:

- Keep public registration and assign a team afterward: deferred because the
  request says admins should only create teams and users.
- Create mailbox records first and later attach users: rejected because it keeps
  the old mailbox-first admin model.

### Decision: Access is computed from team state

Global admins retain access to every mailbox. A team user has access to:

- the team primary mailbox for their team, and
- their own `teamName.userName@root-domain` mailbox.

Manual owner/member editing should not be the primary path for team-managed
mailboxes. Existing owner/member ACL continues only for legacy records or during
migration compatibility.

Alternatives considered:

- Add every team user as a member of the team primary mailbox: acceptable as an
  implementation shortcut, but it must be treated as a compatibility mirror, not
  the source of truth.
- One owner per team mailbox: rejected for MVP because the requested admin model
  avoids per-mailbox owner administration.

### Decision: Centralize recipient resolution

Inbound email and API mailbox lookup should call one resolver that normalizes an
address, checks configured domain, consults `address_registry`, and returns the
active `mailboxId` plus address kind. Unknown recipients must not create teams,
users, or mailboxes.

Alternatives considered:

- Continue checking legacy R2 mailbox blobs: rejected for new team/user
  addresses because D1 is the source of truth.
- Infer valid addresses from local-part syntax alone: rejected because attackers
  could send to arbitrary `team.user@root-domain` addresses and force storage.

## Risks / Trade-offs

- Existing active proposal conflict -> This change must explicitly supersede
  `add-user-owned-ai-inbox-creation` before implementation starts.
- Domain ambiguity -> MVP uses the first configured `DOMAINS` entry as the root
  domain; custom per-team domains remain out of scope.
- ACL migration risk -> Keep legacy owner/member fallback for old mailbox rows
  while team-managed rows use team-derived access checks.
- Login delivery risk -> Admin-created users may need password setup or magic
  link flows. Reuse existing email token/password reset mechanisms rather than
  inventing a new credential system.
- UI churn -> Replace mailbox self-creation with admin team/user screens in the
  smallest pass; defer rich team management dashboards.
- Transitional identity risk -> Full email remains `MailboxDO` name; document
  it as transitional and keep address registry ready for future stable ids.

## Migration Plan

1. Add D1 migrations for `teams`, `team_users`, and `address_registry`.
2. Add validation helpers for team/user slugs and derived address generation.
3. Add admin APIs for create/list teams and create/list team users.
4. Change ordinary mailbox creation to deny self-serve creation in team mode.
5. Seed mailbox directory rows and `MailboxDO` settings when creating teams and
   users.
6. Add team-aware access helpers and route existing ACL checks through them.
7. Add centralized inbound address resolution using `address_registry` first and
   legacy mailbox rows only for compatibility.
8. Update frontend home/admin/settings flows for admin-created teams/users.
9. Backfill existing `blueyang@gmail.com` as the global admin only; do not force
   it into a team unless an admin explicitly creates one.
10. Add tests and run typecheck/build.

Rollback strategy:

- New D1 tables are additive.
- Existing mailbox rows and owner/member ACL remain in place.
- If team-mode APIs fail, disable the new UI routes and keep legacy admin access
  to existing mailboxes while fixing the team resolver.

## Open Questions

- Should the team primary example be literally `teamName@example.com`, requiring
  custom team domains, or should MVP derive `teamName@ziikoo.com` from
  configured `DOMAINS`?
- Should team users be allowed to access other users' `team.user@root-domain`
  mailboxes, or only the team primary mailbox plus their own mailbox?
- Should admin-created users receive an invite/magic-link email immediately, or
  should the admin copy a setup link from the UI?
