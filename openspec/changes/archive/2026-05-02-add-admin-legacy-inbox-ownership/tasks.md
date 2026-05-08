## 0. Baseline Audit / IR

- [x] 0.1 Confirm `codex/product-main` contains Phase 2 Agent / Tools / Safety config and deployment state.
- [x] 0.2 Re-read current `user-owned-ai-inboxes` spec and current mailbox/settings routes.
- [x] 0.3 Confirm there is no existing admin/RBAC helper beyond verified identity and `ADMINS` env.
- [x] 0.4 Confirm first implementation includes both legacy owner assignment and explicit owner replacement.

## 1. Backend Admin Authorization

- [x] 1.1 Add an admin identity helper that checks verified request identity against `ADMINS` case-insensitively.
- [x] 1.2 Ensure admin-only endpoints fail closed when identity is missing or not admin.
- [x] 1.3 Add compile/helper verification for admin matching, missing identity, and case normalization.

## 2. Ownership Assignment Model

- [x] 2.1 Add a helper to identify legacy inbox settings that lack `userOwnedInbox` metadata.
- [x] 2.2 Add a helper to merge admin-assigned `userOwnedInbox` metadata into existing R2 mailbox settings without changing address, MailboxDO key, attachments, or existing agent config.
- [x] 2.3 Use existing user metadata generation for assigned owner usernames.
- [x] 2.4 Validate admin-provided logical subname using existing subname rules or a documented admin-specific variant.
- [x] 2.5 Add optimistic concurrency using R2 etag preconditions for assignment writes.
- [x] 2.6 Add audit records for first-time assignment and owner replacement, including previous and next owner for replacements.

## 3. Backend API

- [x] 3.1 Add `GET /api/v1/admin/legacy-inboxes` or equivalent to list inboxes lacking owner metadata by default and owned inboxes behind an explicit replacement filter.
- [x] 3.2 Add `POST/PATCH /api/v1/admin/inboxes/:mailboxId/owner` or equivalent to assign or replace owner metadata.
- [x] 3.3 Return clear validation errors for invalid owner email, invalid subname, not-found inbox, replacement without explicit confirmation, and stale etag conflict.
- [x] 3.4 Ensure ordinary users cannot call admin endpoints.
- [x] 3.5 Ensure an assigned owner can see the inbox through existing mailbox list/detail APIs after assignment.
- [x] 3.6 Ensure structured Agent / Tools / Safety config becomes available to the assigned owner after assignment.

## 4. Frontend Admin UI

- [x] 4.1 Add a small admin-only route at `/admin/legacy-inboxes` for legacy inbox ownership migration and owner replacement.
- [x] 4.2 Render legacy inbox address, display name, and current settings status.
- [x] 4.3 Provide owner email and logical subname inputs with validation feedback.
- [x] 4.4 Add confirmation before writing ownership metadata, with clearer warning copy for owner replacement.
- [x] 4.5 Show success, conflict, unauthorized, and validation error states.
- [x] 4.6 Link or guide the admin to open the assigned inbox settings after migration.

## 5. Verification

- [x] 5.1 Run `openspec validate add-admin-legacy-inbox-ownership --strict --no-interactive`.
- [x] 5.2 Run `npm run typecheck`.
- [x] 5.3 Run `npm run build`.
- [ ] 5.4 API E2E: non-admin cannot list or assign legacy inbox ownership.
- [ ] 5.5 API E2E: admin assigns owner to a legacy inbox and R2 settings preserve existing fields.
- [ ] 5.6 API/browser E2E: assigned owner sees the inbox and can open Agent / Tools / Safety settings.
- [ ] 5.7 API E2E: admin replaces an existing owner and audit captures previous and next owner.
- [ ] 5.8 Conflict E2E: stale owner assignment or replacement write returns conflict and does not overwrite newer settings.
