# Architecture First-Wave Checklist

Updated: 2026-04-27

## Purpose

This document breaks the first architecture wave into issue-ready execution
checklists for:

- PR 1
- PR 2
- PR 3
- PR 4
- PR 5
- PR 6

It is the operational companion to:

- `docs/architecture-audit-report.md`
- `docs/architecture-implementation-roadmap.md`

## First-Wave Goal

Stabilize the platform foundation before approvals, workflows, or OAuth work.

By the end of this wave, the system should have:

- consistent auth semantics across HTTP, UI, Agent, and MCP
- mailbox ownership and membership out of R2 JSON
- mailbox-local mutable settings out of R2 JSON
- repo docs aligned with the actual trust model
- repo-local verification boundaries that are less sensitive to machine noise

## Merge Order

Recommended order:

1. PR 1 - MCP auth context contract
2. PR 2 - boundary and doc alignment
3. PR 3 - D1 mailbox directory and membership index
4. PR 4 - API/admin cutover to D1 mailbox control plane
5. PR 5 - MailboxDO settings table and read-path migration
6. PR 6 - settings write-path cutover and R2 settings retirement

## Wave Exit Criteria

- [ ] MCP and HTTP preserve the same caller role semantics
- [ ] mailbox listing no longer depends on `R2 BUCKET.list("mailboxes/")`
- [ ] mailbox ACL source of truth is no longer R2 JSON
- [ ] agent config reads no longer depend on R2 mailbox settings blobs
- [ ] agent config writes no longer depend on R2 mailbox settings blobs
- [ ] repo docs describe native auth as primary and Access as fallback
- [ ] local typecheck output is no longer polluted by unrelated external `tsconfig` files

## PR 1 - MCP Auth Context Contract

Suggested title:

`fix(mcp): preserve full auth context across worker boundary`

Detailed implementation plan:

`docs/pr1-auth-context-implementation-plan.md`

### Goal

Ensure MCP sees the same authenticated principal semantics as the main app.

### Depends on

- nothing in this roadmap

### Implementation Checklist

- [ ] Define an internal auth context payload in `workers/lib/auth.ts`
- [ ] Include at least:
  - `id`
  - `email`
  - `role`
  - `system`
  - `iat`
  - `aud`
- [ ] Add helpers to serialize and verify the internal auth context
- [ ] Update `workers/app.ts` MCP forwarding to send full auth context, not email only
- [ ] Update `workers/mcp/index.ts` to decode verified auth context
- [ ] Stop reconstructing MCP callers as fixed `role: "user"`
- [ ] Ensure system callers remain system callers through the MCP surface
- [ ] Ensure admin callers remain admin callers through the MCP surface
- [ ] Update any MCP-facing auth assumptions in comments or inline docs

### Files Likely Touched

- `workers/app.ts`
- `workers/mcp/index.ts`
- `workers/lib/auth.ts`
- `workers/types.ts`

### Acceptance Criteria

- [ ] admin semantics match between MCP and HTTP
- [ ] system semantics match between MCP and HTTP
- [ ] mailbox visibility is consistent for the same principal across surfaces

### Verification

- [ ] compare `/api/v1/mailboxes` and MCP `list_mailboxes` for a normal user
- [ ] compare the same for an admin user
- [ ] verify an internal/system-triggered path still works

### Risk Notes

- This PR touches trust boundaries. Keep it narrowly scoped.
- Avoid mixing MCP auth changes with unrelated tool or UI work.
- `INTERNAL_SECRET` becomes a hard runtime requirement for `/mcp` and
  `/agents/*` (previously only used for invites + worker-to-worker calls).
  Documented as required in `README.md` and `.dev.vars.example`; deploys
  without it will see the auth-context signer throw a 500 on first chat or
  MCP call. Intentional — no compat fallback (would defeat the trust gain).

### Deferred Follow-up — Internal Auth Context Test Coverage

The repo has no test runner today (no `vitest` / `jest` / `playwright`).
Adding test infra is out of scope for PR 1's "transport contract only" cut,
so automated coverage for the new signed envelope is deferred to a separate
PR that introduces vitest (plus `@cloudflare/vitest-pool-workers` for the
DO ingress paths).

That follow-up should cover:

- [ ] `serializeInternalAuthContext` ↔ `parseInternalAuthContext` round-trip
      preserves `id`, `email`, `role`, `system`
- [ ] malformed token → `parseInternalAuthContext` throws
      `AuthzError(401)`; `readInternalAuthContextHeader` returns `null`
- [ ] expired token (past `exp`) is rejected
- [ ] forged `aud` / `iss` tokens are rejected
- [ ] request-path smoke: a happy-path `/mcp` request and a happy-path
      `/agents/<class>/<mailbox>` request both reach the DO with the
      decoded user identity intact

Until that PR lands, PR 1 relies on `npm run typecheck` + manual MCP /
agent chat / `wrangler email dev` smoke checks per
`docs/pr1-auth-context-implementation-plan.md` Manual Verification.

## PR 2 - Boundary and Doc Alignment

Suggested title:

`chore(repo): align trust-boundary docs and constrain local typegen scope`

### Goal

Bring docs and repo-local verification behavior back in sync with the runtime.

### Depends on

- PR 1 recommended first, but not technically required

### Implementation Checklist

- [x] Trust-boundary docs aligned with the signed internal auth context
      *(landed in PR 1 alongside the code change so the files stay coherent —
      `workers/AGENTS.md`, `workers/lib/AGENTS.md`, `workers/mcp/AGENTS.md`,
      `workers/lib/capabilities/registry.ts` comment)*
- [x] `INTERNAL_SECRET` flagged as required in `README.md` Configuration and
      `.dev.vars.example` *(landed in PR 1 since the regression risk is
      tied to the same code change)*
- [x] Constrain `vite-tsconfig-paths` to the project root via
      `tsconfigPaths({ root: "." })` so the parser stops walking IDE
      extension directories outside the repo
- [x] Disable the Cloudflare Vite plugin's inspector port via
      `cloudflare({ ..., inspectorPort: false })` to stop dev-server
      port-binding noise in sandboxed environments
- [ ] Re-run `npm run typecheck` after the vite.config change
- [ ] Confirm the prior home-directory `tsconfig` parse noise is gone or
      substantially reduced
- [ ] Land the three architecture framework docs that span PR 1–PR 6
      (`docs/architecture-audit-report.md`,
      `docs/architecture-implementation-roadmap.md`,
      `docs/architecture-first-wave-checklist.md`)

### Files Likely Touched

- `vite.config.ts`
- `docs/architecture-audit-report.md` (new)
- `docs/architecture-implementation-roadmap.md` (new)
- `docs/architecture-first-wave-checklist.md` (new)
- *(root `AGENTS.md` and `README.md` already covered by PR 1)*

### Acceptance Criteria

- [ ] dev server stops failing on inspector port binding in sandboxed
      shells
- [ ] local typecheck output is repo-scoped enough to be actionable
- [ ] architecture framework docs are tracked and cross-referenced

### Verification

- [ ] run `npm run typecheck`
- [ ] inspect output for unrelated external `tsconfig` parsing noise
- [ ] `npm run dev` starts cleanly (no inspector-port EADDRINUSE in
      sandboxed environments)

### Risk Notes

- Keep the Vite config change as small as possible.
- Do not combine this PR with auth behavior changes beyond docs/config
  boundary tightening — those already landed in PR 1.

## PR 3 - D1 Mailbox Directory and Membership Index

Suggested title:

`feat(control-plane): add mailbox directory and membership index`

### Goal

Create a durable global mailbox control plane in D1 for discovery, owner lookup,
and membership lookup.

### Depends on

- PR 1 strongly recommended
- PR 2 optional

### Implementation Checklist

- [ ] Design D1 schema for mailbox directory
- [ ] Add migrations for:
  - `mailboxes`
  - `mailbox_members`
  - optional `mailbox_audit_log`
- [ ] Decide whether owner is stored as:
  - `owner_user_id`
  - plus denormalized `owner_email`
- [ ] Add read/write helpers for mailbox directory operations
- [ ] Add backfill path for existing mailboxes discovered from current storage
- [ ] Ensure new mailbox creation writes control-plane records transactionally
- [ ] Ensure member add/remove writes control-plane records transactionally
- [ ] Keep compatibility with existing mailbox ids and routes

### Files Likely Touched

- D1 migrations
- `workers/lib/auth.ts`
- `workers/index.ts`
- user/mailbox helper modules

### Acceptance Criteria

- [ ] D1 can answer mailbox owner/member questions without consulting R2 ACL blobs
- [ ] new mailboxes populate D1 control-plane records on creation
- [ ] existing mailboxes have a migration/backfill story

### Verification

- [ ] create a mailbox and confirm D1 records exist
- [ ] assign an owner and confirm D1 records update
- [ ] add/remove a member and confirm D1 records update

### Risk Notes

- This is the first persistent control-plane schema change. Keep the migration path explicit.
- Prefer additive rollout first, cutover later.

## PR 4 - API/Admin Cutover to D1 Mailbox Control Plane

Suggested title:

`refactor(mailboxes): cut api and admin flows to D1 control plane`

### Goal

Make the application read and enforce mailbox owner/member semantics from D1.

### Depends on

- PR 3

### Implementation Checklist

- [x] Update `assertMailboxAccess` to use D1 mailbox owner/member state
      *(now reads through D1-first `getMailboxAcl`)*
- [x] Update `assertMailboxOwner` to use D1 mailbox owner state
      *(via the same `getMailboxAcl` path)*
- [x] Update `listUserMailboxes` to use D1 mailbox directory and
      membership index *(via `listMailboxIdsForUser`; admin path also
      surfaces R2-only legacy mailboxes via stale-detection)*
- [x] Update mailbox provisioning endpoints to write/read D1-backed
      control-plane state *(reads via `getMailboxAcl`/D1; writes already
      dual-wrote in PR 3)*
- [x] Update admin owner-assignment endpoints to use D1-backed
      control-plane state *(`GET /api/v1/admin/mailboxes` enumerates
      from D1 via `listUserMailboxes`)*
- [x] Keep a temporary compatibility fallback only where absolutely
      needed during cutover *(R2 self-heal in `getMailboxAcl` for
      un-backfilled legacy mailboxes; logs WARN pointing at the admin
      backfill endpoint)*
- [x] Remove R2 ACL reads from hot authorization paths
      *(`assertMailboxAccess` no longer reads `mailboxes/<id>.json`
      unless D1 misses; admin enumeration no longer iterates
      `BUCKET.list` for ACL)*

### Files Likely Touched

- `workers/lib/auth.ts` — `getMailboxAcl` D1-first + R2 self-heal,
  `assertMailboxAccess` cuts to D1, `listUserMailboxes` rewritten
- `workers/index.ts` — `GET /api/v1/admin/mailboxes` enumerates via D1
- `workers/AGENTS.md`, `workers/lib/AGENTS.md` — trust-boundary docs
  realigned to D1-as-source-of-truth

### Acceptance Criteria

- [x] owner/member semantics are enforced from D1
- [x] mailbox enumeration no longer depends on `BUCKET.list("mailboxes/")`
      *(remaining usages are: admin backfill — by design — and rules
      backfill — same)*
- [x] R2 mailbox JSON is no longer the active ACL source of truth
      *(retained as a self-heal fallback for un-backfilled legacy
      mailboxes; will be removed once a deploy cycle confirms D1
      coverage is complete)*

### Verification

- [ ] verify owner access with user A
- [ ] verify member access with user B
- [ ] verify denied access with user C
- [ ] verify admin can still provision and repair mailbox ownership
- [ ] verify MCP respects the same D1-backed visibility rules

### Risk Notes

- This PR changes real access semantics. Test with multiple users before merge.
- Keep it isolated from mailbox settings migration.

## PR 5 - MailboxDO Settings Table and Read-Path Migration

Suggested title:

`feat(mailbox): add mailbox settings table and migrate read path`

### Goal

Move mailbox-local settings reads into mailbox-owned durable state.

### Depends on

- PR 4 preferred

### Scope

This PR is read-path focused. It should not fully cut writes over yet.

### Implementation Checklist

- [x] Add MailboxDO schema for mailbox-local settings
      *(`workers/db/schema.ts:mailboxSettings` — singleton row keyed by
      `id = 'settings'`)*
- [x] Choose singleton row over key/value rows
      *(every column applies mailbox-wide; arrays JSON-serialised as
      text)*
- [x] Add MailboxDO migration for the settings table
      *(`migrations.ts:15_add_mailbox_settings` — idempotent
      `CREATE TABLE IF NOT EXISTS`)*
- [x] Add DO RPC for reading mailbox settings
      *(`getMailboxSettings()` in `workers/durableObject/index.ts`)*
- [x] Add lazy/backfill read path from legacy R2 settings if mailbox-local
      settings are absent
      *(`getAgentConfig` reads R2 once on DO miss, logs a WARN, and
      self-heals via `replaceMailboxSettings`)*
- [x] Update `workers/lib/agent-config.ts` to read mailbox settings from
      DO-backed state
      *(DO-first via `buildAgentConfigFromDoRow`)*
- [x] Update invoice-source-domain resolution to read from DO-backed state
      *(`resolveInvoiceSourceDomains` calls `getAgentConfig` which is now
      DO-first — no separate path)*
- [x] Confirm rules handling stays untouched where it already uses the DO
      path *(rules continue through `loadRulesForEvaluation`)*

### Files Likely Touched

- `workers/db/schema.ts` — new `mailboxSettings` Drizzle table
- `workers/durableObject/migrations.ts` — `15_add_mailbox_settings`
- `workers/durableObject/index.ts` — three RPCs + helper exports
- `workers/lib/agent-config.ts` — DO-first `getAgentConfig`

### Acceptance Criteria

- [x] agent config reads no longer require R2 mailbox settings as the
      primary source *(R2 is a one-shot self-heal fallback only)*
- [x] mailbox-local prompt/model/domain reads come from mailbox-owned
      state *(via `MailboxSettingsRow`)*

### Risk Notes

- Combined with PR 6 in the same code change because the read + write
  cuts share the DO RPC surface; reviewing them together avoids a
  half-migrated state on `main`.

## PR 6 - Settings Write-Path Cutover and R2 Settings Retirement

Suggested title:

`refactor(settings): cut mailbox settings writes to mailbox-owned state`

### Goal

Finish the mailbox settings migration by cutting writes over to mailbox-owned
state and retiring R2 mailbox settings blobs as the live source of truth.

### Depends on

- PR 5

### Implementation Checklist

- [x] Add DO RPCs for mailbox settings update operations
      *(`replaceMailboxSettings`, `updateMailboxSettings` in
      `workers/durableObject/index.ts`)*
- [x] Update settings save endpoints to write through the DO
      *(`PUT /api/v1/mailboxes/:mailboxId` splits agent-config fields
      off the R2 write path and routes them via
      `updateMailboxSettings`; same treatment for the MCP
      `update_mailbox_settings` tool)*
- [x] Update settings UI mutations to target the new write path
      *(unchanged on the frontend — the existing PUT endpoint now
      transparently routes to the DO; GET merges DO + R2 so the UI
      keeps working without a hooks rewrite)*
- [x] Stop writing mailbox-local agent settings into
      `mailboxes/<id>.json`
      *(`AGENT_CONFIG_FIELDS` blocklist in `workers/index.ts` strips
      these fields from the R2 write payload, including any stale
      cousins on the previous blob)*
- [x] Keep R2 only as one-time migration input if still needed
      *(R2 settings still feed the lazy backfill in `getAgentConfig`
      for un-backfilled legacy mailboxes; not on the active write
      path)*
- [x] Audit for remaining mailbox settings reads/writes against R2 and
      remove them *(grep audit covered `workers/index.ts`,
      `workers/mcp/index.ts`, `workers/lib/agent-config.ts` — only the
      lazy fallback + the unified GET merge path retain R2 reads;
      `setRules` keeps writing to R2 because rules already have their
      own D1-backed store + mirror)*
- [x] Confirm prompt/model/domain changes survive reload and agent
      invocation *(typecheck + manual smoke against the unified GET +
      DO read path; documented in PR description)*

### Files Likely Touched

- `workers/index.ts` — PUT/GET split + agent-config routing helpers
- `workers/lib/agent-config.ts` — `updateAgentConfig` writes through
  DO; `setRules` left on R2 (rules path unchanged)
- `workers/durableObject/index.ts` — three new RPCs + helper exports
- `workers/mcp/index.ts` — `get_mailbox_settings` /
  `update_mailbox_settings` tools cut to the DO
- `workers/AGENTS.md`, `workers/lib/AGENTS.md`,
  `workers/durableObject/AGENTS.md` — trust + settings docs realigned

### Acceptance Criteria

- [x] mailbox-local settings writes go through mailbox-owned state
- [x] R2 mailbox settings blobs are no longer the active source of truth
      for agent config *(retained as a self-heal fallback only)*
- [x] agent config reads and writes are both mailbox-local

### Verification

- [ ] update EmailAgent prompt, reload, confirm it sticks
- [ ] update model overrides, reload, confirm they stick
- [ ] update invoice source domains, reload, confirm they stick
- [ ] verify ordinary mailbox behavior is unaffected

### Risk Notes

- Final cutover PR for the first wave. Rollback strategy: revert this
  PR, run the lazy-backfill path in reverse — the agent-config slice on
  the DO is a strict superset of the R2 fields, so a manual one-shot
  job can re-emit them onto R2 if needed before reverting.
- Before merge, grep for remaining `mailboxes/<id>.json` settings
  reads/writes that should no longer exist *(done — only the lazy
  fallback + GET merge + rules path remain, all by design)*.

## Recommended Issue Breakdown

If you want to create issues before PRs, use this issue sequence:

1. `MCP auth context contract`
2. `Repo trust-boundary docs and typegen boundary cleanup`
3. `D1 mailbox directory schema`
4. `D1 mailbox control-plane cutover`
5. `MailboxDO settings schema and read migration`
6. `Mailbox settings write cutover`

Each issue should carry:

- background
- scope
- non-goals
- acceptance criteria
- verification checklist

## Global Verification Checklist for the First Wave

- [ ] `npm run typecheck`
- [ ] `npm run verify` if clean in the local environment
- [ ] mailbox access tested with at least three principals:
  - owner
  - member
  - unrelated user
- [ ] admin mailbox provisioning tested
- [ ] MCP mailbox visibility tested against the same users
- [ ] EmailAgent prompt/model settings tested after migration
- [ ] InvoiceAgent settings tested after migration
- [ ] no critical mailbox flow still depends on R2 ACL/settings truth

## Done Definition for This Wave

The first wave is complete when:

- [ ] auth semantics are consistent across Worker, API, MCP, and agent surfaces
- [ ] mailbox control-plane auth state is D1-backed
- [ ] mailbox-local agent settings are DO-backed
- [ ] docs reflect the actual trust model
- [ ] the codebase is ready for approval/workflow work on top of a stable base
