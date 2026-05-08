## Why

The current pending product model is user-owned (`username.subname@root-domain`), but the requested operating model is team-owned: admins create teams and users, teams own the top-level workspace mailbox, and user inbox addresses are derived inside the team namespace.

This change replaces arbitrary/admin-managed mailbox provisioning with a governed team/user model that prevents alias squatting, makes ownership explicit, and keeps address creation server-derived.

## What Changes

- **BREAKING**: Supersede the pending `add-user-owned-ai-inbox-creation` direction where ordinary users create their own `username.subname@root-domain` inboxes.
- Add teams as first-class control-plane records managed by admins.
- Derive each team's primary mailbox as `teamName@root-domain` using the configured root domain; examples may use `teamName@example.com`, but runtime uses configured `DOMAINS` unless later custom-domain support is added.
- Add admin-created users scoped to a team.
- Derive each team user's mailbox identity as `team.user@ziikoo.com`-style `teamName.userName@root-domain`.
- Remove self-serve mailbox/inbox creation from ordinary users for this model.
- Replace owner/member mailbox administration UX with admin-created teams and users; mailbox access follows team membership and user identity.
- Keep `MailboxDO` addressed by full email as a transitional storage name for this slice.
- Preserve inbound catch-all routing: known team or team-user addresses resolve through D1 control-plane state; unknown addresses do not auto-create records.
- Preserve existing legacy mailboxes during migration until they are backfilled or explicitly converted.

## Capabilities

### New Capabilities

- `team-user-mailbox-model`: Admins create teams and users; teams have primary mailboxes; user mailboxes are derived from team/user names.
- `team-address-resolution`: Inbound and API address resolution accepts only active team primary and team-user addresses from application state.

### Modified Capabilities

- None. There are no archived baseline OpenSpec capabilities yet. This change does supersede the active-but-unimplemented `add-user-owned-ai-inbox-creation` proposal.

## Impact

- Affected frontend:
  - Home/mailbox list and creation flow
  - Admin screen for creating teams and users
  - Settings members/owner UI, which becomes read-only or is replaced by team membership views
  - API client methods and query keys for teams/users
- Affected worker/API:
  - Auth/user repository and admin routes
  - Mailbox creation/provisioning routes
  - Mailbox ACL helpers
  - Inbound recipient resolution
  - MCP and `/agents/*` ACL checks that currently depend on owner/member ACL
- Affected data:
  - Additive D1 team table
  - Additive D1 user/team membership fields or relation table
  - Additive D1 mailbox/address metadata tying addresses to teams/users
  - Migration/backfill path for existing `blueyang@gmail.com` and legacy mailboxes
- Affected tests:
  - Team/user name validation
  - Server-derived address behavior
  - Admin-only team/user creation
  - Inbound known/unknown address resolution
  - ACL checks for team primary and team-user mailboxes
- Cloudflare constraints:
  - Still no per-address Email Routing rules
  - Catch-all Email Routing resolves recipients through D1
  - Current root domain comes from `DOMAINS` and is `ziikoo.com` in this repo config
