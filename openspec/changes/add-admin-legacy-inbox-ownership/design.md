# Design: Admin legacy inbox ownership assignment

## Context

Phase 2 intentionally gates structured Agent / Tools / Safety configuration to
inboxes with `userOwnedInbox` metadata. That prevents shared or legacy inboxes
from being modified by any Access-authenticated user, but production has legacy
mailboxes created before the user-owned inbox flow existed.

The current system stores mailbox settings in R2 under
`mailboxes/<address>.json`; mailbox-local state remains in MailboxDO keyed by the
full email address. The MVP must stay on this Cloudflare-native baseline.

## Goals

- Let an administrator migrate existing legacy inboxes into the user-owned
  control model one inbox at a time.
- Make ownership assignment explicit and auditable.
- Preserve existing mailbox address, emails, attachments, folders, and settings.
- Reuse the existing user-owned inbox visibility and config authorization rules
  after assignment.
- Keep ordinary users unable to claim or reassign legacy inboxes.

## Non-Goals

- Do not introduce D1/address registry in this slice.
- Do not infer owners automatically from email contents or display names.
- Do not support multi-owner teams or org roles in this slice.
- Do not rename the existing legacy inbox address.
- Do not delete or migrate Durable Object data.

## Decisions

### Admin authority

Use the existing verified request identity as the principal and define admin
membership from the `ADMINS` environment variable. The helper should normalize
emails case-insensitively and fail closed when there is no verified identity.

This matches the current deployment model and avoids adding an auth database
before we need organization-level roles.

### Assignment data shape

Persist the same `userOwnedInbox` shape used by newly created inboxes, but adapt
it for legacy addresses:

- `ownerEmail`: assigned owner email
- `username`: stable username derived/stored through existing user metadata
- `subname`: admin-provided logical subname for product grouping
- `rootDomain`: current configured root domain
- `address`: existing mailbox email address

The existing email address remains canonical. For a legacy address that is not
already `username.subname@root-domain`, the metadata describes ownership and UI
semantics, not a request to rename the address.

### Conflict handling

Ownership assignment MUST use optimistic concurrency on the R2 settings object
etag. If the mailbox settings changed after the admin loaded the page, the write
returns a conflict and asks the admin to reload.

### Ownership replacement

The first implementation includes owner replacement for already user-owned
inboxes. Replacement MUST be an explicit admin action, require confirmation in
the UI, use the same R2 etag precondition as first-time assignment, and write an
audit entry that records previous owner and next owner. Owner replacement must
not modify the existing mailbox address, MailboxDO state, agent/tool/safety
configuration, folders, emails, or attachments.

### UI scope

Create a simple admin migration UI rather than hiding this in the ordinary
settings page:

- list legacy inboxes lacking `userOwnedInbox` by default
- show current address/display name/status
- assign owner email and logical subname
- expose already owned inboxes behind a separate filter for explicit owner replacement
- require confirmation before first-time assignment or replacement

After assignment, the owner should see the inbox in normal mailbox lists and the
settings page should show Agent / Tools / Safety controls.

## Risks / Trade-offs

- `ADMINS` env is simple but not a full RBAC model. This is acceptable for the
  current single-deployment owner/admin phase.
- Legacy address may not match `username.subname@root-domain`. We preserve the
  real address to avoid breaking Email Routing, DO keys, and existing messages.
- Admin mistakes can expose an inbox to the wrong owner. Mitigation: explicit
  confirmation, audit entries, and no bulk auto-assignment in this slice.

## Migration Plan

1. Add admin-only read endpoints to inspect legacy inboxes.
2. Add a constrained admin assignment endpoint that merges owner metadata into
   R2 settings using etag preconditions.
3. Add a minimal admin UI to assign owner email and logical subname.
4. Verify the assigned owner can see the inbox and access structured config.
5. Use the UI manually for production legacy inboxes.

## Open Questions

None for the first implementation. Owner replacement is included, and a
confirmation dialog is sufficient for the MVP admin UI.
