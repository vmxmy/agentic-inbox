## Context

The official Cloudflare Agentic Inbox baseline is a compact demo where a
mailbox is an arbitrary email address and R2 mailbox settings blobs define
existence. The current fork has evolved toward a product platform with D1 auth,
mailbox directory, MCP governance, invoice workflows, and richer agents.

The product direction is now clearer: a human user owns multiple independent AI
inbox entities. Each inbox is reachable by email, but the inbox is more than an
email attribute. It is a durable work context with its own messages, agent
state, tools, artifacts, and future permission boundary.

Cloudflare remains the hard platform premise:

- Email Routing catch-all invokes the Worker.
- The Worker is the trust boundary.
- D1 is the global control plane.
- Durable Objects own inbox-local state.
- R2 stores bytes.
- No per-inbox Cloudflare Email Routing rule is required.

## Goals / Non-Goals

**Goals:**

- Add a generated, stable username for each authenticated user.
- Let a user create multiple AI inboxes by entering `displayName` and
  `subname`.
- Derive ordinary user addresses as `username.subname@root-domain`.
- Persist inbox metadata needed for display and future address registry.
- Validate all address-shaping rules on the server.
- Keep existing MailboxDO behavior working during the transition.
- Move inbound existence checks toward D1 control-plane records.
- Preserve future multi-tenant seams without building full multi-tenancy.

**Non-Goals:**

- Full organization/tenant model.
- Custom domains.
- Global short alias self-service.
- Per-inbox Cloudflare Email Routing rule management.
- Billing, SAML, or operations dashboard.
- Migrating MailboxDO identity from full email address to stable `inbox_id`.
- Reworking invoice workflows or MCP governance in this slice.

## Decisions

### Decision: Use generated usernames from verified login identity

`username` will be generated from the user's verified login email and stored as
a stable account attribute.

Alternatives considered:

- User-chosen username: rejected for MVP because it invites namespace squatting
  and support burden.
- Email local-part at runtime only: rejected because username must be stable
  even if login email changes later.

### Decision: Use entity inboxes, not labels in one mailbox

Each user-created work surface is a first-class inbox entity. Labels and email
attributes can organize messages inside an inbox, but they do not replace inbox
entities.

Alternatives considered:

- Single inbox with category labels: rejected because agent behavior, artifacts,
  tool permissions, and future collaboration boundaries need independent state.

### Decision: Derive ordinary addresses server-side

The client may preview the address, but the server derives the full address
from authenticated user context, validated subname, and configured root domain.

Alternatives considered:

- Client submits full email: rejected because ordinary users could attempt to
  claim another user's namespace or global aliases.

### Decision: Keep `mailboxId = full email address` transitional for Phase 1

Phase 1 should minimize churn by continuing to use the full email address as
the MailboxDO name. The data model should still record enough metadata to
support a later address registry and stable inbox id.

Alternatives considered:

- Immediate `inbox_id` migration: deferred because it touches all email,
  attachment, agent, MCP, and UI paths and is not required to validate the
  product slice.

### Decision: Prefer sidecar inbox metadata if migration risk is high

The implementation can either add columns to `mailboxes` or add an
`inbox_profiles` sidecar table keyed by mailbox id. The sidecar approach is
lower risk because existing mailbox directory behavior remains intact.

Recommendation:

- Use `users.username`.
- Use `inbox_profiles` for display/subname metadata unless implementation
  review shows direct columns are simpler and safe.

### Decision: Unknown inbound addresses do not auto-create inboxes

Catch-all Email Routing will deliver many possible addresses to the Worker.
Unknown recipients MUST be rejected or ignored according to policy; they MUST
NOT create new inboxes.

Recommendation:

- MVP policy: reject unknown recipients.

## Risks / Trade-offs

- Transitional identity risk -> `mailboxId = email` can calcify if not clearly
  documented. Mitigation: mark it transitional in docs and table comments.
- Legacy mailbox risk -> existing arbitrary mailboxes may not fit
  `username.subname`. Mitigation: keep legacy records visible and do not force
  convert them in this slice.
- Multi-domain ambiguity -> `DOMAINS` may contain more than one root domain.
  Mitigation: MVP selects the first configured domain as default unless the
  implementation plan explicitly adds a selector.
- UI terminology risk -> "mailbox" remains in internal code. Mitigation:
  product-facing copy says "AI Inbox"; code migration can be gradual.
- Inbound local development risk -> Cloudflare Email Routing is harder to test
  fully locally. Mitigation: unit-test resolver logic and document manual
  `wrangler email dev` verification.

## Migration Plan

1. Add generated username storage.
2. Backfill usernames for existing users.
3. Add inbox metadata storage.
4. Backfill metadata for existing mailboxes when owner and address shape are
   known; leave legacy records otherwise.
5. Add product-facing create inbox API and keep compatibility routes where
   needed.
6. Update UI to use the create inbox flow.
7. Update inbound resolution to consult D1 control-plane state.
8. Add tests and run typecheck/build.

Rollback strategy:

- Username and inbox metadata migrations are additive.
- Existing mailboxes continue using full email ids.
- If the new UI/API path fails, compatibility mailbox routes can remain
  available while the new route is fixed.

## Open Questions

- Should the product-facing route be `/api/v1/inboxes` immediately, or should
  `/api/v1/mailboxes` be adapted first?
- Should `inbox_profiles` be the sidecar table, or should `mailboxes` receive
  display/subname columns directly?
- Should unknown recipients be rejected with Email Worker `setReject`, or logged
  and ignored until local verification is stronger?
- How should multiple configured root domains be selected in MVP?

