## Why

Current code already lets an Access-authenticated operator create arbitrary
mailboxes from the home page. That is useful for the official single-team demo,
but it is not yet the product model we agreed on.

The product model is: a human user owns multiple AI inboxes under a governed
namespace, and ordinary user-created addresses are generated as
`username.subname@root-domain`. The server, not the browser, must derive that
address from the verified login identity and the user-entered `subname`.

This change refines the existing generic mailbox creation flow into a
user-owned AI inbox creation flow while preserving the official baseline's R2
settings, MailboxDO, Cloudflare Access, and Email Routing architecture.

## What Changes

- Reuse the existing home-page create flow, mailbox APIs, R2 mailbox settings,
  InboxProfile adapter, MailboxDO storage, and inbound resolver.
- Add a server-side Access identity helper that extracts the verified user email
  from Cloudflare Access JWT claims after existing Access verification.
- Derive a stable username from the verified user email and persist it in R2
  account metadata for this MVP.
- Change ordinary user inbox creation so the client submits only `displayName`
  and `subname`; the server derives `username.subname@root-domain`.
- Validate `subname` and reserve system/global names so ordinary users cannot
  claim arbitrary short aliases such as `support@root-domain`.
- Store user-owned inbox metadata additively in the R2 mailbox settings document
  alongside the existing `inboxProfile`.
- Update the frontend copy and form from arbitrary "Create Mailbox" address
  entry to product-facing "Create AI Inbox" with a generated address preview.
- Keep existing arbitrary mailbox creation compatibility for fixed configured
  mailboxes / future admin flows; do not remove legacy records.
- Keep inbound resolution R2-backed for this slice; do not introduce D1 or a new
  control-plane database in this official-baseline worktree.

## What Does Not Change

- No D1 migrations in this slice.
- No organizations, billing, custom domains, or admin dashboard.
- No MailboxDO identity migration; `mailboxId = full email address` remains the
  transitional storage key.
- No per-inbox Cloudflare Email Routing rule creation. Catch-all routing still
  lands in the Worker and the Worker resolves registered inboxes.
- No broad AgentProfile / ToolCapability UI in this slice.

## Capabilities

### New Capabilities

- `user-owned-ai-inboxes`: A logged-in user can create and list multiple AI
  inboxes with `displayName`, `subname`, generated username, and derived email
  address.
- `inbound-address-resolution`: Inbound Cloudflare Email Routing recipients are
  resolved against registered inbox profile state before mail is persisted.

### Modified Capabilities

- `multi-inbox-runtime`: User-owned inbox metadata extends the existing
  R2-backed InboxProfile/mailbox runtime without replacing MailboxDO storage.

## Impact

- Affected frontend:
  - `app/routes/home.tsx`
  - `app/services/api.ts`
  - `app/queries/mailboxes.ts`
  - `app/types/index.ts`
- Affected worker/API:
  - `workers/app.ts` Access claim handling
  - `workers/index.ts` mailbox/inbox creation and listing routes
  - `workers/lib/inbox-profile.ts` metadata helpers and address derivation
  - optional new focused helper module under `workers/lib/`
- Affected data:
  - R2 account metadata under a new additive prefix such as `users/<email>.json`
  - R2 mailbox settings under existing `mailboxes/<email>.json`
- Affected tests/verification:
  - compile-only or helper verification for username derivation, subname
    validation, address derivation, duplicate handling, and legacy compatibility
  - browser E2E for create-inbox UI
  - inbound resolver verification for known/unknown addresses
