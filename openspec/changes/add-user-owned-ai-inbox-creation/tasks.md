## 1. Data Model and Helpers

- [ ] 1.1 Add additive D1 migration for generated user username storage.
- [ ] 1.2 Add additive D1 migration for inbox display/subname metadata, preferably as a sidecar profile table unless implementation review selects direct mailbox columns.
- [ ] 1.3 Implement username normalization, reserved-word checking, and collision handling helpers.
- [ ] 1.4 Implement subname validation helper with user-readable error mapping.
- [ ] 1.5 Implement server-side derived address helper using username, subname, and configured root domain.
- [ ] 1.6 Add unit tests for username generation, subname validation, and derived address behavior.

## 2. API and Authorization

- [ ] 2.1 Add product-facing create AI inbox API, or adapt the existing mailbox creation route according to final route decision.
- [ ] 2.2 Ensure the API derives the address server-side and rejects client attempts to override username or full address.
- [ ] 2.3 Persist new inbox metadata and seed the existing MailboxDO path for transitional compatibility.
- [ ] 2.4 Return display name, subname, username, root domain, and derived address in list/detail responses.
- [ ] 2.5 Encapsulate ownership/access checks behind helper functions rather than scattering raw owner comparisons.
- [ ] 2.6 Add API tests for creation success, duplicate subname conflict, invalid subname, and cross-user namespace protection.

## 3. Inbound Address Resolution

- [ ] 3.1 Add a centralized inbound address resolver contract.
- [ ] 3.2 Resolve active user-owned inbox addresses through D1 control-plane metadata.
- [ ] 3.3 Preserve fixed `EMAIL_ADDRESSES` compatibility for configured shared/fixed mailbox mode.
- [ ] 3.4 Replace or bypass the legacy R2 mailbox blob existence check for new user-owned inboxes.
- [ ] 3.5 Ensure unknown valid-looking recipients do not auto-create inboxes.
- [ ] 3.6 Add tests for known recipient, unknown recipient, unconfigured domain, and fixed mailbox compatibility.

## 4. Frontend Flow

- [ ] 4.1 Update the home empty state and creation action from mailbox-first language to AI inbox language.
- [ ] 4.2 Replace arbitrary prefix entry with a create inbox form containing display name and subname.
- [ ] 4.3 Show non-editable generated username and root domain in the address preview.
- [ ] 4.4 Display inline validation errors for subname issues.
- [ ] 4.5 Show display name and derived email address in the inbox list.
- [ ] 4.6 Preserve access to legacy mailboxes that do not yet have inbox profile metadata.

## 5. Migration and Compatibility

- [ ] 5.1 Backfill usernames for existing users.
- [ ] 5.2 Backfill inbox metadata for existing mailboxes where owner and address shape are known.
- [ ] 5.3 Leave non-conforming legacy mailboxes accessible without forced conversion.
- [ ] 5.4 Document transitional `mailboxId = full email address` behavior in code comments or architecture notes.

## 6. Verification

- [ ] 6.1 Run `npm run typecheck`.
- [ ] 6.2 Run relevant Vitest suites for auth, mailbox/inbox helpers, and inbound routing.
- [ ] 6.3 Run `npm run build`.
- [ ] 6.4 Manually verify create-inbox UI flow.
- [ ] 6.5 Manually or locally verify inbound email behavior with `wrangler email dev` where possible.
- [ ] 6.6 Update docs or OpenSpec notes with any implementation deviations.

