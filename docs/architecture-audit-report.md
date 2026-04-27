# Architecture Audit Report

Updated: 2026-04-27

## Purpose

This document captures a full-stack architecture audit of `agentic-inbox` in its current MVP state, with the review standard anchored to Cloudflare's current Agents, MCP, Durable Objects, and related platform guidance.

Execution follow-up lives in:
`docs/architecture-implementation-roadmap.md`

The goal is not to restate the codebase, but to answer four concrete questions:

1. Is the current architecture viable as an MVP?
2. How closely does it align with a "Cloudflare-standard" agent infrastructure shape?
3. What are the highest-risk architectural gaps right now?
4. What is the most pragmatic remediation order from MVP to durable platform?

## Executive Summary

`agentic-inbox` already has a strong Cloudflare-native spine:

- Stateless edge entry via a Worker
- Stateful coordination via Durable Objects
- Per-mailbox isolation as the primary scaling unit
- Shared business-tool layer reused by HTTP API, Agent, and MCP
- AI behavior constrained to draft-first workflows rather than autonomous sending

That said, the system is still best described as an `agent-enabled inbox application`, not yet a `Cloudflare-standardized agent infrastructure platform`.

The biggest gaps are not in raw functionality. They are in platform discipline:

- MCP identity and authorization semantics are inconsistent with the main app
- Mailbox state is split across SQLite-in-DO and R2 JSON, weakening locality
- Approval and long-running orchestration are still mostly application-managed
- Agent observability is not yet first-class
- Model gateway and memory layers are still thin relative to Cloudflare's full stack

### Overall Rating

- MVP viability: `A-`
- Cloudflare-native application structure: `B`
- Cloudflare-standard agent infrastructure maturity: `B- / C+`

### Release Posture

- Safe to continue as a controlled MVP: `Yes`
- Ready to serve as an externally integrated MCP platform: `Not yet`
- Ready to be considered a reference-grade Cloudflare agent architecture: `Not yet`

## Scope and Inputs

This review is based on:

- Repository structure and current implementation
- `docs/cloudflare_agents_week_2026_tutorial.md`
- `README.md`
- `wrangler.jsonc`
- Worker entry, API, DO, Agent, MCP, and shared tooling code
- Current Cloudflare developer documentation for:
  - Agents
  - Durable Objects
  - MCP authorization
  - Human in the Loop
  - Observability
  - AI Gateway
  - Memory

Primary implementation evidence used during the review:

- `workers/app.ts`
- `workers/index.ts`
- `workers/agent/index.ts`
- `workers/mcp/index.ts`
- `workers/durableObject/index.ts`
- `workers/lib/auth.ts`
- `workers/lib/tools.ts`
- `workers/lib/llm-models.ts`
- `app/components/UnifiedAgentPanel.tsx`
- `vite.config.ts`

## Current Architecture Snapshot

At a high level, the system currently looks like this:

```text
Browser SPA / MCP Client
  -> Hono Worker
     - auth resolution
     - API routing
     - React Router SSR
     - MCP forwarding
     - agent WebSocket routing
  -> MailboxDO
     - per-mailbox SQLite
     - folders, emails, attachments, search, invoice data
  -> EmailAgent
     - AIChatAgent chat surface
     - auto-draft on inbound email
  -> InvoiceAgent
     - AIChatAgent chat surface
     - invoice extraction workflows
  -> EmailMCP
     - MCP tool surface over the same mailbox capabilities
  -> R2
     - attachments
     - mailbox settings / ACL blobs
  -> D1
     - native auth users / sessions / API keys / LLM provider metadata
  -> External/OpenAI-compatible LLM endpoint
     - primary reasoning
  -> Workers AI
     - safety checks such as prompt-injection and draft verification
```

This is a credible MVP architecture. The main review question is whether the trust boundaries, state ownership, and orchestration model are ready for the next stage.

## Review Framework

The review uses a Cloudflare-aligned rubric:

1. Compute and execution model
2. State locality and persistence
3. Network, trust boundary, and auth propagation
4. Agent tool safety and Human in the Loop
5. Long-running orchestration
6. MCP surface design and authorization
7. Model routing, observability, and memory
8. Operational ergonomics and engineering boundary hygiene

## What the Project Already Does Well

### 1. Correct macro split between stateless edge and stateful coordination

The Worker entrypoint in `workers/app.ts` is acting as a transport and policy layer, while the mailbox DO owns mailbox-local state and coordination. This is the right high-level split for Cloudflare.

Why this matters:

- Stateless request fan-in stays cheap and elastic
- Mailbox state avoids cross-request race conditions
- The DO becomes the right boundary for mailbox serialization and consistency

### 2. Per-mailbox isolation is the right primary scaling atom

Using one DO per mailbox is a strong design choice. It is materially better than either:

- one global inbox DO, which would become a coordination hotspot
- or fully stateless mailbox access, which would push consistency complexity back into application logic

For an inbox product, `mailbox` is a sound first-order agent/session coordination unit.

### 3. Shared tool logic across Agent and MCP is excellent

The shared business logic in `workers/lib/tools.ts` is one of the healthiest architectural choices in the codebase.

Benefits:

- fewer semantic drifts between chat agent and MCP caller
- simpler security review
- easier auditability of mailbox side effects
- smaller long-term maintenance surface

### 4. Draft-only AI behavior is an appropriate MVP safety boundary

The default EmailAgent prompt explicitly constrains behavior to drafting rather than direct sending. For a production-like inbox product, this is the right default safety stance.

This does not replace formal approvals, but it does reduce the blast radius substantially.

### 5. Multi-agent separation by responsibility is sensible

Keeping `EmailAgent` and `InvoiceAgent` as separate surfaces helps preserve:

- clearer prompts
- tighter tool allowlists
- simpler future approvals
- easier per-agent observability

This is better than one overloaded agent with mixed roles and diffuse tool privileges.

## Findings by Severity

## HIGH 1: MCP authorization semantics lose admin identity

### Summary

The main Worker authenticates the caller correctly, but the MCP handoff collapses the authenticated user into an email-only identity and reconstructs a synthetic MCP user with `role: "user"`. As a result, the MCP surface does not preserve admin semantics consistently with the HTTP/UI surface.

### Evidence

- `workers/app.ts` forwards only `x-internal-user-email`
- `workers/mcp/index.ts` rebuilds the caller as:
  - synthetic id
  - normalized email
  - `role: "user"`
- `workers/lib/auth.ts` defines admin based on `user.role === "admin"`

Relevant files:

- `workers/app.ts`
- `workers/mcp/index.ts`
- `workers/lib/auth.ts`
- `README.md`

### Why this matters

This creates a real trust-model divergence:

- UI/API may treat a principal as admin
- MCP may treat the same principal as a normal user

That is not just a documentation issue. It affects:

- mailbox discoverability
- ownerless mailbox repair flows
- future admin-only tools
- confidence that MCP honors the same contract as the app

### Risk

- Authorization inconsistency across surfaces
- Confusing operator behavior
- Future privilege bugs when MCP expands

### Recommendation

Do not propagate only the email. Propagate a signed internal identity envelope for MCP that includes:

- user id
- email
- role
- system flag when applicable

Preferred directions:

1. Internal signed context header(s) carrying full identity
2. Or MCP-side identity re-resolution from a durable auth source
3. Or replace the ad hoc propagation model with a standard OAuth-backed MCP auth flow

### Priority

`P0`

## HIGH 2: Mailbox metadata is not fully co-located with the mailbox coordination unit

### Summary

Mailbox message state lives in `MailboxDO` SQLite, but mailbox ACL, ownership, and some settings still live in R2 JSON blobs. This weakens the mailbox as a complete consistency boundary.

### Evidence

- `MailboxDO` owns email state in durable SQLite
- `workers/lib/auth.ts` reads settings from R2 `mailboxes/<id>.json`
- mailbox enumeration uses `BUCKET.list({ prefix: "mailboxes/" })`

Relevant files:

- `workers/durableObject/index.ts`
- `workers/lib/auth.ts`

### Why this matters

Cloudflare's DO model is strongest when the coordination unit owns the state that must be read and updated consistently together.

The current split introduces long-term costs:

- ACL and mailbox content are not naturally transacted together
- mailbox discovery becomes storage-backend specific
- ownership and settings writes are harder to audit
- future migrations become more expensive
- policy checks rely on a state store outside the mailbox DO

### Risk

- State locality erosion
- Drift between mailbox policy and mailbox content behavior
- Slower future product evolution

### Recommendation

Move mailbox metadata into one of these two models:

1. Preferred: mailbox ownership, ACL, and mutable settings move into `MailboxDO` SQLite
2. Acceptable transitional option: a dedicated D1 mailbox metadata table, with clear ownership semantics and migration path into or alongside MailboxDO

R2 should remain focused on:

- attachments
- large immutable payloads
- optional export/snapshot artifacts

### Priority

`P1`

## MEDIUM 1: Human in the Loop is product-level, not infra-level

### Summary

The product currently keeps humans in control by requiring explicit user send actions after drafts are created. That is a good product behavior, but it is not the same as adopting Cloudflare's native approval infrastructure.

### Evidence

- EmailAgent tool execution is direct
- no `needsApproval` pattern present
- no workflow approval pause/resume wiring present
- current safety model relies primarily on prompt constraints and product flow

Relevant files:

- `workers/agent/index.ts`
- `workers/lib/tools.ts`
- `app/components/UnifiedAgentPanel.tsx`

### Why this matters

This is sufficient for today's draft-first flow, but it will not scale cleanly when the system gains more side-effecting tools, such as:

- outbound send actions from agent surfaces
- member/invite operations through agent tools
- external integration callbacks
- invoice-side automations

### Recommendation

Short term:

- keep draft-only behavior
- explicitly mark side-effecting tools as approval candidates

Medium term:

- adopt Cloudflare-style tool approvals for high-risk tools
- introduce workflow-based pause/resume for tasks that wait on operator review

### Priority

`P1.5`

## MEDIUM 2: Long-running orchestration is still application-managed

### Summary

Inbound email and invoice processing currently rely on `ctx.waitUntil(...)` plus internal fetch dispatch. This is practical, but it is still an application-managed async model rather than a first-class long-running orchestration model.

### Evidence

- auto-draft dispatch via internal `fetch("/onNewEmail")`
- invoice extraction flow already hints at staged background work
- code contains explicit deferred/future wiring comments

Relevant files:

- `workers/index.ts`
- `workers/invoice-agent/index.ts`

### Why this matters

As the workflow surface expands, you will increasingly need:

- retries
- pause/resume
- manual intervention
- idempotent checkpoints
- stage visibility
- queue backlog control

All of those become harder when each subsystem invents its own async semantics.

### Recommendation

Gradually move long-running flows into Cloudflare-native orchestration patterns:

- Queue for burst smoothing
- Workflow for multi-step resumable processes
- Schedule where delayed or periodic wake-ups are needed

Best first candidates:

- invoice OCR retries
- deferred attachment processing
- multi-step draft review/escalation

### Priority

`P2`

## MEDIUM 3: MCP auth is functional, but not Cloudflare-standardized

### Summary

The current MCP auth model uses per-user API keys. This is workable for an internal or controlled deployment, but it is not the standard shape Cloudflare now presents for remote MCP authorization.

### Evidence

- README positions API keys as the MCP client auth path
- Worker middleware supports bearer API keys before cookie session
- MCP forwarding is custom and internal-header based

Relevant files:

- `README.md`
- `workers/app.ts`
- `workers/index.ts`
- `workers/mcp/index.ts`

### Why this matters

API keys are acceptable for:

- internal tooling
- controlled operator access
- stopgap interoperability

They are weaker as the primary long-term external auth model because they are:

- coarse
- long-lived by default
- harder to rotate ergonomically
- weaker for delegated authorization

### Recommendation

If MCP remains internal-only, API keys are acceptable in the short term.

If MCP is meant to be a stable remote integration surface, move toward:

- OAuth 2.1-based MCP authorization
- or Cloudflare Access-backed service identities with proper subject mapping

### Priority

`P2`

## MEDIUM 4: Observability is enabled at the Worker, not at the agent system level

### Summary

The deployment enables Worker observability, but agent lifecycle observability is not yet a first-class architecture component.

### Evidence

- `wrangler.jsonc` enables general observability
- repository does not yet wire agent-specific observability subscription or event aggregation
- operational visibility still depends largely on scattered logs

Relevant files:

- `wrangler.jsonc`
- Worker and agent implementation files

### Why this matters

Agent systems need more than request logs. They need structured events around:

- tool selection
- tool execution
- approval requested/approved/rejected
- workflow paused/resumed/completed
- inbound email received
- draft created
- MCP invocation and caller scope

Without this, debugging becomes slow and forensic confidence stays low.

### Recommendation

Introduce a structured event model and centralized aggregation for:

- mailbox id
- user id
- agent id
- request id
- tool id
- workflow id
- outcome

### Priority

`P2`

## MEDIUM 5: Primary model routing bypasses Cloudflare's standard gateway layer

### Summary

Primary reasoning is routed through a configurable OpenAI-compatible endpoint rather than Cloudflare AI Gateway. Workers AI remains in use mainly for safety functions.

### Evidence

- `LLM_BASE_URL` and `LLM_DEFAULT_MODEL` are first-class config
- `workers/lib/llm-models.ts` resolves a custom OpenAI-compatible provider
- Workers AI is still used for prompt-injection and draft verification

Relevant files:

- `wrangler.jsonc`
- `workers/lib/llm-models.ts`
- `workers/lib/ai.ts`

### Why this matters

This is not an architectural flaw. It is a strategic tradeoff.

Pros:

- model vendor flexibility
- easy LiteLLM/self-hosted compatibility
- decoupling from a single platform provider

Cons:

- weaker default observability
- weaker standard rate-limit/fallback/caching surface
- more custom routing logic over time

### Recommendation

Keep the current provider abstraction.

But if the platform evolves toward:

- cost governance
- fallback routing
- analytics by model/tool/tenant
- centralized policy

then AI Gateway should become the default front door.

### Priority

`P3`

## LOW 1: Memory is still mostly chat history, not agent memory

### Summary

The system persists chat history through `AIChatAgent`, but does not yet implement structured memory for mailbox- or operator-level learned context.

### Why this matters

For inbox agents, memory is where durable value compounds:

- preferred reply tone
- team instructions
- vendor quirks
- invoice normalization corrections
- frequent contact preferences

### Recommendation

Adopt memory in layers:

1. short-lived session memory
2. mailbox instruction memory
3. durable learned facts and events

### Priority

`P3`

## LOW 2: Documentation and engineering boundaries have drifted

### Summary

The repo's implementation has evolved faster than some of its higher-level guidance and build boundary assumptions.

### Evidence

- root `AGENTS.md` still emphasizes Access as the production trust boundary
- implementation and README now treat native auth as primary and Access as fallback
- local `typecheck` output can be polluted by unrelated home-directory `tsconfig` files because `vite-tsconfig-paths` is not boundary-constrained

Relevant files:

- `AGENTS.md`
- `README.md`
- `workers/app.ts`
- `vite.config.ts`

### Recommendation

- update root guidance to reflect the new auth truth
- constrain tsconfig discovery to the repo boundary
- keep architecture docs aligned with the real trust model

### Priority

`P0`

## Alignment by Cloudflare Architecture Domain

## 1. Compute

### Current state

- Good use of Workers as stateless edge entry
- Good use of Durable Objects as stateful coordination units
- Agent runtime integrated directly into DOs

### Assessment

`Strong`

### Notes

This is already Cloudflare-native in shape.

## 2. State and Storage

### Current state

- Message state in DO SQLite
- Auth/session/provider metadata in D1
- Attachments in R2
- ACL/settings partially in R2 JSON

### Assessment

`Mixed`

### Notes

The overall storage palette is correct, but state locality is not fully resolved.

## 3. Network and Security

### Current state

- layered auth resolution in Worker middleware
- internal system header for worker-to-worker actions
- per-mailbox ACL checks
- prompt-injection pre-screening

### Assessment

`Good with one important inconsistency`

### Notes

The biggest issue here is not missing auth. It is cross-surface auth semantic drift, especially on MCP.

## 4. Agent Toolbox

### Current state

- Agents SDK in active use
- AIChatAgent persistence and WebSocket transport in place
- shared tool layer
- Workers AI safety checks
- custom OpenAI-compatible model layer

### Assessment

`Good application-level use, partial infra-level adoption`

### Notes

The code uses agent primitives well, but not yet the full platform envelope around approvals, observability, and standardized MCP auth.

## 5. Standards and Measurement

### Current state

- Worker observability enabled
- typecheck exists
- architecture and progress docs exist

### Assessment

`Early-stage`

### Notes

The system still needs better standardized operational signals and cleaner boundary enforcement.

## Target Architecture

The desired next-stage architecture should look like this:

```text
Browser / MCP Client
  -> Edge Worker Gateway
     - auth
     - request validation
     - signed internal identity propagation
     - audit envelope
  -> MailboxDO
     - mailbox message state
     - mailbox ACL / owner / settings
     - mailbox-local search/index operations
  -> EmailAgent / InvoiceAgent
     - chat/session state
     - constrained tool execution
     - approval-aware operations
     - memory hooks
  -> Workflows / Queues / Scheduling
     - auto-draft pipelines
     - OCR retries
     - deferred attachment processing
     - escalation / review waiting states
  -> R2
     - attachments
     - optional artifacts / exports / snapshots
  -> D1
     - global auth
     - API credential records
     - admin/provider/global control-plane metadata
  -> AI Gateway / Workers AI
     - primary routing
     - safety models
     - analytics / fallback / rate controls
  -> Tail Worker / structured logs
     - mailboxId
     - userId
     - agentId
     - toolId
     - workflowId
     - outcome
```

## Phased Remediation Plan

## P0: Correctness and Boundary Repair

Goals:

- restore semantic consistency across surfaces
- align docs with reality
- tighten engineering boundaries

Actions:

- fix MCP identity propagation so role/system context survives the Worker to MCP handoff
- update root architecture guidance to reflect native auth primary, Access fallback
- constrain `vite-tsconfig-paths` discovery to the repo boundary

Success criteria:

- admin semantics are consistent across HTTP, UI, and MCP
- docs match the actual trust model
- local verification is not polluted by unrelated machine state

## P1: State Locality Cleanup

Goals:

- make mailbox the true policy and coordination unit

Actions:

- migrate mailbox ACL, owner, and mutable settings away from R2 JSON
- prefer MailboxDO SQLite ownership of mailbox metadata
- keep R2 focused on attachments and large blobs

Success criteria:

- mailbox reads and policy checks are locally coherent
- mailbox discovery no longer depends on R2 list scanning
- mailbox state migrations become simpler and more auditable

## P1.5: Formalize Human Approval

Goals:

- move from product-only confirmation to infrastructure-aware approvals

Actions:

- classify side-effecting tools by approval requirement
- add approval-aware tool plumbing
- design the UI event model for pending tool approvals

Success criteria:

- side-effecting operations can pause for operator approval
- approval state is observable and resumable

## P2: Workflow and Observability Upgrade

Goals:

- standardize asynchronous orchestration
- make agent operations debuggable as a system

Actions:

- move deferred flows toward Queue / Workflow / Schedule
- add structured event emission for mailbox, agent, tool, and MCP events
- aggregate agent events centrally

Success criteria:

- long-running tasks are resumable and inspectable
- an operator can trace a mailbox event through tool and workflow execution

## P3: Platform Maturity

Goals:

- make the system durable as a broader integration platform

Actions:

- move MCP toward OAuth-based authorization where appropriate
- evaluate AI Gateway as default primary routing layer
- add structured memory for instructions, facts, and learned mailbox context

Success criteria:

- remote MCP integrations follow a durable auth model
- model routing and analytics are standardized
- agent quality improves through persistent contextual memory

## Recommended Near-Term Work Order

If only three architectural moves are made next, they should be:

1. Fix MCP identity propagation and role preservation
2. Move mailbox metadata out of R2 JSON and into a mailbox-owned state model
3. Add formal approval/orchestration primitives for future side-effecting tools

These three changes will remove the sharpest architectural debt without forcing a rewrite.

## Audit Verdict

`agentic-inbox` is already a legitimate Cloudflare-native MVP. The architecture is not misguided. It is simply one phase earlier than a full Cloudflare-standard agent infrastructure.

The project's core strength is that its main abstractions are mostly correct:

- Worker at the edge
- DO as mailbox coordinator
- per-agent surfaces
- shared tool layer
- safe draft-first operator workflow

The project's main weakness is that platform concerns are still partially embedded in application code rather than fully expressed through Cloudflare's newer agent infrastructure patterns.

The recommendation is therefore:

- do not rewrite the architecture
- do not flatten it into a generic app stack
- instead, tighten the existing Cloudflare-native shape until the trust model, state locality, orchestration, and observability are all first-class

## References

- Cloudflare Agents: Agent class
  - https://developers.cloudflare.com/agents/concepts/agent-class/
- Cloudflare Agents: Long-running agents
  - https://developers.cloudflare.com/agents/concepts/long-running-agents/
- Cloudflare Agents: Human in the Loop
  - https://developers.cloudflare.com/agents/concepts/human-in-the-loop/
- Cloudflare Agents: MCP authorization
  - https://developers.cloudflare.com/agents/model-context-protocol/authorization/
- Cloudflare Agents: Email API reference
  - https://developers.cloudflare.com/agents/api-reference/email/
- Cloudflare Durable Objects: Rules of Durable Objects
  - https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Cloudflare Agents: Observability
  - https://developers.cloudflare.com/agents/api-reference/observability/
- Cloudflare AI Gateway
  - https://developers.cloudflare.com/ai-gateway/
- Cloudflare Agents: Memory
  - https://developers.cloudflare.com/agents/concepts/memory/
