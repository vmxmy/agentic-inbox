## Why

Agentic Inbox currently treats a mailbox as an arbitrary email address. That is
not enough for the product model we have agreed on: a human user should own
multiple independent AI inbox entities, each with its own address, work context,
agent behavior, and future collaboration boundary.

This change creates the first product slice for that model while preserving a
safe migration path from the existing mailbox implementation.

## What Changes

- Add generated, stable usernames for authenticated users.
- Add a product-facing AI inbox creation flow using `displayName` and `subname`.
- Derive ordinary user inbox addresses on the server as
  `username.subname@root-domain`.
- Validate `subname` with governed address rules.
- Persist inbox metadata needed for product display and future address registry
  migration.
- Update the UI from arbitrary "Create Mailbox" prefix entry to "Create AI
  Inbox" with a fixed username/root-domain preview.
- Move inbound mailbox existence resolution toward D1 control-plane state
  instead of legacy R2 mailbox blob checks.
- Keep existing `MailboxDO` and `mailboxId = full email address` as a
  transitional implementation detail for this slice.
- Do not add full organizations, custom domains, global alias requests, billing,
  or operations dashboards in this change.

## Capabilities

### New Capabilities

- `user-owned-ai-inboxes`: A logged-in user can create and list multiple AI
  inbox entities with `displayName`, `subname`, generated username, and derived
  email address.
- `inbound-address-resolution`: Inbound Cloudflare Email Routing recipients are
  resolved against application-owned inbox/address state before mail is
  persisted.

### Modified Capabilities

- None. There are no existing OpenSpec capabilities yet.

## Impact

- Affected frontend:
  - home/inbox list creation flow
  - API client methods and query hooks
  - displayed language from mailbox-first to inbox-first where user-facing
- Affected worker/API:
  - user identity helpers
  - inbox/mailbox creation route
  - mailbox directory metadata
  - inbound email recipient resolution
- Affected data:
  - D1 user username field or username table
  - D1 inbox metadata or mailbox profile table
  - potential backfill for existing users/mailboxes
- Affected tests:
  - username generation
  - subname validation
  - derived address creation
  - duplicate handling
  - inbound known/unknown address behavior
- Cloudflare constraints:
  - no per-inbox Email Routing rule creation
  - dynamic addresses remain catch-all -> Worker -> D1/application resolution

