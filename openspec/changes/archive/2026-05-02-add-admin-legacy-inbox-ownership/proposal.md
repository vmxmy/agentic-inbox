# Change: Admin assigns ownership to legacy inboxes

## Why

Only user-created inboxes currently expose structured Agent / Tools / Safety
settings because legacy mailboxes lack `userOwnedInbox` owner metadata. This is
safe, but it leaves existing production inboxes stuck on the legacy prompt-only
settings experience.

We need an administrator migration path that assigns explicit ownership to
existing inboxes without rewriting mailbox contents or requiring per-inbox
Cloudflare dashboard changes.

## What Changes

- Add an admin-only legacy inbox ownership assignment flow.
- Let an admin view legacy inboxes that lack `userOwnedInbox` metadata.
- Let an admin assign owner metadata to a legacy inbox, and explicitly replace
  owner metadata for an already owned inbox when needed.
- Persist ownership additively in the existing R2 mailbox settings document.
- Preserve the existing mailbox address, MailboxDO storage, emails,
  attachments, and settings during ownership assignment.
- After assignment, expose the inbox to the assigned owner using the same
  user-owned inbox access and Agent / Tools / Safety config rules.
- Record an audit entry for ownership assignments and ownership changes.

## What Does Not Change

- No D1/address-registry migration in this slice.
- No Cloudflare Email Routing dashboard changes or per-inbox routes.
- No automatic owner guessing for legacy inboxes.
- No ordinary-user self-claim flow for legacy inboxes.
- No mailbox data deletion, DO migration, or attachment movement.
- No full organization/team multi-tenancy.

## Impact

- Affected specs:
  - `user-owned-ai-inboxes`
- Affected frontend:
  - new or extended admin route/component for legacy inbox ownership assignment
  - simple admin route at `/admin/legacy-inboxes` for assignment and replacement
- Affected worker/API:
  - admin identity helper based on verified request identity and `ADMINS`
  - admin-only endpoints for listing legacy/owned inboxes and assigning or replacing ownership
  - R2 settings merge helper for ownership metadata
  - audit helper for owner assignment events
- Affected data:
  - additive `userOwnedInbox` metadata on existing `mailboxes/<address>.json`
  - optional ownership audit records in R2
- Verification:
  - OpenSpec validation
  - typecheck and build
  - helper verification for admin detection, metadata merge, and conflict cases
  - browser/API E2E for admin assigning a legacy inbox and owner seeing Tools / Safety
