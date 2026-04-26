# Review Remediation Plan

Updated: 2026-04-27

## Purpose

This document turns the current full-repo review into a concrete repair plan
for `agentic-inbox`.

It is written to guide implementation work across auth, mailbox ownership,
shared-mailbox collaboration, agent/rules behavior, and frontend settings.

## Product Constraints Confirmed

These constraints are now treated as requirements for every fix in this plan:

- The instance supports multiple native-auth users.
- Shared mailboxes are a first-class use case.
- Example: a finance reimbursement mailbox can be used by the whole finance
  team.
- Mailbox members are allowed to collaborate on mailbox data and workflows.
- Mailbox ownership must not be claimable by whichever user logs in first.
- Admins are instance-level operators; mailbox owners are mailbox-level
  operators.

## Recommended Access Model

To keep the implementation aligned with the requirements above:

- `admin`
  - Manages users and global provisioning.
  - Can create mailboxes on behalf of users or teams.
- `mailbox owner`
  - Manages mailbox membership and mailbox-level integrations.
  - Remains the authority for invite issuance and ownership-sensitive changes.
- `mailbox member`
  - Has read/write access to mailbox content and ordinary mailbox workflows.
  - Should not implicitly become owner.
- `system`
  - Internal worker-to-worker calls only.

Recommended boundary:

- Mailbox data operations can remain owner/member writable.
- External side effects and integrations should be treated more carefully than
  mailbox data writes. For this fix wave, `webhook` configuration should move
  to owner-only.

## Current Blocking Findings

### P0 / Merge Blockers

1. The current branch does not typecheck cleanly.
2. Shared mailbox ownership can be captured by the first logged-in user.
3. Password reset and password change do not revoke existing sessions.
4. Saving mailbox settings can silently remove `extractInvoice` rules.

### P1 / Important Follow-Ups

1. Password login has no rate limiting.
2. Magic-link sign-in loses the original `next` destination.
3. `core:webhook` allows arbitrary outbound requests without SSRF hardening.

### P2 / Cleanup and Alignment

1. Repo documentation still describes an Access-centric trust model that no
   longer matches the runtime.
2. Ownership migration for legacy ownerless mailboxes needs a safer path than
   claim-on-first-access.

## Evidence Snapshot

- Mailbox auto-creation and owner seeding:
  - `app/routes/home.tsx:66`
  - `workers/index.ts:204`
- Claim-on-first-access and ownerless mailbox visibility:
  - `workers/lib/auth.ts:130`
  - `workers/lib/auth.ts:157`
  - `workers/lib/auth.ts:195`
- Session creation but no session revocation on credential changes:
  - `workers/routes/auth.ts:143`
  - `workers/routes/auth.ts:300`
  - `workers/routes/auth.ts:322`
  - `workers/lib/session.ts:79`
- Rules backend supports `extractInvoice`, but the settings UI does not round
  trip it:
  - `workers/lib/rules.ts:41`
  - `app/routes/settings.tsx:58`
  - `app/routes/settings.tsx:120`
  - `app/routes/settings.tsx:141`
- Webhook capability is intentionally insecure in Phase 1:
  - `workers/lib/capabilities/builtin/webhook.ts:9`
- Capability/typecheck errors are currently blocking `tsc -b`:
  - `workers/lib/capabilities/builtin/list-emails.ts:8`
  - `workers/lib/capabilities/builtin/move-email.ts:8`
  - `workers/index.ts:275`

## Workstream 0: Restore a Green Build

**Status: already green as of 2026-04-27.** Verified after commit `022b33f`:
`npm run verify` exits 0, `tsc -b --force` is clean, and
`node scripts/audit-ts-suppressions.mjs` reports 0 suppressions across 123 files.
The errors that triggered this workstream were fixed during the capability
registry merge before that commit shipped. No follow-up PR is needed.

### Goal

Make `npm run verify` pass again before behavior changes continue.

### Tasks

- [ ] Fix broken import paths in capability files
  - `workers/lib/capabilities/builtin/list-emails.ts`
  - `workers/lib/capabilities/builtin/move-email.ts`
  - Expected change: correct the relative import path to `shared/folders`.

- [ ] Fix type narrowing in the mailbox capabilities discovery route
  - `workers/index.ts`
  - Expected change: ensure the `surface` query param is narrowed to the
    `CapabilitySurface` union before passing it to `listCapabilities(...)`.

- [ ] Fix capability input typing/default propagation
  - `workers/lib/capabilities/builtin/list-emails.ts`
  - `workers/lib/capabilities/builtin/mark-email-read.ts`
  - Expected change: make runtime/defaulted values satisfy the stricter shared
    tool signatures.

- [ ] Fix rule-action normalization typing
  - `workers/lib/capabilities/legacy-shim.ts`
  - `workers/index.ts`
  - Expected change: guarantee every normalized action has `params` and that
    the `RuleAction` -> `NormalizedAction[]` conversion stays type-safe.

- [ ] Rerun build verification
  - `npm run verify`
  - If `verify` is still sticky because of `wrangler types` / `react-router typegen`,
    also run:
    - `./node_modules/.bin/tsc -b --pretty false`
    - `node scripts/audit-ts-suppressions.mjs`

### Acceptance Criteria

- `npm run verify` passes locally.
- No TypeScript errors remain in the capability migration work.
- No new `@ts-ignore` or suppression debt is introduced.

## Workstream 1: Shared-Mailbox Ownership and Provisioning Hardening

This is the most important product-correctness fix for multi-user support.

### Goal

Remove "first logged-in user becomes owner" behavior from shared mailboxes.

### Recommended Decision

When `EMAIL_ADDRESSES` is configured, mailbox creation should no longer be
self-serve for normal users. Provisioning should happen through an admin-owned
path that explicitly seeds the mailbox owner.

This is the safest short-term path because the current env model contains a
list of mailbox addresses, but no secure owner mapping.

### Tasks

- [ ] Remove client-side automatic mailbox creation for configured addresses
  - `app/routes/home.tsx`
  - Current problem: the home page auto-creates every configured address that
    does not already exist.
  - Expected change: the page should list accessible mailboxes only, not create
    them implicitly.

- [ ] Restrict normal mailbox creation when `EMAIL_ADDRESSES` is non-empty
  - `workers/index.ts:createMailboxForOwner`
  - Expected change:
    - If `EMAIL_ADDRESSES` is configured, only admins may provision those
      mailboxes.
    - Self-serve creation may remain allowed only when no fixed mailbox list is
      configured.

- [ ] Remove claim-on-first-access for ownerless mailboxes from normal user flows
  - `workers/lib/auth.ts:assertMailboxAccess`
  - `workers/lib/auth.ts:assertMailboxOwner`
  - `workers/lib/auth.ts:listUserMailboxes`
  - Expected change:
    - Ownerless mailboxes should not be visible to arbitrary users.
    - Access should fail closed for non-admin, non-system callers.
    - Claiming ownership should become an explicit admin migration step, not a
      side effect of browsing.

- [ ] Add a controlled owner-assignment path for legacy ownerless mailboxes
  - Candidate locations:
    - admin API in `workers/index.ts`
    - a one-off migration script
  - Expected change:
    - Admin can assign owner for existing ownerless mailboxes.
    - This path is auditable and explicit.

- [ ] Review admin provisioning UX
  - `workers/index.ts:/api/v1/admin/users/:id/mailboxes`
  - `app/routes/admin.tsx`
  - Decide whether a minimal UI is needed now, or whether API-only admin
    provisioning is enough for the first fix wave.

### Acceptance Criteria

- A non-admin user cannot become owner of a configured shared mailbox just by
  logging in first.
- Ownerless legacy mailboxes are not auto-claimed by random users.
- Admin can still provision mailboxes intentionally.
- Shared mailbox members can continue to collaborate after explicit owner/member
  assignment.

### Manual Verification

- User A and User B both log into a fresh environment with configured
  `EMAIL_ADDRESSES`.
- Neither user gains owner access to an unprovisioned shared mailbox by opening
  the app.
- Admin provisions mailbox `finance@...` to User A.
- User A can invite User B.
- User B becomes member, but not owner.

## Workstream 2: Revoke Sessions on Credential Changes

### Goal

Make password recovery and password rotation actually restore account security.

### Recommended Session Semantics

- Password reset:
  - Revoke all existing sessions for that user.
  - Do not auto-login.
- Password change while logged in:
  - Revoke all existing sessions for that user.
  - Issue one fresh session for the current browser only, or explicitly clear
    the current cookie and force re-login.

Preferred UX:

- Keep the current in-app browser session alive after in-session password
  change, but revoke all other sessions.

### Tasks

- [ ] Revoke all user sessions after password reset
  - `workers/routes/auth.ts:/password/reset`
  - `workers/lib/session.ts:deleteSessionsForUser`

- [ ] Revoke all user sessions during password change
  - `workers/routes/auth.ts:/password/change`
  - Decide whether to:
    - delete all sessions and mint a fresh one for the current browser, or
    - clear the cookie and require re-login everywhere

- [ ] Keep session handling consistent with logout
  - `workers/routes/auth.ts:/logout`
  - Ensure cookie state and database state stay aligned.

- [ ] Document the behavior in UI copy if needed
  - `app/routes/settings.tsx`
  - Optional: show "Changing password signs out other sessions."

### Acceptance Criteria

- A stolen old cookie no longer works after password reset.
- A stolen old cookie no longer works after password change.
- The current user experience is intentional and documented.

### Manual Verification

- Log in as the same user in two browsers.
- Change password in browser A.
- Confirm browser B loses authenticated access.
- Reset password via emailed reset link and confirm all old sessions are dead.

## Workstream 3: Rules UI Parity and Safe Settings Round-Trip

### Goal

Prevent the Settings UI from silently deleting supported backend rule fields.

### Tasks

- [ ] Add `extractInvoice` to the rules UI model
  - `app/routes/settings.tsx`
  - Update:
    - `UIRule`
    - `BLANK_RULE`
    - `loadRulesFromSettings(...)`
    - `dumpRulesForSave(...)`

- [ ] Add an explicit UI control for invoice extraction
  - `app/routes/settings.tsx`
  - Recommended label:
    - "Extract invoice"
    - Description should explain this persists structured invoice records.

- [ ] Verify backend/frontend field parity for rules
  - Compare:
    - `workers/lib/rules.ts`
    - `app/routes/settings.tsx`
  - Ensure every currently supported `then.*` field is either editable or
    intentionally preserved.

- [ ] Add a defensive round-trip review for future rule fields
  - Preferred approach:
    - preserve unknown `then` fields when saving, or
    - block save with a warning if unsupported fields are present
  - This is not required for the first patch, but it is recommended to avoid
    repeating the same class of bug.

### Acceptance Criteria

- Opening Settings and clicking Save does not remove `extractInvoice`.
- Existing invoice extraction rules survive a round-trip unchanged.
- The UI accurately reflects the backend rule schema.

### Manual Verification

- Seed a mailbox with a rule whose `then.extractInvoice = true`.
- Open Settings, make an unrelated change, save.
- Read the mailbox settings blob again and confirm the rule still contains
  `extractInvoice: true`.

## Workstream 4: Login Hardening and Deep-Link Continuity

### Goal

Improve auth security and keep mailbox/invite flows intact across magic-link
sign-in.

### Tasks

- [ ] Add rate limiting to password login
  - `workers/routes/auth.ts:/login`
  - Reuse `workers/lib/rate-limit.ts`
  - Suggested minimum:
    - per-email short window
    - per-email long window
    - per-IP long window

- [ ] Preserve `next` through magic-link login
  - `app/routes/login.tsx`
  - `app/routes/magic.tsx`
  - Option A, recommended:
    - include `next` in the emailed `/magic?...` link
    - sanitize to same-origin internal paths on consume
  - Option B:
    - use `sessionStorage` on the requesting device only
  - Prefer Option A because invite links and deep links may be opened on a
    different device than the one that requested them.

- [ ] Sanitize `next` before navigation
  - `app/routes/login.tsx`
  - `app/routes/magic.tsx`
  - Avoid open-redirect-style behavior by allowing internal app paths only.

- [ ] Verify invite flow still works
  - `workers/app.ts`
  - `app/routes/invite.tsx`
  - Confirm `/invite/:token` survives the redirect to `/login` and returns to
    the right mailbox flow after auth.

### Acceptance Criteria

- Password login resists repeated brute-force attempts better than today.
- Magic-link auth returns the user to the intended internal route.
- Invite and mailbox deep links survive auth redirects.

### Manual Verification

- Try repeated bad-password logins and confirm rate limits trigger.
- Open `/mailbox/.../settings` while logged out, sign in via magic link, and
  confirm you return there.
- Open `/invite/:token` while logged out, sign in via magic link, and confirm
  the invite still completes.

## Workstream 5: Webhook SSRF Hardening and Integration Boundary

### Goal

Keep the new capability system extensible without allowing mailbox rules to
turn the Worker into an unrestricted HTTP client.

### Recommended Decision

Treat webhook configuration as integration-level power, not ordinary mailbox
editing. For this fix wave, move webhook authoring to mailbox owner only.

### Tasks

- [ ] Restrict webhook rule authoring to owner-level settings access
  - Candidate surfaces:
    - `app/routes/settings.tsx`
    - `workers/index.ts:/api/v1/mailboxes/:mailboxId`
  - Practical approach:
    - owner-only UI controls for webhook actions
    - server-side validation that rejects webhook rules from non-owners

- [ ] Add outbound URL validation
  - `workers/lib/capabilities/builtin/webhook.ts`
  - Minimum rules:
    - HTTPS only
    - reject localhost
    - reject loopback IPs
    - reject RFC1918/private IP literals
    - reject link-local and metadata addresses such as `169.254.169.254`

- [ ] Add timeout and response-size guardrails
  - `workers/lib/capabilities/builtin/webhook.ts`
  - Prevent hanging fetches and oversized responses.

- [ ] Restrict forwarded headers
  - `workers/lib/capabilities/builtin/webhook.ts`
  - Do not allow dangerous or confusing header overrides such as:
    - `Host`
    - `Authorization`
    - `CF-*`
    - other hop-by-hop headers

- [ ] Decide whether a host allowlist is needed now
  - If integrations are known and small in number, prefer allowlist.
  - If not, implement the minimum deny rules above in this wave and revisit
    allowlisting after launch.

### Acceptance Criteria

- Webhook rules can no longer target sensitive local/private destinations.
- Mailbox members cannot silently create external integrations if that power is
  reserved for the owner.
- The capability remains usable for legitimate public HTTPS endpoints.

### Manual Verification

- Attempt to save a webhook to `http://127.0.0.1/...` and expect rejection.
- Attempt to save a webhook to `http://169.254.169.254/...` and expect rejection.
- Save a webhook to a legitimate public HTTPS endpoint and confirm it still
  works.

## Workstream 6: Documentation and Trust-Boundary Alignment

### Goal

Bring repo docs back in line with the code after the native-auth migration.

### Tasks

- [ ] Update root repo guidance
  - `AGENTS.md`
  - Current text still describes production trust primarily through Cloudflare
    Access, but runtime now supports cookie sessions, API keys, and Access as a
    fallback.

- [ ] Update README auth model
  - `README.md`
  - Describe:
    - native auth
    - shared mailbox membership
    - admin provisioning
    - Access fallback, if still supported

- [ ] Document shared mailbox ownership semantics
  - Owner vs member vs admin
  - How shared finance/team mailboxes should be provisioned

### Acceptance Criteria

- A new contributor reading repo docs can understand the current auth model.
- Docs no longer imply "Access-only" when the code is not Access-only.

## Suggested PR Breakdown

Recommended sequencing:

1. PR 1 - Build green
   - Workstream 0 only
2. PR 2 - Ownership hardening
   - Workstream 1
3. PR 3 - Session invalidation + login hardening
   - Workstreams 2 and 4
4. PR 4 - Rules UI parity
   - Workstream 3
5. PR 5 - Webhook hardening
   - Workstream 5
6. PR 6 - Docs alignment
   - Workstream 6

If you want fewer PRs:

- Combine PR 1 + PR 3 only after the build is green locally.
- Keep Workstream 1 isolated if possible because it changes product semantics.

## Global Verification Checklist

- [ ] `npm run verify`
- [ ] `npm run dev`
- [ ] Shared mailbox access verified with at least 2 real users
- [ ] Invite flow tested end-to-end
- [ ] Password change tested with 2 concurrent sessions
- [ ] Password reset tested with stale cookies
- [ ] Rules round-trip tested with `extractInvoice`
- [ ] Inbound email tested with `wrangler email dev`
- [ ] Auto-draft still works for ordinary mail
- [ ] Invoice extraction still works for invoice mail
- [ ] MCP still connects and mailbox ACL still holds

## Definition of Done

The repair effort is done when all of the following are true:

- The branch is green (`npm run verify`).
- Shared mailbox ownership cannot be captured accidentally.
- Credential changes revoke old sessions.
- The rules editor no longer destroys backend-supported fields.
- Magic-link login preserves intended navigation.
- Webhook behavior is intentionally constrained.
- Repo documentation matches the runtime trust model.
