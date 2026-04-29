# Foundation Architecture

Updated: 2026-04-28

## Goal

This document defines the target foundation for Agentic Inbox as an
agent-native mailbox platform.

For the Cloudflare product landscape behind this architecture, see
[Cloudflare Agentic Cloud 2026 Guide](cloudflare-agentic-cloud-2026-guide.md).
For agent tool extensibility, MCP connectors, and skill packs, see
[Agent Tool Extension Architecture](agent-tool-extension-architecture.md).

The architecture should make one idea operational:

> Email is the durable workflow substrate. Agents operate through scoped mailbox
> capabilities, not unrestricted user authority.

## System Shape

```
Browser / MCP Client / Email Routing
        |
        v
Hono Worker
  - native auth, API keys, optional Access fallback
  - admin and mailbox APIs
  - signed internal auth-context forwarding
  - React Router SSR
        |
        +--> Global D1 control plane
        |     - users, sessions, email tokens
        |     - API keys
        |     - mailbox directory and membership index
        |     - model/provider settings
        |
        +--> MailboxDO per mailbox
        |     - emails, folders, threads, drafts
        |     - extracted invoices and bundles
        |     - mailbox-local SQLite state
        |
        +--> R2
        |     - raw mailbox ACL/settings documents during migration
        |     - attachments and large artifacts
        |
        +--> EmailAgent / InvoiceAgent Durable Objects
        |     - Cloudflare Agents SDK
        |     - per-agent chat state
        |     - mailbox-scoped tool invocation
        |
        +--> EmailMCP Durable Object
              - MCP server facade
              - same ACL and capabilities as the app
```

## Architecture Principles

1. The mailbox is the primary isolation unit.

   A mailbox owns its messages, drafts, attachments, skills, rules, artifacts,
   and workflow history. Users and API keys receive authority over mailboxes,
   not over arbitrary global data.

2. The Worker is the trust boundary.

   Browser sessions, API keys, Access fallback, MCP clients, and inbound email
   all terminate at the Worker. Durable Objects receive signed internal context,
   not raw caller identity.

3. Durable Objects are data-plane coordinators.

   MailboxDO serializes mailbox-local mutations. Agent DOs serialize agent
   session/runtime state. They should not become global discovery indexes.

4. D1 is the global control plane.

   Identity, sessions, API keys, mailbox directory, membership, policy,
   provider configuration, and audit indexes belong in D1.

5. R2 stores bytes and large artifacts.

   R2 should not be the authoritative place to discover mailboxes or evaluate
   ACL. It stores attachment bytes, exports, snapshots, and other large
   immutable or versioned artifacts.

6. Capabilities are the execution contract.

   Agents, MCP clients, rules, and UI commands should converge on the same
   capability registry for side effects and policy enforcement.

7. Slow work is background work.

   Request paths persist and enqueue. Queues and Workflows handle extraction,
   model work, retries, waits, and multi-step approval flows.

## Runtime Topology

The target topology has four runtime planes:

### Edge Boundary Plane

Components:

- Hono Worker
- React Router SSR
- auth middleware
- API routes
- MCP and agent request forwarders
- inbound `email()` handler

Responsibilities:

- terminate external identity
- validate request bodies
- verify mailbox access
- mint signed internal context
- keep public routes and internal DO routes separate
- enqueue slow work after persistence

### Mailbox Data Plane

Components:

- `MailboxDO`
- per-mailbox SQLite
- R2 attachment references

Responsibilities:

- store email records, threads, folders, drafts, labels, and local workflow
  records
- keep message and attachment metadata transactionally close to mailbox state
- expose narrow methods for capability execution
- avoid global scans or cross-mailbox coordination

### Agent Plane

Components:

- `EmailAgent`
- `InvoiceAgent`
- future mailbox-scoped agents
- `EmailMCP`

Responsibilities:

- hold chat/session state
- render LLM-facing tools from capabilities
- call mailbox data-plane helpers through scoped context
- stream responses and expose MCP tools
- never independently decide global authority

### Background Plane

Components:

- Queues for short retryable jobs
- Workflows for durable multi-step jobs
- future dead-letter inspection
- future audit/event writer

Responsibilities:

- process extraction, OCR, classification, auto-draft, webhook delivery, and
  external integration retries
- preserve idempotency keys
- record job status and failure reasons
- resume work after waits or human approval

## Bounded Contexts

| Context | Owns | Does not own |
| --- | --- | --- |
| Identity | users, sessions, password/magic-link state, admin role | mailbox content |
| Mailbox Directory | mailbox existence, owner, members, lifecycle | message bodies or attachments |
| Mailbox Content | emails, folders, threads, drafts, local workflow state | global user/session records |
| Artifact Storage | attachment bytes, generated exports, large blobs | ACL or mailbox discovery |
| Capability Policy | capability ids, scopes, surfaces, permission level | LLM behavior text |
| Skills | prompts, SOPs, default rules, validation checklists | authority beyond capabilities |
| Agent Runtime | chat messages, tool-call transcript, streaming state | source-of-truth email records |
| Background Jobs | queued work, retries, workflow status | synchronous request success |
| Audit | evidence of actor/action/result | primary business object storage |

This split keeps migrations smaller. For example, moving ACL from R2 to D1 does
not require moving mailbox settings, and adding Workflows does not require
changing how message bodies are stored.

## Agent-Native Layers

The platform follows a five-layer model.

### 1. Brain: LLM Layer

Role:

- reason over email context
- choose among allowed tools
- generate drafts, summaries, and structured intent

Rules:

- no permanent source of truth
- no direct database access
- no raw external API credentials
- no authority beyond the capability context it receives

Current implementation:

- EmailAgent and InvoiceAgent use Cloudflare Agents SDK / AI SDK paths
- Workers AI and OpenAI-compatible provider configuration are used for model
  execution and safety checks

### 2. Skills: SOP And Behavior Layer

Role:

- mailbox-specific instructions
- department SOPs
- triage policy
- tone and escalation rules
- workflow-specific prompts

Rules:

- skills are changeable without schema migrations
- skills can guide behavior but cannot grant authority
- a skill must call capabilities for real side effects

Current implementation:

- mailbox settings store agent prompts and enabled agent skills
- capability descriptors provide UI and LLM descriptions

Target:

- represent mailbox skills as first-class versioned documents
- support built-in skill packs for support, finance, sales, ops, legal, and HR
- allow a mailbox owner to enable, pin, or override skills

### 3. Agent Facade: MCP And Agent Tool Layer

Role:

- expose coarse, safe actions to LLMs and external agent clients
- hide low-level API complexity
- enforce mailbox, user, scope, and permission context

Rules:

- expose macro tools, not raw CRUD sprawl
- return actionable errors
- cap list sizes and summarize where necessary
- never trust client-supplied identity headers

Current implementation:

- EmailMCP exposes mailbox tools at `/mcp`
- EmailAgent and InvoiceAgent expose tools through agent chat
- `workers/lib/capabilities` registers code-backed actions across
  `rule-action`, `agent-tool`, and `mcp-tool` surfaces
- Worker forwards a signed internal auth-context JWT into agent and MCP DOs

Target:

- make capabilities the single source of tool truth across UI, rules, agents,
  and MCP
- add scope-aware API keys so MCP clients can be limited per mailbox and per
  capability scope
- add structured audit events for every capability invocation

### 4. Limbs: API And Tool Execution Layer

Role:

- strict machine APIs
- mailbox data reads/writes
- send email, draft email, move email
- parse attachments
- call external integrations through controlled egress

Rules:

- validate all request bodies with schemas
- keep atomic operations deterministic
- external side effects require explicit policy
- capability code owns orchestration; low-level helpers stay small

Current implementation:

- Hono API routes in `workers/index.ts`
- tool helpers in `workers/lib/tools.ts`
- attachment helpers and invoice extraction paths
- send email through Cloudflare Email Sending binding

Target:

- move long-running or retryable work behind Queues / Workflows
- isolate external egress through allowlisted capabilities
- add idempotency keys for inbound email and workflow steps

### 5. World State: Durable Storage Layer

Role:

- persist the business record
- define recovery and replay boundaries
- support audit, migration, and inspection

Current implementation:

- D1: users, sessions, API keys, mailbox directory, membership index, provider
  config
- MailboxDO SQLite: mailbox-local email, folder, invoice, bundle, and agent
  workflow state
- R2: attachments and legacy mailbox settings/ACL documents
- Durable Object state: agent chat/session runtime state

Target:

- D1 remains the control plane
- MailboxDO remains the mailbox data plane
- R2 remains artifact storage
- audit tables or durable event logs record capability and policy decisions

## Domain Model

| Entity | Meaning | Source of truth |
| --- | --- | --- |
| Instance | One self-hosted deployment | Worker config + D1 |
| User | Human or programmatic identity owner | D1 `users` |
| Session | Browser login state | D1 `sessions` |
| API key | Programmatic credential | D1 API key tables |
| Mailbox | Role workspace and data boundary | D1 directory + MailboxDO |
| Mailbox ACL | owner + members | D1 directory target; R2 during migration |
| Email | Message event and record | MailboxDO SQLite |
| Thread | Durable session over email | MailboxDO SQLite |
| Attachment | Persisted artifact | R2 + MailboxDO metadata |
| Agent | Mailbox-scoped worker | Agent DO + settings |
| Skill | Changeable SOP / prompt / policy | Mailbox settings now; skill docs target |
| Capability | Code-backed scoped action | Capability registry |
| Rule | Declarative inbound trigger | Mailbox settings / rules store |
| Audit event | Security and behavior evidence | Target D1 / DO event log |

## Data Ownership Matrix

| Data | Primary store | Secondary/derived store | Notes |
| --- | --- | --- | --- |
| Users and roles | D1 | none | instance-global identity |
| Browser sessions | D1 | secure cookies | cookies identify session, D1 validates |
| API keys | D1 | hashed token prefix/index | keys should become mailbox/scope restricted |
| Mailbox directory | D1 | MailboxDO name | D1 answers global listing and ownership |
| Mailbox membership | D1 | signed context at runtime | R2 ACL is legacy migration state only |
| Email metadata/body | MailboxDO SQLite | search index summaries | MailboxDO is authoritative |
| Attachments | R2 | MailboxDO metadata | metadata must include source email id |
| Drafts | MailboxDO SQLite | agent transcript | sending remains a separate action |
| Agent chat state | Agent DO SQLite/state | audit events | not source of truth for mailbox content |
| Skills | mailbox settings target | built-in docs/packs | enabling a skill does not grant authority |
| Capability policy | D1 target + registry code | mailbox settings view | code defines implementation, policy enables |
| Rules | mailbox settings target | audit/job events | deterministic trigger config |
| Audit events | D1 target | logs/tail | queryable by admin and mailbox owner |
| Retrieval index | AI Search target | source records | derived, deletable, source-linked |
| Long-term memory | Agent Memory target | source records | explicit opt-in only |

## State And Consistency Rules

- Persist inbound email before invoking model or extraction work.
- Store attachment bytes before creating extractor jobs that depend on them.
- Treat D1 mailbox membership as authoritative once a mailbox has been
  backfilled.
- Keep R2 ACL reads only as migration compatibility until the cutover is
  complete.
- Never make agent chat state the only copy of a draft, extracted record, or
  external side effect.
- Every derived record must link to its source mailbox and source resource.
- Cross-plane writes should be idempotent and replayable.
- If a side effect cannot be made atomic with its audit event, record an
  attempted event before the side effect and a result event after it.

## Control Plane And Data Plane

### Control Plane

The global control plane answers:

- who is this caller?
- which mailboxes exist?
- who owns or belongs to each mailbox?
- which API keys and sessions are active?
- which global provider settings are allowed?

It belongs in D1 because it is global, queryable, and admin-facing.

### Data Plane

The mailbox data plane answers:

- what messages exist in this mailbox?
- what folders and workflow states exist?
- what drafts and extracted artifacts belong here?
- what invoices or bundles were derived from attachments?

It belongs in per-mailbox Durable Objects because mailbox isolation maps
cleanly to the Durable Object identity model and SQLite locality.

### Artifact Plane

Large or untrusted blobs belong in R2:

- raw attachments
- inline attachment bodies
- generated exports
- future large workflow artifacts

MailboxDO stores metadata and stable references; R2 stores bytes.

## Identity And Trust Boundaries

### External Identity

Supported caller types:

- browser cookie session
- user-bound Bearer API key
- optional legacy Cloudflare Access JWT fallback
- internal system calls from Worker email handlers

### Internal Identity

Worker-to-Durable-Object calls must carry signed internal auth context:

- signed with `INTERNAL_SECRET`
- includes user id, email, role, and system flag
- stripped and re-minted at Worker boundary
- verified inside MCP and agent DOs

Raw caller-supplied identity headers are not trusted.

### Authorization

Authorization is layered:

- admin: instance-level provisioning and user operations
- mailbox owner: membership, invites, sensitive integrations, capability policy
- mailbox member: mailbox content and ordinary workflows
- system: inbound automation without owner power by default

Capability scopes should become enforceable policy:

- `mailbox.read`
- `mailbox.write`
- `email.send`
- `external.http`

## Core Flows

### Inbound Email Flow

```
Cloudflare Email Routing
  -> Worker email handler
  -> parse MIME
  -> persist message in MailboxDO
  -> store attachments in R2
  -> evaluate mailbox rules
  -> invoke rule-action capabilities
  -> trigger EmailAgent auto-draft when policy allows
  -> save draft for human review
```

Design requirements:

- inbound message processing is idempotent
- attachment parsing is bounded and typed
- prompt-injection checks run before agent drafting where applicable
- rule failures do not drop the email
- long-running extraction should move to Queue / Workflow

Target split:

| Step | Synchronous | Background |
| --- | --- | --- |
| MIME parse | yes, bounded | no |
| message persistence | yes | no |
| attachment byte storage | yes for accepted attachments | no |
| rule matching | yes, cheap predicates | complex enrichment |
| auto-draft | enqueue | model execution |
| invoice/OCR extraction | enqueue | parse/extract/retry |
| webhook delivery | enqueue | send/retry/dead-letter |

### Human Agent Chat Flow

```
Browser session
  -> /agents/<agent>/<mailbox>
  -> Worker verifies mailbox access
  -> Worker mints signed internal auth context
  -> Agent DO receives scoped user
  -> LLM calls allowed agent-tool capabilities
  -> tools read/write MailboxDO or R2 through helpers
```

Design requirements:

- a member can use member-level tools
- owner-only tools require owner or admin
- auto-draft system flows do not inherit owner power
- every tool call should become auditable

Target split:

| Concern | Owner |
| --- | --- |
| browser authentication | Worker |
| mailbox authorization | Worker + capability policy |
| WebSocket/chat state | Agent DO |
| mailbox reads/writes | MailboxDO |
| tool descriptions | capability registry |
| LLM prompt assembly | Agent DO + skills |
| durable side effects | capability implementation |

### MCP Flow

```
MCP client
  -> Bearer API key
  -> Worker resolves D1 user
  -> Worker mints signed internal auth context
  -> EmailMCP DO exposes mailbox-scoped tools
  -> capability registry enforces schemas and permission
```

Design requirements:

- MCP has no separate authority model
- MCP list operations return only visible mailboxes
- MCP tools return actionable errors
- future API keys can restrict scopes and mailbox ids

MCP hardening sequence:

1. Preserve signed auth context from Worker to MCP DO.
2. Enforce mailbox ACL for list/read/write tools.
3. Add API key mailbox restrictions.
4. Add API key scope restrictions.
5. Add audit events for every tool invocation.
6. Add result truncation and follow-up ids for large reads.

### Admin Provisioning Flow

```
Admin user
  -> creates or assigns mailbox
  -> D1 mailbox directory updated
  -> legacy R2 ACL remains synchronized during migration
  -> owner/member list drives web, agent, and MCP access
```

Design requirements:

- no claim-on-first-access for shared mailboxes
- owner assignment is explicit
- directory backfill is safe and inspectable
- admin actions are auditable

### Background Workflow Flow

```
Worker or MailboxDO
  -> creates idempotent job record
  -> enqueues queue message or starts workflow
  -> worker/workflow loads mailbox-scoped context
  -> invokes capability or extraction helper
  -> writes result to MailboxDO / D1 / R2
  -> records audit and job result
```

Design requirements:

- every job has mailbox id, trigger id, job type, and idempotency key
- retry count and last error are inspectable
- dead-lettered work can be replayed by an admin or mailbox owner where safe
- workflow steps do not hold raw secrets in prompts or job payloads
- human approval checkpoints are represented as durable state, not in-memory
  chat turns

### Attachment / Artifact Flow

```
Email attachment
  -> R2 object
  -> MailboxDO metadata
  -> capability-specific extractor
  -> structured records or prompt contribution
  -> audit trail links source attachment to derived output
```

Design requirements:

- parsers treat attachments as untrusted input
- extracted data records source email and attachment ids
- async OCR / heavyweight parsing goes through background work
- generated exports are stored as artifacts, not transient memory

## Capability Architecture

Capabilities are the hard boundary around work.

Each capability declares:

- stable id
- display name and description
- surfaces: `rule-action`, `agent-tool`, `mcp-tool`
- scopes
- input schema
- output schema where useful
- permission: member or owner
- implementation

Capability invocation should provide:

- mailbox id
- actor user or system context
- trigger source
- email id where relevant
- agent id where relevant
- waitUntil / background scheduling hook

Target middleware:

- structured logging
- audit event writing
- rate limiting
- scope enforcement
- egress checks
- result truncation for LLM-facing surfaces

## Capability Scope Model

Initial scopes should be small and product-readable:

| Scope | Meaning | Default permission |
| --- | --- | --- |
| `mailbox.read` | read mailbox metadata, threads, messages, folders | member |
| `mailbox.write` | create drafts, labels, folders, local records | member |
| `email.send` | send external email | owner-gated or explicit policy |
| `mailbox.manage` | change members, settings, skills, rules | owner |
| `capability.manage` | enable high-power capabilities or integrations | owner |
| `external.http` | call configured external webhooks/APIs | owner-gated |
| `artifact.read` | read attachment metadata or extracted text | member |
| `artifact.write` | store derived artifacts or exports | member/owner by type |
| `admin.instance` | global user/mailbox administration | admin |

API keys should eventually carry:

- allowed mailbox ids
- allowed scopes
- optional expiration
- optional capability allowlist
- display name and last-used metadata

Actor context should carry:

- actor type: `user`, `api-key`, `system`, `workflow`
- user id when available
- mailbox id currently being acted on
- role: admin, owner, member, or system
- source surface: web, MCP, rule, agent, workflow

## Agent Execution Policy

Agents can:

- summarize mailbox content the actor can read
- search bounded mailbox context
- propose drafts
- extract structured data through registered capabilities
- call member-level capabilities when the actor has member access

Agents cannot by default:

- send email without explicit policy
- grant mailbox membership
- enable integrations
- fetch arbitrary URLs from email bodies
- read another mailbox
- store hidden cross-mailbox memory
- access raw secrets

System-triggered agents can:

- process inbound mail
- create drafts or extracted records
- enqueue background work

System-triggered agents cannot by default:

- impersonate the mailbox owner
- send externally
- alter membership or policy
- enable high-power capabilities

This keeps inbound automation useful without turning incoming email into an
authority escalation path.

## Skills Architecture

Skills are the soft-coded layer that makes the product useful per mailbox.

Target skill object:

```json
{
  "id": "finance:invoice-triage",
  "version": 1,
  "name": "Invoice triage",
  "appliesTo": ["email-reply", "invoice"],
  "requiredCapabilities": ["core:extract-invoice", "core:draft-reply"],
  "prompt": "...",
  "rules": [],
  "ownerEditable": true
}
```

Skill packs should define:

- instructions
- expected mailbox role
- required capabilities
- optional rules
- validation checklist
- sample prompts

Skills do not bypass capability permission. Enabling a skill means the agent may
use its required capabilities only if the mailbox policy and actor context allow
them.

## Safety Model

Primary risks:

- prompt injection in inbound email
- malicious attachments
- accidental outbound email
- SSRF or uncontrolled webhook egress
- over-broad API keys
- mailbox ACL bypass through agent or MCP paths
- stale migration state between R2 ACL and D1 directory

Required mitigations:

- human review for agent-generated outbound mail by default
- signed internal auth-context between Worker and Durable Objects
- owner-only gates for membership and sensitive integration configuration
- capability schemas and permission checks at invocation time
- external HTTP allowlists for webhook-like capabilities
- audit events for capability invocation and policy decisions
- background queues with retry and dead-letter handling for non-trivial work
- migration backfills with strict error accounting

## Deployment Profiles

### Local Development

Purpose:

- fast iteration on UI, Worker routes, DO behavior, and email simulation

Expected setup:

- `.dev.vars` for `INTERNAL_SECRET` and local auth settings
- `npm run dev`
- `X-Dev-User` where supported for impersonation
- Wrangler email dev for inbound smoke tests

### Single-Team Self-Hosted

Purpose:

- the default open-source deployment

Expected setup:

- one Cloudflare account
- one or more domains
- Email Routing and Email Sending
- D1, R2, Durable Objects, Workers AI
- native auth as primary identity
- optional Access fallback

### Enterprise Perimeter

Purpose:

- organizations that want Cloudflare Access/Gateway/Mesh around the app

Expected setup:

- native auth still owns app roles
- Access may protect public entrypoints
- Gateway can inspect outbound/MCP traffic
- Mesh may grant private network access to specific high-power capabilities

### Hosted SaaS Future

Purpose:

- future multi-tenant offering, not the current open-source default

Required changes before considering:

- tenant-aware D1 schema
- tenant-scoped Durable Object naming
- billing and quota model
- admin separation
- stronger data export/deletion controls
- operational SLOs and support process

## Operational Readiness

Before calling a deployment production-ready, the platform should have:

- `npm run verify` or equivalent pre-deploy check
- remote D1 migrations applied and recorded
- `INTERNAL_SECRET` set
- Email Sending domain verified
- Email Routing rule installed
- admin user bootstrapped
- at least one owner-assigned mailbox
- MCP smoke test
- agent chat smoke test
- inbound email smoke test
- outbound email smoke test
- background job inspection once Queues/Workflows land
- audit event inspection once audit lands

Runtime telemetry should answer:

- Are inbound emails being persisted?
- Are auto-drafts failing?
- Are capability calls denied or erroring?
- Are background jobs retrying or dead-lettering?
- Are sends bouncing?
- Which API keys and MCP clients are active?

## Observability And Audit

The architecture should record:

- login and API key activity
- admin provisioning changes
- mailbox membership changes
- capability invocations
- rule-triggered actions
- agent-created drafts
- external side-effect attempts
- send email events
- attachment extraction results

Minimum audit event shape:

```json
{
  "id": "evt_...",
  "timestamp": 1777340000000,
  "mailboxId": "finance@example.com",
  "actor": {
    "type": "user",
    "id": "usr_...",
    "email": "owner@example.com"
  },
  "triggeredBy": "agent-tool",
  "capabilityId": "core:draft-reply",
  "scope": ["mailbox.write"],
  "resource": {
    "emailId": "..."
  },
  "result": {
    "ok": true
  }
}
```

## Cloudflare Infrastructure Fit

Current platform fit:

- Workers: global auth/API/SSR entrypoint
- Durable Objects: mailbox-local serialized state and agent session state
- D1: global control plane
- R2: attachment and artifact persistence
- Email Routing / Email Sending: native bidirectional email
- Workers AI / AI Gateway compatible provider: model execution
- MCP over Worker/DO: external agent interface

Next Cloudflare-native additions:

- Queues for async email processing, extraction, retries, and dead letters
- Workflows for multi-step business processes with explicit state
- Vectorize or Agent Memory for long-term semantic recall, only after audit and
  source attribution are in place
- Browser Run for browser-requiring workflows, gated behind owner-approved
  capabilities
- Sandboxes for code execution, never as default mailbox behavior

## Foundational Workstreams

### Workstream A: Product Narrative And Docs

Deliverables:

- product narrative document
- foundation architecture document
- README positioning update
- diagram updates

Acceptance:

- project is described as an agent-native mailbox platform
- non-goals and trust boundaries are explicit

### Workstream B: Control Plane Completion

Deliverables:

- D1 mailbox directory is authoritative
- R2 ACL is legacy/backfill only
- admin owner assignment and backfill are auditable

Acceptance:

- list mailboxes no longer scans R2 as the authority
- mailbox ownership is explicit
- owner/member/admin semantics are consistent across web, agent, and MCP

### Workstream C: Capability Policy

Deliverables:

- capability scopes enforced, not only displayed
- owner-only and external side-effect capabilities reviewed
- API keys can carry scope and mailbox restrictions

Acceptance:

- MCP clients can be issued least-privilege credentials
- webhook/external HTTP cannot reach arbitrary internal networks

### Workstream D: Background Work

Deliverables:

- queue-backed inbound processing steps
- retry and dead-letter records
- idempotency keys

Acceptance:

- inbound email persistence is separated from slow extraction or agent work
- failed downstream actions are inspectable and replayable

### Workstream E: Audit And Review

Deliverables:

- audit event writer
- capability invocation logging
- draft provenance UI

Acceptance:

- a user can inspect why an agent created a draft
- admins can review sensitive side effects and membership changes

### Workstream F: Skill Packs

Deliverables:

- skill document format
- built-in finance/support/ops packs
- mailbox owner enable/disable controls

Acceptance:

- skills can change mailbox behavior without code changes
- required capabilities remain policy-gated

## Architectural Decision Checklist

Before adding a feature, answer:

- Which mailbox owns this state?
- Which actor is invoking it?
- Which capability performs the side effect?
- Which scopes are required?
- Is it member-level or owner-level?
- Does it need human review?
- What is persisted?
- What is auditable?
- What happens on retry?
- How does MCP see the same boundary?

If these questions do not have clear answers, the feature is not ready to
implement.
