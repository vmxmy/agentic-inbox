## 0. Baseline Audit / IR

- [x] 0.1 Read the current official-baseline worktree before implementation planning.
- [x] 0.2 Confirm current create flow already supports arbitrary mailbox creation from the home page.
- [x] 0.3 Confirm current auth is Cloudflare Access JWT only, with no downstream user identity context yet.
- [x] 0.4 Confirm this worktree has no D1 binding and mailbox settings live in R2.
- [x] 0.5 Confirm inbound resolution is already centralized through `resolveInboundInboxProfile()`.
- [x] 0.6 Revise this OpenSpec change so it refines existing mailbox creation instead of inventing a separate D1-first design.

## 1. Identity and Username Helpers

- [x] 1.1 Add a request identity helper that extracts verified user email from Cloudflare Access JWT claims after existing verification.
- [x] 1.2 Attach the verified identity to Hono context for API routes.
- [x] 1.3 Add R2-backed user metadata helpers under a prefix such as `users/<email>.json`.
- [x] 1.4 Implement username generation, normalization, reserved-word checking, and collision handling.
- [x] 1.5 Ensure generated username is stable after first assignment.
- [x] 1.6 Add compile-only or unit verification for identity/username helpers.

## 2. User-Owned Inbox Address Rules

- [x] 2.1 Implement subname validation helper with user-readable error mapping.
- [x] 2.2 Implement server-side derived address helper using username, subname, and selected root domain.
- [x] 2.3 Reject client attempts to submit or override full ordinary-user inbox addresses.
- [x] 2.4 Add reserved subname list for system/global aliases.
- [x] 2.5 Add verification for valid subname, invalid subname, reserved subname, duplicate subname, and derived address behavior.

## 3. API and R2 Persistence

- [x] 3.1 Add product-facing create AI inbox API, preferably `POST /api/v1/inboxes`, accepting `displayName` and `subname`.
- [x] 3.2 Keep `/api/v1/mailboxes` compatibility for existing/fixed mailbox behavior unless explicitly gated.
- [x] 3.3 Create R2 mailbox settings at `mailboxes/<derived-address>.json` using existing `ensureSettingsInboxProfile()` or an extended builder.
- [x] 3.4 Store additive `userOwnedInbox` metadata including owner email, username, subname, root domain, and derived address.
- [x] 3.5 Seed existing MailboxDO folders for the derived address.
- [x] 3.6 Return display name, subname, username, root domain, derived address, and legacy mailbox fields needed by current UI.
- [x] 3.7 Update list/detail responses so new user-owned inboxes expose friendly display metadata while legacy mailboxes remain accessible.
- [x] 3.8 Add ownership filtering for user-owned inboxes; preserve a documented legacy visibility behavior for non-user-owned mailboxes.

## 4. Inbound Address Resolution

- [x] 4.1 Verify R2-backed `resolveInboundInboxProfile()` accepts newly created `username.subname@root-domain` inbox settings.
- [x] 4.2 Ensure unknown `username.subname@root-domain` recipients remain rejected / ignored and never auto-create inboxes.
- [x] 4.3 Validate configured root domain behavior for user-owned addresses.
- [x] 4.4 Preserve fixed `EMAIL_ADDRESSES` compatibility mode.
- [x] 4.5 Add verification for known derived recipient, unknown derived recipient, fixed mailbox compatibility, and unconfigured domain behavior.

## 5. Frontend Flow

- [x] 5.1 Update home page language from Mailboxes/Create Mailbox to AI Inboxes/Create AI Inbox where user-facing.
- [x] 5.2 Replace arbitrary prefix+domain entry for ordinary creation with display name + subname.
- [x] 5.3 Show generated address preview using server-provided or API-fetched username/root domain data.
- [x] 5.4 Display inline validation errors for subname issues and duplicate conflicts.
- [x] 5.5 Show display name and derived email address in the inbox list.
- [x] 5.6 Preserve legacy mailbox display and navigation.

## 6. Compatibility and Cleanup

- [x] 6.1 Keep existing R2 settings readable when they lack `userOwnedInbox` metadata.
- [x] 6.2 Keep `mailboxId = full email address` documented as transitional.
- [x] 6.3 Remove or update stale D1/native-session assumptions from this change if any remain.
- [x] 6.4 Do not add broad AgentProfile/tool configuration UI in this slice.

## 7. Verification

- [x] 7.1 Run `openspec validate add-user-owned-ai-inbox-creation --strict --no-interactive`.
- [x] 7.2 Run `npm run typecheck`.
- [x] 7.3 Run `npm run build`.
- [ ] 7.4 Browser E2E: create an AI inbox using display name + subname.
- [ ] 7.5 API/E2E: verify the created inbox appears in the list and opens correctly.
- [ ] 7.6 Inbound E2E or local email dev: verify mail to a registered derived address is accepted.
- [ ] 7.7 Inbound negative check: verify mail to an unknown derived address is not persisted.
