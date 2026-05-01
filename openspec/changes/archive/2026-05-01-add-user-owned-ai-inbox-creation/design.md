## Context

I re-read the current official-baseline worktree before refining this design.
The current code facts are:

- Production auth is Cloudflare Access JWT validation in `workers/app.ts`.
- The app currently verifies Access but does not expose the verified user email
  to downstream API handlers.
- There is no D1 binding and no global D1 control plane in this worktree.
- Mailbox existence and settings are stored in R2 at `mailboxes/<email>.json`.
- `InboxProfile` is an additive adapter over that R2 settings document.
- `MailboxDO` owns inbox-local email/folder/attachment metadata state using
  Durable Object SQLite.
- The home page already has a generic `Create Mailbox` dialog that sends a full
  email address to `POST /api/v1/mailboxes`.
- If `EMAIL_ADDRESSES` is empty, the current backend allows arbitrary mailbox
  address creation by any Access-authorized user.
- If `EMAIL_ADDRESSES` is non-empty, the current home page hides arbitrary
  creation and auto-creates configured fixed mailboxes.
- Inbound email resolution already calls a centralized R2-backed
  `resolveInboundInboxProfile()` and refuses unknown or disabled recipients.

Therefore the next product slice is not "add mailbox creation from scratch".
It is "constrain and rename the existing mailbox creation flow into a
user-owned AI inbox creation flow".

## Goals / Non-Goals

**Goals:**

- Use the current Cloudflare Access boundary as the verified identity source.
- Derive an ordinary user's namespace username server-side from their verified
  Access email.
- Persist the generated username in R2 account metadata for stability.
- Let a user create multiple AI inboxes by entering `displayName` and `subname`.
- Derive ordinary user addresses as `username.subname@root-domain` on the
  server.
- Store user-owned inbox metadata additively in the existing R2 mailbox settings
  document.
- Keep existing MailboxDO behavior and full-email mailbox ids working.
- Preserve fixed configured mailbox mode for `EMAIL_ADDRESSES`.
- Update the frontend language and form to reflect AI inboxes rather than
  arbitrary mailbox addresses.

**Non-Goals:**

- Adding D1, a new database migration system, or a separate global control
  plane in this slice.
- Full multi-tenant authorization.
- Organization/team membership.
- Admin dashboard for arbitrary/global aliases.
- Custom domains.
- Migrating MailboxDO identity from full email address to stable `inbox_id`.
- Implementing AgentProfile/tool-configuration UI.

## Current Behavior To Preserve

- Existing R2 mailbox settings without user-owned metadata must remain readable.
- Existing arbitrary/legacy mailboxes must remain visible and usable.
- Existing `POST /api/v1/mailboxes` behavior should remain available for
  configured fixed mailbox compatibility or future admin-only flows unless this
  change explicitly gates it.
- `EMAIL_ADDRESSES` fixed mode should continue to display configured mailboxes
  and prevent ordinary arbitrary creation.
- Unknown inbound recipients must not auto-create inboxes.

## Decisions

### Decision: R2 is the MVP account/control-plane store

This worktree has no D1 binding. Introducing D1 just for username and inbox
metadata would be a larger architecture change than needed for this product
slice. The MVP will use R2 documents as the control-plane store:

- `users/<normalized-email>.json` for generated username metadata.
- `mailboxes/<derived-address>.json` for mailbox settings, InboxProfile, owner,
  and user-owned address metadata.

Alternatives considered:

- D1 users/inboxes tables: deferred because current official baseline is R2 +
  Durable Objects and has no D1 runtime binding.
- Runtime-only username derivation: rejected because username must stay stable
  if login email changes or the derivation algorithm evolves.

### Decision: Use Cloudflare Access email claims as user identity

The current production trust boundary is Cloudflare Access. The Worker should
extract the verified user email from the Access JWT after verification and make
it available to API routes through Hono context.

The exact claim names should be implemented defensively. Cloudflare Access JWTs
commonly include email-like identity claims, but the helper should fail closed
when it cannot find a verified email.

Alternatives considered:

- Native cookie sessions: not present in this worktree.
- Client-submitted user email: rejected because the client is not trusted for
  namespace ownership.

### Decision: Add a product-facing create-inbox path while keeping mailbox compatibility

The product-facing API should accept:

```json
{
  "displayName": "报销",
  "subname": "reimburse"
}
```

and return the derived address:

```text
<username>.reimburse@<root-domain>
```

Implementation can either add `/api/v1/inboxes` or adapt
`POST /api/v1/mailboxes` with a new body shape. The recommended path is to add
`/api/v1/inboxes` for product semantics and keep `/api/v1/mailboxes` as the
legacy compatibility route.

### Decision: Store user-owned metadata inside mailbox settings

New user-owned inboxes should write R2 settings like:

```json
{
  "fromName": "报销",
  "owner": "user@example.com",
  "userOwnedInbox": {
    "version": 1,
    "ownerEmail": "user@example.com",
    "username": "user",
    "subname": "reimburse",
    "rootDomain": "ziikoo.com",
    "address": "user.reimburse@ziikoo.com"
  },
  "inboxProfile": {
    "version": 1,
    "canonicalAddress": "user.reimburse@ziikoo.com",
    "displayName": "报销",
    "lifecycleStatus": "active",
    "storageMailboxId": "user.reimburse@ziikoo.com",
    "agentProfileId": "default-email-agent",
    "enabledToolIds": []
  }
}
```

This keeps current loaders working and gives future migrations enough metadata
to move toward `address -> inbox_id`.

### Decision: Username and subname rules are separate

- `username` is generated by the server from verified identity and persisted.
- `subname` is entered by the user and validated.
- `displayName` is user-facing text and may contain non-English labels.

Recommended ordinary subname MVP rules:

- lowercase ASCII letters, numbers, and hyphens only
- 2-32 characters
- must start and end with a letter or number
- no repeated hyphens
- reserved names rejected: `admin`, `api`, `auth`, `billing`, `help`, `mcp`,
  `postmaster`, `root`, `security`, `support`, `system`, `www`

### Decision: Lists are filtered by owner where possible, legacy remains visible

Current `GET /api/v1/mailboxes` returns every R2 mailbox. For product behavior,
new user-owned inboxes should be filtered to the current user's owner email.
Legacy mailboxes without `userOwnedInbox` metadata can remain visible during the
MVP to preserve current single-team behavior.

This is intentionally not full multi-tenancy. It is a product-safety step that
prevents the new user-owned namespace from becoming globally claimable.

### Decision: Inbound remains centralized and R2-backed

The existing `resolveInboundInboxProfile()` is already centralized and refuses
unknown recipients. This change should extend or verify that resolver works for
new `username.subname@root-domain` R2 settings. It should not switch inbound to
D1 in this slice.

## Risks / Trade-offs

- Access claim uncertainty -> The exact email claim can vary. Mitigation: add a
  helper with explicit supported claim names and fail-closed errors.
- R2 list filtering is less queryable than D1. Mitigation: acceptable for MVP;
  store enough metadata for a later D1/address-registry migration.
- Legacy all-mailbox visibility remains. Mitigation: preserve intentionally for
  compatibility; future multi-user hardening can hide or migrate legacy records.
- `mailboxId = full email` can calcify. Mitigation: document it as
  transitional and persist metadata needed for `address -> inbox_id` later.
- Multiple domains are ambiguous. Mitigation: MVP uses the first configured root
  domain for ordinary user-created inboxes unless a selector is explicitly
  added.

## Migration Plan

1. Add identity/username helper modules with compile-only verification.
2. Add R2 user metadata load/create helpers.
3. Add user-owned inbox settings builder on top of existing InboxProfile helper.
4. Add product-facing create/list API behavior while preserving legacy mailbox
   route compatibility.
5. Update home UI to create AI inboxes through `displayName + subname`.
6. Verify inbound resolver accepts registered derived addresses and rejects
   unknown addresses.
7. Run typecheck/build/OpenSpec validation and browser E2E.

Rollback strategy:

- R2 changes are additive.
- Existing mailbox settings and MailboxDO storage remain unchanged.
- If the product-facing route fails, existing `/api/v1/mailboxes` compatibility
  remains available.

## Open Questions

- Should legacy mailboxes stay visible to every Access-authorized user in MVP,
  or should we add an explicit admin-only switch immediately?
- Should the first configured domain always be the root domain, or should the UI
  let the user choose among configured domains?
- Should `/api/v1/mailboxes` arbitrary creation be blocked for non-admin users
  now, or left as compatibility until admin identity exists?
