# Cloudflare Agentic Cloud 2026 Guide

Updated: 2026-04-28

## Purpose

This document collects the current Cloudflare agent infrastructure launched or
highlighted during Agents Week 2026 and turns it into a practical build guide
for Agentic Inbox.

It is based on:

- Cloudflare Agents Week 2026 landing page and roundup
- Cloudflare product announcement posts from Agents Week
- Cloudflare Agents SDK, Workflows, Email Service, and related docs
- Cloudflare Skills repository guidance for agent builders
- This repository's existing Cloudflare Agents Week tutorial

The result is intentionally product-facing and implementation-facing: it should
help decide what Agentic Inbox should adopt now, what to defer, and how to map
Cloudflare's primitives to an agent-native mailbox platform.

For the local extension model that maps Cloudflare Agents, skills, and MCP into
Agentic Inbox, see
[Agent Tool Extension Architecture](agent-tool-extension-architecture.md).

## Executive Summary

Cloudflare's 2026 agent infrastructure is organized around a clear thesis:
agents are not another request/response workload. They are durable, stateful,
identity-bearing, tool-using workers that may run one-per-user, one-per-task,
one-per-thread, or one-per-mailbox.

The useful mental model for Agentic Inbox is:

```
Agent identity and realtime state  -> Agents SDK on Durable Objects
Durable background execution       -> Workflows / Queues
Mailbox-local state                -> Durable Object SQLite
Global control plane               -> D1
Large artifacts                    -> R2 / Artifacts
Search and recall                  -> AI Search / Agent Memory
Model access                       -> Workers AI + AI Gateway
Human and external channels        -> Email Service / Browser Run / Voice
Agent tool boundary                -> Capabilities + MCP
Security and governance            -> Access, Gateway, Mesh, scopes, audit
```

For this project, Cloudflare Email Service and Agents SDK are not optional
decorations. They are the product substrate:

- email is the session and workflow event layer
- mailbox Durable Objects are the per-role data plane
- D1 is the global control plane
- R2 is the artifact plane
- MCP and built-in agents expose the same capability layer

## Source Index

Primary roundup:

- Agents Week 2026 landing page: https://www.cloudflare.com/agents-week/
- Agents Week roundup: https://blog.cloudflare.com/agents-week-in-review/
- Cloudflare internal AI engineering stack: https://blog.cloudflare.com/internal-ai-engineering-stack/

Core build docs:

- Agents SDK docs: https://developers.cloudflare.com/agents/
- Agents quick start: https://developers.cloudflare.com/agents/getting-started/quick-start/
- Durable execution: https://developers.cloudflare.com/agents/api-reference/durable-execution/
- Workflows durable agent guide: https://developers.cloudflare.com/workflows/get-started/durable-agents/
- Email Service docs: https://developers.cloudflare.com/email-service/
- Email Workers API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/

Agents Week components:

- Project Think: https://blog.cloudflare.com/project-think/
- Email Service public beta: https://blog.cloudflare.com/email-for-agents/
- Enterprise MCP reference architecture: https://blog.cloudflare.com/enterprise-mcp/
- AI platform / inference layer: https://blog.cloudflare.com/ai-platform/
- AI Search: https://blog.cloudflare.com/ai-search-agent-primitive/
- Agent Memory: https://blog.cloudflare.com/introducing-agent-memory/
- Browser Run: https://blog.cloudflare.com/browser-run-for-ai-agents/
- Artifacts: https://blog.cloudflare.com/artifacts-git-for-agents-beta/
- Sandboxes GA: https://blog.cloudflare.com/sandbox-ga/
- Sandbox auth / egress controls: https://blog.cloudflare.com/sandbox-auth/
- Durable Object Facets in Dynamic Workers: https://blog.cloudflare.com/durable-object-facets-dynamic-workers/
- Workflows V2: https://blog.cloudflare.com/workflows-v2/
- Cloudflare Mesh: https://blog.cloudflare.com/mesh/
- Managed OAuth for Access: https://blog.cloudflare.com/managed-oauth-for-access/
- Non-human identity security: https://blog.cloudflare.com/improved-developer-security/
- Flagship feature flags: https://blog.cloudflare.com/flagship/
- Agent Readiness Score: https://blog.cloudflare.com/agent-readiness/
- Redirects for AI Training: https://blog.cloudflare.com/ai-redirects/

Agent skills:

- Cloudflare Skills repo: https://github.com/cloudflare/skills
- Cloudflare general skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/cloudflare/SKILL.md
- Agents SDK skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/agents-sdk/SKILL.md
- Email Service skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/cloudflare-email-service/SKILL.md
- Durable Objects skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/durable-objects/SKILL.md
- Sandbox SDK skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/sandbox-sdk/SKILL.md
- Workers best practices skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/workers-best-practices/SKILL.md
- Wrangler skill: https://raw.githubusercontent.com/cloudflare/skills/main/skills/wrangler/SKILL.md

## Agents Week Inventory

Cloudflare's Agents Week roundup is useful because it groups the platform into
five operational layers. Agentic Inbox should track those layers instead of
treating each announcement as a disconnected product.

### Compute

| Primitive | What it gives agents | Agentic Inbox stance |
| --- | --- | --- |
| Dynamic Workers | low-latency generated JavaScript execution | later, admin/developer tooling only |
| Durable Object Facets | sub-agents or generated services with isolated state | later, multi-agent mailbox decomposition |
| Workflows V2 | durable steps, retries, waits, long-running orchestration | near-term foundation |
| Sandboxes GA | full Linux execution with files, ports, commands, package installs | optional high-power capability |
| Artifacts | Git-compatible, versioned agent workspaces backed by Cloudflare storage | later artifact/versioning layer |

### Security And Governance

| Primitive | What it gives agents | Agentic Inbox stance |
| --- | --- | --- |
| Cloudflare Mesh | private network connectivity for agents and Workers | enterprise optional |
| Managed OAuth for Access | agent-friendly auth to internal apps | optional Access integration |
| Resource-scoped API tokens | least-privilege non-human identity | model for future scoped keys |
| Enterprise MCP architecture | managed MCP discovery, auth, inspection, portals | reference architecture for `/mcp` |
| Sandbox auth / egress controls | network-injected credentials and outbound policy | required before sandbox/browser powers |

### Agent Toolbox

| Primitive | What it gives agents | Agentic Inbox stance |
| --- | --- | --- |
| Email Service | bidirectional email as an agent channel | core product substrate |
| AI Gateway / Workers AI | model routing, observability, hosted inference | core plus near-term AI Gateway hardening |
| AI Search | managed retrieval over explicit namespaces | near-term mailbox knowledge pilot |
| Agent Memory | durable semantic facts/events/instructions/tasks | later, explicit and deletable |
| Browser Run | browser automation with live view and handoff | optional high-power integration |

### Prototype To Production

| Primitive | What it gives agents | Agentic Inbox stance |
| --- | --- | --- |
| Agents SDK | stateful agents, chat, MCP, email, schedules, workflows | core |
| `cf` and Wrangler | deploy/setup/control-plane automation | Wrangler remains baseline |
| Flagship | feature flags and rollout control | later for risky agent features |
| Agent Lee | dashboard helper for Cloudflare operations | operational convenience, not runtime |
| Workers Builds | safer build/deploy flow | later deploy hygiene |

### Agentic Web

| Primitive | What it gives agents | Agentic Inbox stance |
| --- | --- | --- |
| Agent Readiness Score | measurement of agent-friendly sites/docs | later for public docs |
| Redirects for AI Training | agent/crawler-aware routing | not core |
| AI Crawl Control / Radar AI insights | visibility and control over AI crawler traffic | later docs/site governance |
| Shared Dictionaries / network work | lower-latency agent traffic | platform benefit, no app work |

## Official Cloudflare Skills To Reuse

Cloudflare's skills are intentionally retrieval-first. They repeatedly say to
trust current docs, API specs, Workers types, and Wrangler schemas over model
memory. For this repository, that means every future Cloudflare-facing PR
should start from the relevant skill plus live docs before changing code.

Use these skills as project policy references:

| Skill | Use when | Repository implication |
| --- | --- | --- |
| `agents-sdk` | creating or changing agent classes, chat, MCP, Workflows, durable execution, queues, email, WebSockets | validate `agents` APIs against docs before implementation |
| `cloudflare-email-service` | sending, receiving, routing, `onEmail`, deliverability, Wrangler email setup | keep Email Routing and Email Sending setup current |
| `durable-objects` | changing mailbox/agent DO storage, RPC, alarms, migrations | preserve per-mailbox coordination and SQLite source-of-truth rules |
| `sandbox-sdk` | adding OS execution, ports, files, git, code interpreter | require owner/admin opt-in, egress policy, and audit first |
| `workers-best-practices` | changing Worker handlers, bindings, secrets, streaming, background work | prefer bindings, `ctx.waitUntil`, Queues/Workflows, generated Env types |
| `wrangler` | deploy, migrations, secrets, generated types, email commands | document commands and never hardcode secrets |

Practical rule:

1. Use the skill to identify the correct Cloudflare docs and gotchas.
2. Verify current syntax or limits from the official docs or local package
   types.
3. Encode the result in this repository's docs, config, tests, or typecheck
   workflow so the knowledge survives the PR.

## Agentic Inbox Target Blueprint

The target architecture is a Cloudflare-native agent platform with email as its
durable workflow protocol:

```
External actors
  - browser user
  - MCP client
  - inbound email sender
  - API-key caller
        |
        v
Hono Worker boundary
  - native session / API key / optional Access auth
  - mailbox ACL and capability policy
  - signed internal auth-context envelope
  - SSR/API/MCP/agent routing
        |
        +--> D1 control plane
        |     users, sessions, API keys, mailbox directory, membership,
        |     provider config, audit, capability policy
        |
        +--> MailboxDO data plane
        |     email records, threads, folders, drafts, local workflow state
        |
        +--> R2 artifact plane
        |     attachment bytes, large extracted artifacts, future snapshots
        |
        +--> EmailAgent / InvoiceAgent
        |     Agents SDK, AIChatAgent, mailbox-scoped tools, future workflows
        |
        +--> EmailMCP
        |     remote MCP facade over the same capability registry
        |
        +--> Background execution
              Queues for short retries, Workflows for durable multi-step jobs
```

The invariant is:

> The LLM proposes and orchestrates. Capabilities authorize and execute.
> MailboxDO/D1/R2 persist. Email remains the external session record.

## Cloudflare Agentic Cloud Stack

### 1. Agent Runtime

Use for:

- one agent per mailbox
- one agent per customer
- one agent per task
- one agent per email thread
- realtime chat or WebSocket-connected assistants

Cloudflare primitive:

- Agents SDK
- Durable Objects
- DO SQLite
- WebSockets
- AIChatAgent

Key design points:

- An agent is a TypeScript class.
- Each agent runs as a Durable Object with persistent identity and state.
- Agents can hibernate when idle and wake on HTTP, WebSocket, scheduled alarm,
  or email events.
- State can live in `this.state` and in the agent's embedded SQLite database.
- `@callable()` exposes typed RPC methods to clients.
- `routeAgentRequest()` maps HTTP/WebSocket requests to named agent instances.

Agentic Inbox mapping:

- `EmailAgent` and `InvoiceAgent` should remain mailbox-scoped agents.
- Future agents should attach to a mailbox role, not to global user authority.
- Agent state should never become the only source of truth for mailbox email
  data; mailbox data remains in `MailboxDO`.

### 2. Durable Agent Execution

Use for:

- LLM/tool loops that must survive interruption
- long-running research or extraction
- agent work that can be resumed after Durable Object eviction

Cloudflare primitives:

- `runFiber()`
- `stash()`
- `onFiberRecovered()`
- Workflows
- Queues

How to choose:

| Need | Use |
| --- | --- |
| Part of the agent's own turn, minutes-scale, checkpointable | Agent durable execution / fibers |
| Multi-step job with independent retry, waits, human approval, hours/days | Workflows |
| Fire-and-forget background task, simple retry, fanout | Queues |

Agentic Inbox mapping:

- inbound email persistence should stay fast and reliable
- auto-draft, attachment extraction, OCR, invoice parsing, webhook dispatch, and
  external integrations should move behind Queues or Workflows
- human approval for sensitive actions belongs in Workflows, not ad hoc
  in-memory agent loops

### 3. Execution Ladder

Cloudflare's Project Think describes a ladder of execution environments. This
is useful for deciding how much power an agent should receive.

| Tier | Capability | Cloudflare primitive | Agentic Inbox default |
| --- | --- | --- | --- |
| 0 | durable files/search/diff | Workspace over SQLite/R2 | Later |
| 1 | untrusted JS snippets | Dynamic Workers / Code Mode | Later |
| 2 | npm package resolution | worker-bundler + Dynamic Workers | Later |
| 3 | browser automation | Browser Run | Optional integration skill |
| 4 | full OS toolchains | Sandboxes | Explicit owner/admin opt-in |

Principle:

Start with mailbox capabilities. Escalate to code, browser, or sandbox only
when the mailbox owner intentionally enables that power.

### 4. Sandboxes

Use for:

- full Linux environment
- cloning repos
- installing dependencies
- running CI or command-line tools
- executing generated code that needs an OS

Cloudflare primitive:

- Sandbox SDK
- Containers-backed isolated environment
- `exec`, `writeFile`, `readFile`, `mkdir`, `listFiles`, `exposePort`,
  code interpreter contexts

Agentic Inbox mapping:

- not needed for the core mailbox product
- useful later for advanced "mailbox receives task, agent runs a toolchain"
  workflows
- must be owner/admin opt-in and capability-scoped
- credentials should be injected by network/control layer, not visible to
  generated code

### 5. Dynamic Workers And Code Mode

Use for:

- low-latency generated JavaScript execution
- progressive tool discovery
- reducing MCP schema/context bloat
- safe computation with minimal ambient authority

Cloudflare primitive:

- Dynamic Workers
- Code Mode
- MCP portal Code Mode

Key design point:

Instead of exposing hundreds or thousands of tools, expose a small discovery
and execution interface. The model writes code to select and call the exact
tools it needs. Cloudflare's own MCP examples report very large token savings
from this pattern.

Agentic Inbox mapping:

- keep the current explicit capability registry for safety and inspectability
- consider Code Mode only for admin/developer tooling or large external tool
  catalogs
- do not expose raw mailbox internals to generated code

### 6. Durable Object Facets And Sub-Agents

Use for:

- isolating child agents under a parent agent
- decomposing an agent into planner/researcher/reviewer/executor roles
- giving each child its own SQLite database

Cloudflare primitive:

- Durable Object Facets
- Agents SDK sub-agents
- typed RPC between agents

Agentic Inbox mapping:

- useful for future multi-agent mailbox workflows
- examples:
  - `finance@` orchestrator + invoice extractor + reimbursement reviewer
  - `support@` orchestrator + triage agent + knowledge-search agent
- each sub-agent should inherit mailbox policy and receive only the minimal
  capability set required for its role

### 7. Email Service

Use for:

- inbound email to Workers or agents
- outbound transactional mail
- email-native agent interaction
- async replies, follow-ups, escalation, and notifications

Cloudflare primitive:

- Email Routing
- Email Sending
- Email Service REST API
- Workers `send_email` binding
- Agents SDK `onEmail`
- Email MCP server
- Wrangler email commands
- Email Service skill

Key facts:

- Email Service is currently beta.
- Email Sending is available from Workers through bindings and from any
  platform through REST API / SDKs.
- Email Routing plus Email Sending gives bidirectional email on Cloudflare.
- The Agents SDK can route inbound email to agent instances and preserve state
  across messages.
- Secure reply routing can sign routing headers so replies return to the
  correct agent instance.

Agentic Inbox mapping:

- this project is exactly the reference shape Cloudflare described:
  inbound routing, outbound sending, R2 attachments, Agents SDK, Workers AI,
  and built-in MCP
- the product should lean into this: mailbox = agent-native workflow surface
- next: align more tightly with `onEmail` patterns where they simplify
  receive/route/persist/reply semantics without losing the current mailbox DO
  data model

### 8. AI Gateway And Workers AI

Use for:

- unified model access
- provider switching and fallback
- cost tracking
- metadata tagging by user, mailbox, workflow, or tenant
- Workers AI-hosted open models
- future third-party models through the same `AI.run()` binding

Cloudflare primitive:

- Workers AI
- AI Gateway
- model catalog
- automatic retries/failover
- streaming resilience for long-running agents

Agentic Inbox mapping:

- keep mailbox/provider settings, but converge on an AI Gateway-aware model
  resolution layer
- include metadata on every model call:
  - mailbox id
  - agent id
  - user id or system
  - workflow/capability id
- use fast/cheap models for classification and safety checks; reserve stronger
  reasoning models for drafting/planning

### 9. Search And Memory

Use for:

- retrieval over docs, prior tickets, per-customer history, mailbox knowledge
- hybrid semantic + keyword search
- persistent memories that can be recalled or forgotten

Cloudflare primitives:

- AI Search
- Agent Memory
- Vectorize
- R2-backed or built-in AI Search storage
- AI Search namespace bindings

Agentic Inbox mapping:

- near-term: AI Search per mailbox for attachments, selected threads, and
  extracted summaries
- later: Agent Memory for cross-thread durable preferences and facts, only with
  source attribution and deletion controls
- do not dump all mailbox email into memory by default; treat memory as
  explicit, auditable derived state

### 10. Browser Run

Use for:

- services without APIs or MCP servers
- form filling
- screenshots
- browser-based inspection
- human-in-the-loop takeover

Cloudflare primitive:

- Browser Run
- CDP access
- Live View
- Human in the Loop
- session recordings

Agentic Inbox mapping:

- optional high-power integration
- should require owner/admin enablement
- useful for workflows like vendor portals, invoice downloads, or support
  systems without APIs
- requires audit and explicit egress/session policy

### 11. MCP Infrastructure

Use for:

- exposing first-party tools to external agents
- governed enterprise tool access
- central discovery of approved MCP servers
- progressive disclosure / Code Mode

Cloudflare primitives:

- remote MCP servers on Workers
- `McpAgent`
- Cloudflare Access as OAuth provider
- MCP server portals
- Code Mode for portals
- AI Gateway in front of LLM traffic
- Cloudflare Gateway for shadow MCP detection
- WAF / AI Security for Apps for public MCP endpoints

Agentic Inbox mapping:

- current `/mcp` endpoint is a strong fit
- next steps:
  - make API keys scope-aware
  - add per-mailbox MCP key restrictions
  - log every MCP tool call as a capability invocation
  - return bounded, actionable tool results
  - document Agentic Inbox as its own first-party MCP server

### 12. Security And Identity

Use for:

- least privilege
- non-human identity management
- internal app access
- private network access
- MCP governance
- safe sandbox egress

Cloudflare primitives:

- Cloudflare Access
- Managed OAuth for Access
- Cloudflare Mesh
- resource-scoped API tokens
- OAuth visibility
- automated token revocation
- Sandbox outbound Workers / egress controls
- Cloudflare Gateway
- AI Security for Apps

Agentic Inbox mapping:

- app-level native auth remains useful for open-source self-hosting
- Cloudflare Access should remain optional enterprise perimeter, not required
  for core product operation
- internal Worker-to-DO identity should continue to use signed envelopes
- external HTTP capabilities need allowlists, SSRF protection, and audit
- future "agent with private network access" should go through Mesh/Access-style
  scoped grants, not raw secrets in prompts

### 13. Prototype-To-Production Tooling

Use for:

- managing Cloudflare resources from CLI or agents
- progressive rollouts
- agent-generated code deployment safety
- dashboard agent assistance

Cloudflare primitives:

- `cf` unified CLI
- Wrangler
- Agent Lee
- Flagship feature flags
- Workers Builds
- Registrar API

Agentic Inbox mapping:

- Wrangler remains the deploy baseline today
- Flagship could gate risky new agent features:
  - auto-draft rollout
  - AI Search rollout
  - workflow-backed processing
  - MCP scope enforcement
- feature flags are valuable once agents begin changing production behavior

### 14. Agentic Web

Use for:

- making websites and docs more usable by agents
- controlling AI crawler behavior
- measuring agent readiness

Cloudflare primitives:

- Agent Readiness Score
- Redirects for AI Training
- AI Crawl Control
- Radar AI insights
- Shared Dictionaries
- network performance improvements

Agentic Inbox mapping:

- not core runtime
- relevant for public docs and hosted docs site later
- ensure README/docs are current, canonical, and agent-readable

## Build Guide: Agent-Native Cloudflare Application

### Step 1: Classify The Workload

Before choosing products, classify every workflow:

| Workload | Recommended primitive |
| --- | --- |
| realtime human-agent chat | Agents SDK / AIChatAgent |
| per-mailbox state and email data | Durable Object SQLite |
| global users / sessions / directory | D1 |
| large binary attachments | R2 |
| inbound event processing | Email Routing + Worker email handler |
| outbound communication | Email Sending binding |
| retryable async work | Queues |
| long-running durable multi-step work | Workflows |
| model calls | Workers AI + AI Gateway |
| retrieval | AI Search |
| long-term semantic facts | Agent Memory |
| external agent interface | Remote MCP server |
| generated JS execution | Dynamic Workers / Code Mode |
| full OS toolchain | Sandboxes |
| browser-only workflows | Browser Run |

### Step 2: Start With Agents SDK

For a new standalone agent:

```bash
npm create cloudflare@latest -- --template cloudflare/agents-starter
cd my-agent
npm install
npm run dev
```

Minimum concepts:

- define an `Agent` or `AIChatAgent` class
- add a Durable Object binding and migration
- route with `routeAgentRequest()`
- use WebSockets/React hooks for realtime UI
- persist state with `setState()` or the agent SQL database
- add tools through AI SDK-compatible tool definitions

For an existing Worker app:

- install `agents`
- export the agent class from the Worker entrypoint
- add DO binding and migration
- add `routeAgentRequest()` before catch-all routes
- make auth/ACL decisions in the Worker before forwarding to the agent

### Step 3: Design Identity And Authority

Every request should answer:

- who is the actor?
- which mailbox/workspace owns the state?
- what scopes are required?
- is this human, API key, MCP client, system, or background workflow?
- is the action reversible?

Recommended layers:

1. External auth: native session, API key, or Cloudflare Access/OAuth.
2. Worker boundary: resolve user and mailbox access.
3. Internal forwarding: mint signed context for DOs.
4. Capability invocation: enforce scopes and owner/member/admin policy.
5. Audit: record actor, capability, mailbox, resource, and result.

### Step 4: Build A Capability Registry Before Adding Tools

Agents should not receive raw APIs. Build capabilities with:

- stable id
- input schema
- output schema where needed
- scope list
- permission level
- surfaces: rule, agent, MCP, UI
- bounded result shape
- actionable errors

For LLM-facing tools:

- keep lists small
- truncate bodies
- provide follow-up ids
- require explicit "get full item" calls
- avoid dumping whole mailboxes or attachment bodies into context

### Step 5: Separate Durable Data From Derived Context

Source-of-truth state:

- D1 for global identity/control plane
- MailboxDO SQLite for per-mailbox records
- R2 for attachment bytes

Derived state:

- AI Search indexes
- Agent Memory facts
- extracted invoice records
- prompt contributions
- summaries

Rule:

Derived state must always know its source email, attachment, mailbox, and
generation time.

### Step 6: Move Slow Work Off The Request Path

Do synchronously:

- authenticate
- persist inbound message
- store attachment metadata
- enqueue or start background work
- return/acknowledge

Do asynchronously:

- attachment extraction
- OCR
- invoice parsing
- model classification
- auto-draft generation
- webhooks
- external API calls
- retries and escalation

Use Queues for simple tasks and Workflows for durable multi-step flows with
approval, sleep, or external events.

### Step 7: Treat Email And Attachments As Untrusted Input

Required controls:

- prompt-injection detection before agent drafting
- attachment type and size limits
- sandboxed parsers for risky formats
- no arbitrary external URL fetching from email body
- HTML sanitization for display
- human review before sending
- provenance on every draft and extracted artifact

### Step 8: Add Retrieval Deliberately

Good initial AI Search indexes:

- per-mailbox knowledge summary
- attachments selected by rules
- extracted invoice text
- support resolution summaries

Avoid:

- indexing every private email by default without owner controls
- using memory as a hidden irreversible store
- mixing multiple mailbox indexes without ACL-aware search filters

### Step 9: Harden MCP

Recommended MCP architecture:

- remote MCP server hosted on Workers
- same auth and ACL as web app
- signed internal auth context into DOs
- capability registry as source of tool truth
- scoped API keys
- audit every tool call
- bounded responses and actionable errors

For enterprise deployments:

- optionally put MCP behind Cloudflare Access
- consider MCP server portal for discovery/governance
- use Gateway to detect shadow MCP
- use AI Security for Apps/WAF on public-facing MCP endpoints

### Step 10: Deploy And Operate

Baseline checks:

```bash
npm run verify
npm run deploy
wrangler tail
```

For D1:

```bash
npx wrangler d1 migrations apply DB --remote
```

For email:

- configure Email Routing to the Worker
- configure `send_email` binding
- restrict allowed sender addresses where possible
- validate SPF/DKIM/DMARC setup through Email Service

For agents:

- verify WebSocket `/agents/*` access
- verify MCP `/mcp`
- verify inbound email triggers
- verify background work retries
- verify audit events

## Agentic Inbox Adoption Plan

### Already Aligned

Agentic Inbox already matches the core Cloudflare agentic cloud shape:

- Hono Worker as API/auth/SSR boundary
- Durable Object per mailbox
- DO SQLite for mailbox-local state
- R2 for attachments
- D1 for native auth and control-plane data
- Agents SDK for EmailAgent and InvoiceAgent
- Email Routing inbound path
- Email Sending binding
- built-in MCP server
- capability registry across rule, agent, and MCP surfaces
- signed internal auth-context from Worker to DOs

### Near-Term Gaps

1. Background execution

   Move auto-draft, extraction, OCR, webhook dispatch, and invoice processing
   into Queue/Workflow-backed execution with retry and inspection.

2. Capability policy

   Scopes currently exist as descriptors. They should become enforceable policy,
   especially for `email.send`, `external.http`, and future browser/sandbox
   powers.

3. Audit

   Add structured audit events for capability calls, rule actions, draft
   creation, send attempts, membership changes, and admin actions.

4. Scoped API keys

   API keys should support mailbox restrictions and capability scopes so MCP
   clients can be least-privilege.

5. Retrieval

   Add AI Search for explicit mailbox knowledge and extracted artifacts. Keep it
   source-linked and ACL-aware.

6. Skill packs

   Formalize mailbox skills as versioned documents with required capabilities,
   prompts, default rules, and validation checklists.

7. Egress controls

   Webhook and future browser/sandbox tools need allowlists, private-network
   denial, and owner/admin approval.

### Recommended PR Sequence

PR A: Cloudflare Agentic Cloud docs

- Add this guide.
- Link it from product narrative and foundation architecture.
- Convert the current Agents Week tutorial into a shorter index or historical
  note.

PR B: Background work foundation

- Add Queue or Workflow bindings.
- Move auto-draft trigger to background execution.
- Add idempotency keys for inbound email work.

PR C: Capability audit middleware

- Add capability middleware for structured audit logs.
- Persist actor, mailbox, capability id, scopes, input hash, resource ids, and
  result.

PR D: Scope-aware API keys

- Add D1 schema for key scopes and mailbox restrictions.
- Enforce scopes at API/MCP/capability invocation.

PR E: AI Search pilot

- Add optional `AI_SEARCH` namespace binding.
- Index selected extracted text and summaries for one mailbox.
- Add `search_mailbox_knowledge` capability.

PR F: Skill pack format

- Add `skills/` or `docs/skills/` pack format.
- Ship finance/support starter packs.
- Wire mailbox settings to enabled skill packs.

PR G: Owner-approved external execution

- Harden `external.http`.
- Add allowlists.
- Prepare Browser Run / Sandbox optional capability model without enabling by
  default.

## Design Rules For This Repository

1. Mailbox is the authority boundary.

   Every agent, skill, capability, search index, workflow, and artifact must
   name its mailbox.

2. Capabilities are the hard tool boundary.

   Agents and MCP clients do not call raw helper APIs directly.

3. Skills guide behavior but do not grant authority.

   Enabling a skill only makes sense when required capabilities and scopes are
   also allowed by mailbox policy.

4. Durable first, async when slow.

   Persist email and attachments before model work. Move slow or retryable work
   into Queues or Workflows.

5. Human review remains the default for outbound email.

   Agent-created drafts are proposals. Sending is a separate, auditable action.

6. Search and memory are derived state.

   They must be source-linked, deletable, and ACL-aware.

7. Browser, sandbox, and arbitrary egress are high-power capabilities.

   They require owner/admin opt-in, allowlists, and audit.

8. MCP has no special bypass.

   MCP sees the same mailbox ACL and capability policy as the web app.

## Appendix: Product Matrix

| Cloudflare product | Agent infrastructure role | Agentic Inbox relevance |
| --- | --- | --- |
| Workers | global request/runtime boundary | core |
| Durable Objects | per-agent/per-mailbox isolation and state | core |
| DO SQLite | local transactional state | core |
| Agents SDK | stateful agents, chat, RPC, email, scheduling | core |
| AIChatAgent | streaming chat agent base | core |
| Workflows | durable multi-step background jobs | near-term |
| Queues | async retryable task fanout | near-term |
| D1 | global relational control plane | core |
| R2 | attachments and artifacts | core |
| Email Routing | inbound email events | core |
| Email Sending | outbound/reply channel | core |
| AI Gateway | model routing, analytics, retries, fallback | near-term |
| Workers AI | hosted models and safety/classification | core |
| AI Search | mailbox knowledge retrieval | near-term |
| Agent Memory | durable semantic memory | later |
| MCP / McpAgent | external agent interface | core |
| MCP server portals | enterprise MCP governance | optional |
| Dynamic Workers | generated code execution | later |
| Code Mode | progressive tool discovery and execution | later |
| Sandboxes | full OS execution | optional/high-power |
| Browser Run | browser automation | optional/high-power |
| Mesh | private network access | enterprise/high-power |
| Access / Managed OAuth | enterprise auth and agent-ready internal apps | optional |
| Gateway | MCP governance and shadow MCP detection | enterprise |
| AI Security for Apps | prompt injection/DLP inspection for public MCP | optional |
| Flagship | feature flags for safe autonomous rollout | later |
| Artifacts | Git-compatible versioned state/artifacts | later |
| Agent Readiness | public web/docs agent-readiness | docs/site later |
