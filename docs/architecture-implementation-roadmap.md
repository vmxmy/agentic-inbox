# Architecture Implementation Roadmap

Updated: 2026-04-27

## Purpose

This document turns the findings in
`docs/architecture-audit-report.md`
into an execution roadmap that maps directly to workstreams and PRs.

First-wave issue-ready execution lives in:
`docs/architecture-first-wave-checklist.md`

It is intentionally narrower than the audit report:

- the audit explains what is wrong and why
- this roadmap explains what to build, in what order, and how to cut the work

## Relationship to Other Docs

Use this document together with:

- `docs/architecture-audit-report.md`
  - architecture findings, rationale, target state
- `docs/review-remediation-plan.md`
  - current bugfix and product-correctness repair work
- `docs/architecture-first-wave-checklist.md`
  - issue-ready checklist for PR 1 through PR 6

Recommended split of responsibility:

- `review-remediation-plan.md`
  - current correctness/security regressions and trust-model cleanup
- `architecture-implementation-roadmap.md`
  - next-stage Cloudflare-native platform evolution

## Roadmap Principles

This roadmap follows five principles:

1. No rewrite. Tighten the existing Cloudflare-native shape instead.
2. Fix semantic inconsistency before adding new platform features.
3. Move state out of R2 JSON in slices, not in one big migration.
4. Introduce approvals and workflows only after identity and state boundaries are stable.
5. Prefer PRs that leave the system deployable after each merge.

## Target End State

By the end of this roadmap, the system should have:

- one consistent identity model across UI, API, Agent, and MCP
- mailbox discovery and ACL in a durable control-plane store
- mailbox-local mutable settings in mailbox-owned state
- approval-aware side-effecting tools
- queue/workflow-based background orchestration
- first-class structured observability for agent execution
- a clear path to OAuth-backed MCP and richer mailbox memory

## Delivery Lanes

The work is split into six sequential workstreams plus one optional maturity lane:

1. Contract and boundary alignment
2. Mailbox control-plane normalization
3. Mailbox settings locality migration
4. Approval and Human-in-the-Loop primitives
5. Workflow and observability upgrades
6. Externalization and platform maturity
7. Optional optimization lane: AI Gateway and richer memory

## Sequence Overview

Recommended merge order:

1. PR 1 - MCP auth context contract
2. PR 2 - Repo/doc/runtime boundary alignment
3. PR 3 - D1 mailbox directory and membership index
4. PR 4 - API/admin cutover to D1 mailbox control plane
5. PR 5 - MailboxDO settings table and read-path migration
6. PR 6 - Settings write-path cutover and R2 settings retirement
7. PR 7 - Approval-aware tool contract scaffold
8. PR 8 - Operator approval UX and resume path
9. PR 9 - Queue ingress for async mailbox work
10. PR 10 - Workflow-based OCR/review orchestration
11. PR 11 - Structured agent event pipeline
12. PR 12 - OAuth-backed MCP authorization
13. PR 13 - AI Gateway default path and mailbox memory

If we need a smaller first wave, stop after PR 6. That gets the architecture onto a much healthier base without taking on workflow or OAuth complexity yet.

## Workstream 1: Contract and Boundary Alignment

### Goal

Make identity semantics and local engineering boundaries consistent before any bigger platform moves.

### Why first

Every later workstream depends on stable answers to:

- who is the caller
- what role do they have
- what mailbox scope do they hold
- what is safe to trust across Worker -> DO handoff

### PR 1 - Preserve Full Auth Context Across Worker -> MCP

Suggested title:

`fix(mcp): preserve full auth context across worker boundary`

Scope:

- replace the email-only MCP forwarding contract with a full internal auth context
- stop reconstructing MCP callers as fixed `role: "user"`
- make MCP authorization semantics match HTTP/API semantics

Proposed implementation:

- define an internal auth-context envelope in `workers/lib/auth.ts`
- mint the envelope in `workers/app.ts` during `forwardToMcp(...)`
- verify and decode the envelope in `workers/mcp/index.ts`
- carry:
  - `id`
  - `email`
  - `role`
  - `system`
  - issuance metadata such as `iat` and `aud`

Preferred hardening:

- sign the envelope with a dedicated internal secret or `INTERNAL_SECRET`
- reject unsigned or malformed MCP internal context

Key files:

- `workers/app.ts`
- `workers/mcp/index.ts`
- `workers/lib/auth.ts`
- `workers/types.ts`

Acceptance criteria:

- admin callers retain admin semantics through MCP
- system callers retain system semantics through MCP
- mailbox ACL behavior is identical between API and MCP for the same user

Verification:

- MCP `list_mailboxes` returns the same visibility as `/api/v1/mailboxes`
- admin-only mailbox repair flows behave identically across surfaces

### PR 2 - Align Docs and Tighten Repo-Local Verification Boundaries

Suggested title:

`chore(repo): align trust-boundary docs and constrain local typegen scope`

Scope:

- update repo guidance to reflect native auth primary, Access fallback
- prevent local validation from being polluted by unrelated home-directory `tsconfig` files

Proposed implementation:

- update:
  - `AGENTS.md`
  - `README.md`
  - `docs/architecture-audit-report.md`
- constrain `vite-tsconfig-paths` to repo-local config discovery

Key files:

- `AGENTS.md`
- `README.md`
- `vite.config.ts`

Acceptance criteria:

- docs describe the actual runtime trust model
- `npm run typecheck` is not polluted by unrelated machine state

Verification:

- rerun `npm run typecheck`
- confirm no external `tsconfig` parse noise remains

## Workstream 2: Mailbox Control-Plane Normalization

### Goal

Remove mailbox ownership and membership from ad hoc R2 JSON and move them into a durable control-plane store that is suitable for global mailbox discovery and admin operations.

### Why this is separate from settings migration

Mailbox discovery is global; mailbox settings are mailbox-local.

Trying to solve both in one PR would create unnecessary migration risk. This workstream focuses only on:

- mailbox existence
- owner
- membership
- global lookup

### PR 3 - Add D1 Mailbox Directory and Membership Index

Suggested title:

`feat(control-plane): add mailbox directory and membership index`

Scope:

- add mailbox control-plane tables to D1
- make D1 the durable source for:
  - mailbox id / email
  - owner user id / owner email
  - membership records
  - lifecycle flags such as active / archived if needed

Proposed schema direction:

- `mailboxes`
- `mailbox_members`
- optional `mailbox_audit_log` if admin repair history should be queryable

Design note:

This is the pragmatic control-plane step. It fixes global discovery and ACL indexing without forcing mailbox enumeration through R2.

Key files:

- D1 migrations
- user/mailbox admin helpers
- `workers/lib/auth.ts`
- `workers/index.ts`

Acceptance criteria:

- mailbox listing no longer depends on `BUCKET.list("mailboxes/")`
- owner/member lookup no longer depends on R2 JSON
- new mailbox provisioning writes control-plane state transactionally

Verification:

- create mailbox
- assign owner
- invite member
- confirm D1-backed list/read behavior

### PR 4 - Cut API/Admin Flows Over to D1 Mailbox Control Plane

Suggested title:

`refactor(mailboxes): cut api and admin flows to D1 control plane`

Scope:

- switch read/write auth helpers to D1-backed mailbox ownership and membership
- cut admin and membership endpoints away from R2-backed ACL reads
- keep a temporary R2 compatibility fallback only where necessary

Proposed implementation:

- update `assertMailboxAccess`, `assertMailboxOwner`, `listUserMailboxes`
- migrate mailbox provisioning endpoints
- update admin mailbox-owner assignment paths

Key files:

- `workers/lib/auth.ts`
- `workers/index.ts`
- `app/routes/admin.tsx`
- mailbox/member query hooks and API client methods

Acceptance criteria:

- owner/member semantics are fully D1-backed
- R2 mailbox JSON is no longer the ACL source of truth

Verification:

- run all mailbox owner/member flows with at least two real users
- verify MCP and HTTP both respect the new directory

## Workstream 3: Mailbox Settings Locality Migration

### Goal

Move mailbox-local mutable settings closer to the mailbox coordination unit.

This includes settings used by:

- EmailAgent
- InvoiceAgent
- mailbox-level UI configuration
- model/prompt/source-domain settings

### Scope boundary

Rules are already on a DO-backed path. This workstream should focus on the remaining mailbox-local settings still stored in R2 blobs.

### PR 5 - Add Mailbox Settings Table Inside MailboxDO and Migrate Read Paths

Suggested title:

`feat(mailbox): add mailbox settings table and migrate read path`

Scope:

- add a mailbox-local settings table inside `MailboxDO`
- introduce DO RPCs for reading mailbox settings
- migrate read paths for:
  - agent config
  - invoice source domains
  - mailbox-level prompt/model overrides

Suggested schema direction in MailboxDO SQLite:

- `mailbox_settings`
  - `key`
  - `value_json`
  - `updated_at`
  - `updated_by`

Alternative:

- a single singleton row if that fits existing access patterns better

Key files:

- `workers/db/schema.ts`
- `workers/durableObject/migrations.ts`
- `workers/durableObject/index.ts`
- `workers/lib/agent-config.ts`

Acceptance criteria:

- read-time agent configuration no longer depends on R2 mailbox JSON
- mailbox-local settings reads go through mailbox-owned state

Verification:

- read existing mailbox settings after lazy backfill
- open settings UI
- confirm agent behavior matches previous values

### PR 6 - Cut Settings Writes Over and Retire R2 Mailbox Settings as Source of Truth

Suggested title:

`refactor(settings): cut mailbox settings writes to mailbox-owned state`

Scope:

- migrate settings write paths
- keep R2 compatibility only as one-time backfill input if still needed
- remove mailbox settings mutation from generic R2 writes

Proposed implementation:

- add dedicated mailbox settings update RPCs
- update any UI/API settings save handlers
- remove or isolate remaining `mailboxes/<id>.json` settings writes

Key files:

- `workers/index.ts`
- `workers/lib/agent-config.ts`
- `app/routes/settings.tsx`
- mailbox settings query/mutation hooks

Acceptance criteria:

- mailbox settings writes do not depend on R2 mailbox JSON
- agent config reads and writes are fully mailbox-local
- R2 is no longer the active settings source of truth

Verification:

- save prompt/model/domain settings
- reload page
- open agent chat and verify settings effect

## Workstream 4: Approval and Human-in-the-Loop Primitives

### Goal

Upgrade from product-level confirmation to infrastructure-aware approvals.

### Why after state migration

Approvals need stable identity and state ownership. They are much easier to add after:

- auth context is correct
- mailbox settings are not split across R2 and multiple paths

### PR 7 - Approval-Aware Tool Contract Scaffold

Suggested title:

`feat(agent): add approval-aware tool contract for side effects`

Scope:

- introduce a standard way to declare tool approval requirements
- identify high-side-effect tools and mark them as approval-gated

Likely first approval candidates:

- `send_email`
- `send_reply`
- `forward_email`
- `add_member`
- `remove_member`
- `create_invite`
- external integration changes

Key files:

- `workers/lib/tools.ts`
- agent tool registration surfaces
- MCP wrapper layer

Acceptance criteria:

- approval metadata exists as a first-class part of tool registration
- high-side-effect tools are classifiable as approval-required

Verification:

- tool invocation can enter a pending-approval state instead of executing immediately

### PR 8 - Operator Approval UX and Resume Path

Suggested title:

`feat(ui): add operator approval flow for pending agent actions`

Scope:

- display pending approvals in the app
- allow approve/reject actions
- resume paused work after operator action

Design note:

The first UX does not need to be universal. It only needs to support the narrow set of first approval-gated actions introduced in PR 7.

Key files:

- `app/components/UnifiedAgentPanel.tsx`
- agent chat rendering components
- related server action endpoints or workflow hooks

Acceptance criteria:

- operator can see and resolve pending approvals
- rejected actions do not silently execute
- approved actions resume predictably

Verification:

- create a staged high-side-effect action
- approve once, reject once
- confirm execution semantics are correct

## Workstream 5: Workflow and Observability Upgrade

### Goal

Turn background behavior into traceable, resumable platform flows.

## PR 9 - Queue Async Mailbox Work at Ingress

Suggested title:

`feat(async): queue mailbox background work at ingress`

Scope:

- stop dispatching all mailbox background work directly via internal `fetch` from request path
- use a queue or equivalent buffering boundary for async work initiation

First candidates:

- inbound email auto-draft trigger
- invoice extraction trigger
- deferred attachment/OCR tasks

Key files:

- `workers/index.ts`
- async worker entrypoints
- queue producer/consumer wiring

Acceptance criteria:

- request path does not directly own all background execution timing
- mailbox async work is bufferable and retryable

Verification:

- simulate burst inbound mail
- confirm queue-backed processing still produces drafts/invoice jobs

## PR 10 - Workflow-Based OCR, Review, and Deferred Processing

Suggested title:

`feat(workflows): orchestrate OCR and review with resumable workflows`

Scope:

- move multi-step background tasks into workflow-style orchestration
- add explicit pause/resume points for review-dependent tasks where useful

First workflow candidates:

- PDF OCR retry pipeline
- multi-step invoice extraction
- delayed review/escalation after draft generation

Key files:

- workflow definitions
- invoice/background task glue
- any approval wait points

Acceptance criteria:

- multi-step async flows are resumable
- retries and pause states are explicit rather than implicit

Verification:

- force an OCR failure and confirm retry semantics
- pause a review-dependent flow and confirm resume behavior

## PR 11 - Structured Agent Event Pipeline

Suggested title:

`feat(observability): add structured agent and mailbox event pipeline`

Scope:

- emit structured events for mailbox, agent, tool, MCP, and workflow activity
- aggregate those events centrally for debugging and audit

Suggested event envelope fields:

- `requestId`
- `mailboxId`
- `userId`
- `agentId`
- `toolName`
- `workflowId`
- `surface`
- `outcome`
- `latencyMs`

Key files:

- worker/agent/MCP entrypoints
- shared logging helper
- tail/aggregation integration

Acceptance criteria:

- critical agent actions produce structured events
- mailbox incidents can be reconstructed from logs without relying on ad hoc string search

Verification:

- trace one inbound email through receive -> draft -> approval or send path

## Workstream 6: Externalization and Platform Maturity

### Goal

Make the system durable as an external MCP and multi-model platform, not just an internal app.

### PR 12 - OAuth-Backed MCP Authorization

Suggested title:

`feat(mcp): adopt OAuth-backed authorization for remote clients`

Scope:

- move MCP off API-key-first auth for long-term external integrations
- keep API keys only as internal or fallback credentials if still useful

Proposed implementation direction:

- add OAuth-backed MCP auth provider
- map OAuth subject to the same user/role model used by the main app

Acceptance criteria:

- remote MCP clients can authenticate without long-lived personal API keys
- mailbox scopes remain aligned with the core auth model

Verification:

- connect a remote MCP client through OAuth
- verify mailbox visibility and action scope

### PR 13 - AI Gateway Default Path and Mailbox Memory

Suggested title:

`feat(ai): add gateway-first model routing and mailbox memory`

Scope:

- make AI Gateway the default primary reasoning ingress if product goals justify it
- add structured mailbox memory primitives

Recommended memory layers:

- mailbox instructions
- durable facts/events
- optional short-form operator preferences

Acceptance criteria:

- model routing is observable and centrally governable
- mailbox agents can retain durable non-chat context

Verification:

- inspect gateway analytics for mailbox traffic
- verify remembered mailbox preferences affect future drafts

## Parallelization Guidance

Safe parallel lanes after PR 2:

- PR 3 and smaller doc/UI cleanup can overlap
- PR 5 can start after PR 3 lands, even if PR 4 is still in review
- PR 11 observability scaffolding can begin while PR 9/10 are in flight

Avoid parallelizing:

- PR 1 with any MCP feature work
- PR 3/4 with unrelated mailbox-ownership refactors touching the same auth helpers
- PR 5/6 with large settings UI rewrites in the same files

## Exit Criteria by Milestone

### Milestone A: Architecture Stabilized

Reached after PR 6 when:

- MCP identity semantics are correct
- mailbox ownership/membership are not R2-backed
- mailbox-local agent settings are not R2-backed

### Milestone B: Agent Operations Standardized

Reached after PR 11 when:

- approvals exist for high-side-effect actions
- async work is queue/workflow based
- structured events exist for agent execution

### Milestone C: Platform-Ready

Reached after PR 13 when:

- MCP external auth is durable
- model routing is centrally observable
- mailbox memory is available as a product primitive

## Recommended First Wave

If we want the highest architectural leverage with the lowest execution risk,
the first wave should be:

1. PR 1 - MCP auth context contract
2. PR 2 - boundary and doc alignment
3. PR 3 - D1 mailbox directory and membership index
4. PR 4 - API/admin cutover to D1 control plane
5. PR 5 - MailboxDO settings table and read-path migration
6. PR 6 - settings write-path cutover

That wave removes the most important structural debt:

- inconsistent authorization semantics
- R2-backed mailbox ACL
- R2-backed mailbox-local settings

It also leaves later approval/workflow work on a much safer base.
