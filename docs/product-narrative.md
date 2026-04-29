# Product Narrative

Updated: 2026-04-29

## Positioning

Agentic Inbox is an open-source, agent-native mailbox platform.

Its Cloudflare infrastructure baseline is documented in
[Cloudflare Agentic Cloud 2026 Guide](cloudflare-agentic-cloud-2026-guide.md).
The tool/skill/MCP extension model is documented in
[Agent Tool Extension Architecture](agent-tool-extension-architecture.md).

It is not just an AI email client. It treats email as a durable workflow
substrate: mailbox addresses become role-based workspaces, email threads become
long-lived sessions, attachments become persisted artifacts, and agents operate
through scoped mailbox capabilities.

Short form:

> Open-source agent-native mailboxes for durable workflows.

Long form:

> Agentic Inbox lets teams turn shared role mailboxes such as `finance@`,
> `support@`, `ops@`, or `legal@` into agent-native workspaces. Each mailbox
> owns its email history, attachments, rules, skills, agent prompts, and access
> policy. Built-in agents can read context, extract artifacts, draft responses,
> and invoke workflow capabilities while humans keep control over sensitive
> actions.

## Core Thesis

Email is already the protocol through which a large amount of operational work
arrives.

It has properties most agent platforms try to rebuild:

- cross-organization identity and delivery
- asynchronous conversation threads
- durable archives
- attachments and business documents
- forwarding, reply, and audit conventions
- role addresses such as `finance@` and `support@`
- human review before external communication

Agentic Inbox builds on that substrate instead of replacing it with another
chat surface. The product goal is to make a mailbox behave like a scoped agent
runtime.

## Product Promise

For a self-hosting operator:

> Deploy once to Cloudflare and get a multi-mailbox, agent-native work platform
> where every mailbox has its own state, attachments, skills, agent behavior,
> members, and audit boundary.

For a team member:

> Work from the mailbox you already understand, while agents help classify,
> extract, search, draft, and prepare actions without taking away human control.

For an external agent client:

> Connect through MCP or API keys and operate only on the mailboxes and
> capabilities your identity is allowed to use.

## Primary Narrative Anchor: Finance Mailbox

The first user-conversion story should be `finance@`.

The user-facing walkthrough lives in
[Finance Workflow Demo](finance-workflow-demo.md), with the workflow diagram at
[`docs/assets/agentic-inbox-finance-workflow.svg`](assets/agentic-inbox-finance-workflow.svg).

A vendor sends an invoice email. The mailbox stores the thread as the durable
session, persists XML/OFD/PDF/ZIP files and downloaded links as artifacts,
extracts structured invoice records, marks uncertain fields for review, and
lets the agent prepare follow-up drafts while the human owner approves
sensitive outputs.

This scenario should come before generic platform language because it makes the
category concrete:

- the mailbox address is the role workspace
- the email thread is the workflow session
- invoice files are artifacts, not disposable prompt context
- extraction produces records with source evidence
- the agent prepares work through scoped capabilities
- humans remain accountable for sending, deletion, export, and integrations

The finance story is also the best proof that Agentic Inbox is not just an AI
email client. The value is not faster reply writing; the value is turning a
shared role inbox into a durable, auditable workflow runtime.

### Finance Before And After

| Normal `finance@` inbox | Agentic Inbox `finance@` |
| --- | --- |
| Invoice work splits across downloads, spreadsheets, chat, and replies | The email thread stays the durable workflow session |
| Attachments are copied around manually | Source and derived files are persisted as artifacts |
| People retype invoice fields | Parsers and OCR fallback create structured records |
| Low-confidence fields can be missed | Review flags keep humans in the loop |
| Follow-up replies are copied from templates | The agent drafts clarification emails for approval |
| Audit requires reconstructing evidence | Fields link back to source email and attachment ids |
| External agents need broad credentials | MCP clients use the same mailbox ACL and capability policy |

## Category Definition

Agentic Inbox should define itself as:

> An agent-native shared mailbox platform.

This category is deliberately narrower than "AI email client" and more concrete
than "agent platform."

It means:

- email remains the durable channel of record
- role mailboxes are the primary workspaces
- agents are embedded into mailbox workflows
- skills describe mailbox behavior
- capabilities enforce what agents may actually do
- humans remain accountable for external side effects

The project should not lead with generic automation language. The wedge is
clearer:

> Give every role mailbox its own agent, skills, memory, artifacts, and policy.

## Personas And Jobs

### Instance Operator

The operator deploys and maintains the open-source instance.

Jobs:

- deploy to a Cloudflare account without running servers
- configure domains, sending, receiving, and Workers AI
- create role mailboxes and assign owners
- understand audit, migration, and recovery paths
- keep sensitive integrations and API keys under control

Product needs:

- explicit setup checklist
- admin panel for users and mailboxes
- safe defaults for auth and sending
- visible health and background-job status
- backup/export story for durable records and artifacts

### Mailbox Owner

The owner is responsible for one role mailbox such as `support@` or
`finance@`.

Jobs:

- invite members
- choose agent behavior and skills
- approve sensitive capabilities
- configure rules and integrations
- review draft provenance and extracted artifacts

Product needs:

- mailbox settings that feel like operating policy, not generic preferences
- skill packs with clear required capabilities
- owner-only controls for external side effects
- audit views scoped to the mailbox

### Mailbox Member

The member works inside the mailbox day to day.

Jobs:

- read and reply to threads
- ask the agent for summaries, search, extraction, and draft help
- verify agent suggestions
- keep work organized through folders, labels, drafts, and status

Product needs:

- fast email client ergonomics
- visible agent tool calls
- clear draft review loop
- no surprise automation that sends externally without policy

### External Agent Client

An external client connects through MCP or API keys.

Jobs:

- inspect mailbox context through approved tools
- create drafts or extracted records
- trigger workflows under least privilege
- operate without bypassing the web app's authority model

Product needs:

- scoped API keys
- bounded MCP tools
- actionable errors
- audit evidence for every tool call

## Jobs-To-Be-Done

The strongest initial job is finance intake because it makes the durable
mailbox workflow obvious.

1. Finance intake

   When invoices or reimbursement documents arrive, extract structured data,
   group related attachments, flag uncertain fields, prepare clarification
   emails, and keep the original documents linked to every derived record.

2. Support triage

   When new customer email arrives, classify it, summarize context, locate
   similar prior threads, draft a response, and leave a human-reviewable record.

3. Operations coordination

   When vendors or partners send operational updates, capture tasks, route
   follow-ups, prepare replies, and keep artifacts attached to the thread.

4. External agent delegation

   When a coding or desktop agent needs mailbox context, expose a small MCP
   surface that can search, read, draft, and extract without giving it global
   mailbox access.

## Canonical Product Loop

The core loop should be easy to explain:

```
email arrives
  -> mailbox persists it
  -> rules and skills shape what should happen
  -> agent prepares work through scoped capabilities
  -> human reviews sensitive outputs
  -> system records the result and provenance
```

This loop matters because it keeps the product differentiated:

- email is not just a notification trigger; it is the durable session
- attachments are not throwaway context; they are artifacts
- drafts are not final actions; they are reviewable proposals
- capabilities are not generic tools; they are mailbox-scoped authority

## Golden Workflows

### Finance Mailbox

1. A vendor sends an invoice to `finance@`.
2. The mailbox stores the email thread as the durable workflow session.
3. Source attachments and derived files are persisted in R2 and referenced from
   MailboxDO.
4. An invoice skill triggers extraction for XML, OFD, PDF, ZIP, external-link,
   or manual-upload sources.
5. Parser code creates structured invoice records; OCR fallback can mark fields
   that need review.
6. The invoice agent summarizes context, explains provenance, and drafts
   follow-up questions when documents are missing or ambiguous.
7. A human member reviews extracted fields and approves sensitive outputs such
   as sending, deletion, export, or integration calls.
8. Every extracted field remains linked to source email and attachment ids.

### Support Mailbox

1. A customer sends a question to `support@`.
2. The mailbox stores the thread and attachments.
3. A triage rule classifies urgency and product area.
4. The support skill gives the agent response style and escalation policy.
5. The agent searches prior threads and drafts a reply.
6. A member edits or approves the draft.
7. The sent reply and agent provenance remain attached to the thread.

### MCP Mailbox Client

1. A user creates a scoped API key.
2. An MCP client connects to `/mcp`.
3. The Worker resolves the user and mints a signed internal auth context.
4. MCP lists only visible mailboxes and exposes allowed capabilities.
5. Tool calls produce bounded results and audit records.
6. The client can draft or inspect, but cannot bypass mailbox policy.

## MVP Product Boundary

MVP should mean "the loop works safely," not "every agent feature exists."

Must have:

- native auth and admin bootstrap
- explicit mailbox owner/member model
- inbound and outbound email
- per-mailbox Durable Object storage
- attachment persistence
- agent chat with mailbox-scoped tools
- auto-draft that saves proposals for review
- MCP access through the same ACL
- capability registry as the shared tool boundary

Should have next:

- structured audit events
- scoped API keys
- background execution for slow work
- skill packs for finance and support
- mailbox knowledge search

Defer:

- autonomous sending by default
- unrestricted external HTTP/browser/sandbox capabilities
- multi-tenant hosted SaaS assumptions
- generic agent swarm UI
- hidden global memory across mailboxes

## Product Maturity Stages

### Stage 1: Agent-Native Inbox

The product is a self-hosted shared mailbox with built-in agents.

Success signal:

- teams can receive, read, draft, send, and use agent assistance safely across
  multiple role mailboxes

### Stage 2: Workflow Mailboxes

Mailboxes become configurable workflow surfaces with skills, rules, extraction,
background jobs, and audit.

Success signal:

- a mailbox owner can install a support or finance pack and understand exactly
  what capabilities it enables

### Stage 3: Agent Platform Boundary

The same mailbox capabilities are exposed to external agents, scoped API keys,
retrieval, and optional integrations.

Success signal:

- MCP clients and built-in agents behave consistently under one policy model

### Stage 4: High-Power Execution

Browser, sandbox, private network, and generated-code execution become
owner-approved optional capabilities.

Success signal:

- advanced workflows can run without leaking secrets or giving agents ambient
  authority

## Audience

Primary audience:

- small teams and operators who want a self-hosted shared inbox with native AI
- technical teams that prefer Cloudflare-native infrastructure over hosted SaaS
- open-source builders who want a concrete agent workflow substrate

High-fit departments:

- finance teams handling invoices, reimbursements, and payment documents
- support teams triaging inbound requests
- operations teams coordinating vendors and logistics
- sales or partnerships teams handling lead follow-up
- legal and HR teams handling document-heavy asynchronous processes

Lower-fit use cases:

- consumer Gmail replacement
- high-frequency chat or realtime collaboration
- unrestricted autonomous agents
- generic agent swarm orchestration
- workflows where email is not the natural entry point

## Mental Model

The product maps familiar email concepts onto agent-native concepts:

| Email concept | Agent-native meaning |
| --- | --- |
| Mailbox address | Role workspace and authorization boundary |
| Mailbox owner | Local operator for membership, skills, and integrations |
| Mailbox member | Human collaborator with read/write workflow access |
| Email thread | Durable session |
| Incoming email | Event that may trigger rules and agents |
| Draft | Agent proposal awaiting review |
| Sent email | Explicit external side effect |
| Attachment | Persisted artifact |
| Folder / labels | Workflow state |
| Rule | Declarative trigger |
| Capability | Scoped unit of work exposed to rules, agents, MCP, or UI |
| Skill | Changeable behavior, SOP, prompt, or workflow policy |
| MCP client | External agent facade using the same mailbox ACL |

## Product Surfaces

### Web Inbox

The browser experience remains the human control room. It provides mailbox
navigation, thread reading, compose, folders, search, settings, members, rules,
agents, and API keys.

### Mailbox Settings

Each mailbox carries its own operating model:

- owner and members
- display identity
- agent prompts
- enabled skills
- inbound rules
- model/provider preference
- integrations and capability policy

### Built-In Agents

Agents are mailbox-scoped. They should behave like workers assigned to a role
address, not like global superusers.

Current agent categories:

- Email Reply Agent: reads, searches, and drafts replies
- Invoice Agent: extracts invoice data and manages reimbursement bundles

Future agents should follow the same pattern: they are attached to a mailbox,
receive only scoped context, and invoke capabilities through policy gates.

### Skills And Capabilities

Skills describe changeable operational behavior: prompts, SOPs, workflows,
tone, triage rules, escalation criteria, and department-specific instructions.

Capabilities are code-backed actions with schemas, scopes, permissions, and
surface declarations. They are the hard boundary around what agents and rules
can actually do.

### Rules

Rules turn inbound mail into deterministic workflow triggers:

- match email metadata or content
- invoke safe capabilities
- enrich the agent prompt
- suppress or request draft generation
- route or extract artifacts

Rules should stay declarative. Complex business procedures belong in skills or
coarse-grained capabilities, not in ad hoc UI condition trees.

### MCP And API Keys

MCP is the external agent interface. It exposes mailbox tools to clients such as
coding agents or desktop AI tools while preserving the same mailbox ACL and
capability policy.

API keys are user-bound credentials. They inherit the user's mailbox access and
should become increasingly scope-aware as the product matures.

## Trust Contract

The product must be conservative with authority.

- Mailbox membership grants access to mailbox data, not unlimited integration
  power.
- Owner-only operations include member management, invite issuance, sensitive
  integrations, and capability configuration.
- Agents draft by default; sending email is a deliberate human or explicitly
  authorized action.
- External email content is untrusted input and may contain prompt injection.
- Attachments are untrusted artifacts until parsed by bounded extractors.
- Internal worker-to-Durable-Object identity uses signed auth-context envelopes,
  not caller-supplied identity headers.
- System-triggered flows may process inbound mail but should not gain owner
  privileges by default.

## Product Principles

1. Mailbox first

   A mailbox is the primary product unit. Every agent, skill, rule, artifact,
   and policy should answer: which mailbox owns this?

2. Human review for irreversible external effects

   Agents can prepare work, but sending, deleting, exporting, and external
   calls need explicit policy and audit.

3. Capabilities over raw APIs

   Agents should not receive dozens of low-level APIs. They receive a small set
   of coarse, mailbox-aware capabilities.

4. Durable by default

   Threads, drafts, attachments, extracted records, rules, and agent history
   should survive restarts and be inspectable.

5. Open-source deployability

   The default deployment should run in one Cloudflare account with clear
   setup, migration, and recovery paths.

6. Policy is part of product design

   Permission scopes, ownership, audit, and egress limits are product features,
   not implementation details.

## Non-Goals

Agentic Inbox should not become:

- a full Gmail clone
- a general chat app
- a no-code automation builder with unlimited side effects
- an autonomous outbound email bot
- a multi-tenant hosted SaaS control plane before the self-hosted model is
  solid
- a place where agents can bypass mailbox ACL through internal tools

## Open-Source Story

The open-source value is the combination of:

- Cloudflare-native deployability
- mailbox-scoped Durable Object state
- agent-native workflow semantics
- MCP exposure of the same tool layer
- clear capability and permission contracts
- inspectable persistence for email, attachments, drafts, and extracted data

The strongest community message is:

> Own your agent workflows where business work already arrives: the mailbox.

## Narrative For README

Suggested headline:

> Agentic Inbox
>
> Open-source agent-native mailboxes for durable workflows.

Suggested intro:

> Agentic Inbox turns role mailboxes such as `finance@` into agent-native
> workspaces. An invoice email becomes a durable workflow session, attachments
> become source-linked artifacts, agents extract structured records and prepare
> drafts, and humans approve sensitive outputs. The platform runs on Cloudflare
> Workers, Durable Objects, R2, Email Routing, Workers AI, and MCP.

Suggested one-liner:

> Email is the session layer. Attachments are artifacts. Mailboxes are agent
> workspaces.

Suggested README flow:

1. Lead with the `finance@` invoice intake story.
2. Show the finance workflow diagram.
3. Explain before/after against a normal shared inbox.
4. Link to `docs/finance-workflow-demo.md` and sample data paths.
5. Move setup and architecture details after the user understands the workflow.

## Success Criteria

The product narrative is working when:

- a new visitor can read [Finance Workflow Demo](finance-workflow-demo.md) and
  explain how one invoice email becomes a reviewable workflow
- a new visitor understands this is an agent workflow platform, not only an AI
  email client
- every feature can name its mailbox, actor, capability, and persistence model
- agents cannot accidentally become global operators
- external MCP clients see the same authority boundaries as the web app
- the default product loop is "agent prepares, human verifies, system records"
