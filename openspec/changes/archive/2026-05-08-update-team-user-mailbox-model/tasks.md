## 1. Data Model and Migrations

- [x] 1.1 Add additive D1 migration for `teams`, including normalized slug, display name, primary address, timestamps, disabled marker, and creator admin.
- [x] 1.2 Add additive D1 migration for `team_users`, linking existing `users` to teams with normalized team-local user slug and derived mailbox address.
- [x] 1.3 Add additive D1 migration for `address_registry`, mapping active team primary and team-user addresses to transitional mailbox ids.
- [x] 1.4 Add Drizzle schema exports and repository helpers for teams, team users, and address registry rows.
- [x] 1.5 Add migration/backfill guard logic that leaves existing owner/member mailboxes untouched.

## 2. Validation and Address Helpers

- [x] 2.1 Implement shared team/user slug normalization and validation helpers with reserved-name checks.
- [x] 2.2 Implement root-domain selection helper using configured `DOMAINS` with deterministic first-domain behavior for MVP.
- [x] 2.3 Implement server-side derived address helpers for `team@root-domain` and `team.user@root-domain`.
- [x] 2.4 Add unit tests for valid names, invalid names, reserved names, duplicate behavior, and derived addresses.

## 3. Admin APIs

- [x] 3.1 Add admin create/list team endpoints.
- [x] 3.2 Add admin create/list team user endpoints.
- [x] 3.3 Ensure team creation provisions mailbox directory, address registry, and initial MailboxDO settings for the team primary mailbox.
- [x] 3.4 Ensure team-user creation creates or links the D1 user, provisions mailbox directory, address registry, and initial MailboxDO settings for the user mailbox.
- [x] 3.5 Disable or gate ordinary self-serve mailbox creation in team/user mode.
- [ ] 3.6 Add API tests for admin success, non-admin denial, duplicates, invalid input, and client address override rejection.

## 4. Authorization and Resolution

- [x] 4.1 Add centralized address resolver that reads `address_registry` before legacy mailbox compatibility paths.
- [x] 4.2 Update inbound email recipient handling to use the centralized resolver and reject/ignore unknown recipients without auto-creation.
- [x] 4.3 Update mailbox access helpers so team users can access their team primary mailbox and their own user mailbox.
- [x] 4.4 Preserve legacy owner/member ACL checks for mailboxes without team metadata.
- [x] 4.5 Update MCP and `/agents/*` authorization paths to use the same team-aware mailbox access helper.
- [ ] 4.6 Add tests for known team recipient, known team-user recipient, unknown recipient, cross-team denial, and legacy compatibility.

## 5. Frontend UX

- [x] 5.1 Replace self-serve home mailbox creation with a no-access state that directs ordinary users to an admin.
- [x] 5.2 Add admin UI for creating teams with address preview.
- [x] 5.3 Add admin UI for creating team users with `team.user@root-domain` address preview.
- [x] 5.4 Update mailbox list/detail rendering to show team display names and derived addresses when metadata exists.
- [x] 5.5 Replace or de-emphasize owner/member settings UI for team-managed mailboxes.
- [x] 5.6 Update API client methods, query keys, and React Query hooks for teams and team users.

## 6. Migration, Documentation, and Verification

- [x] 6.1 Document that `add-user-owned-ai-inbox-creation` is superseded by this team/user model before implementation starts.
- [x] 6.2 Document transitional `mailboxId = full email address` behavior in relevant code comments or architecture docs.
- [x] 6.3 Run `npm run typecheck`.
- [x] 6.4 Run relevant Vitest suites for auth, team/mailbox helpers, address resolution, and inbound routing.
- [x] 6.5 Run `npm run build`.
- [ ] 6.6 Manually verify admin create-team/create-user flows.
- [ ] 6.7 Manually or locally verify inbound email behavior with `wrangler email dev` where possible.
