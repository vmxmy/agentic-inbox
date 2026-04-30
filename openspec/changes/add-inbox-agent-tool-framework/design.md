## Context

The official Cloudflare Agentic Inbox baseline is intentionally compact: a
mailbox is primarily identified by email address, mailbox settings are stored in
R2, mailbox state lives in `MailboxDO`, `EmailAgent` owns the email agent
runtime, and `EmailMCP` exposes a parallel tool surface.

That baseline can already host more than one mailbox, but it does not yet define
the platform-level contracts needed for many product inboxes, configurable agent
behavior, or flexible tool integration. Without those contracts, every new
workflow risks becoming a one-off agent class or hardcoded tool branch.

This design creates a foundation layer while preserving the official source
shape. It does not pull in the larger fork's full D1 control plane, native auth,
invoice workflow, or operations model. The goal is to make the official baseline
extensible first, then layer product-specific and multi-tenant features through
separate OpenSpec changes.

Cloudflare remains the hard architecture premise:

- Cloudflare Email Routing delivers inbound mail to the Worker.
- The Worker resolves the target inbox before state mutation or automation.
- Durable Objects remain the inbox-local serialized state boundary.
- R2 remains acceptable for profile/settings persistence in this change.
- Agents SDK remains the agent runtime foundation.
- MCP exposes governed tools; it does not become a separate plugin system.

## Goals / Non-Goals

**Goals:**

- Introduce `InboxProfile` as the runtime representation of an AI Inbox.
- Keep existing mailbox data compatible by adapting current settings into an
  inbox profile.
- Introduce `AgentProfile` as the configurable behavior contract for an inbox's
  agent.
- Keep the existing `EmailAgent` as the first concrete agent runtime.
- Introduce a shared tool capability registry used by both the agent and MCP.
- Make tool availability explicitly scoped by inbox, agent profile, and surface.
- Preserve the official baseline deployment and storage model for this slice.
- Prepare clean seams for later user-owned address creation, D1 control plane,
  multi-tenant administration, and domain-specific agents.

**Non-Goals:**

- Full user-owned `username.subname@root-domain` creation flow.
- Migrating mailbox identity from email address to stable `inbox_id`.
- Organization, tenant, billing, admin console, or custom domain management.
- Introducing required D1 migrations into the official baseline foundation.
- Building invoice, reimbursement, support, or other domain-specific agents.
- Building a Router Agent or autonomous natural-language routing.
- Building a user-facing agent/tool configuration UI.
- Allowing arbitrary user-uploaded executable plugins.
- Replacing Cloudflare Email Routing, Durable Objects, Agents SDK, or MCP.

## Decisions

### Decision: Add profile abstractions before changing storage identity

The system will introduce `InboxProfile` as a runtime adapter over existing
mailbox settings. The profile can include canonical address, display name,
lifecycle status, selected agent profile, and enabled tool metadata, but
`MailboxDO` can continue to be keyed by full email address for this change.

Alternatives considered:

- Immediate stable `inbox_id` migration: deferred because it touches inbound
  email, attachments, agent sessions, MCP routes, UI URLs, and local migration
  strategy.
- Keep passing raw email strings everywhere: rejected because it hides product
  boundaries and makes future multi-inbox behavior brittle.

### Decision: Model multi-agent as profiles first, not many DO classes

The first multi-agent step will be `AgentProfile`: a declarative behavior record
containing prompt/model/automation/tool configuration. `EmailAgent` remains the
initial runtime and resolves its behavior from the selected profile.

When `LLM_BASE_URL` is configured, `EmailAgent` uses an OpenAI-compatible chat
provider for inference and maps the default `AgentProfile` model to
`LLM_DEFAULT_MODEL`. If an agent profile pins a custom `modelId`, that pinned id
is preserved. If `LLM_BASE_URL` is absent, the runtime falls back to the
original Workers AI provider and default `@cf/...` model.

Safety checks use the same provider boundary. Prompt-injection scanning and
draft verification use `LLM_SAFETY_MODEL` when configured, otherwise
`LLM_DEFAULT_MODEL` when `LLM_BASE_URL` is present. Without `LLM_BASE_URL`, they
fall back to their original Workers AI safety models. This keeps the safety
policy centralized while preserving the current fail-closed prompt-injection
behavior.

Alternatives considered:

- One Durable Object class per agent type: rejected for the foundation slice
  because it encourages class explosion before the platform contract is clear.
- One hardcoded prompt per inbox: rejected because tools, automation policies,
  and future MCP exposure need a structured contract, not only prompt text.

### Decision: Build a shared tool capability registry

Tools will be declared as capabilities with identity, description, input schema,
optional output schema, supported surfaces, permission metadata, and an executor.
The agent and MCP adapters will both resolve tools from this registry.

Alternatives considered:

- Keep separate agent tools and MCP tools: rejected because behavior would drift
  and governance would need to be duplicated.
- Load arbitrary external plugin code at runtime: rejected because Workers
  deployment, security review, and Cloudflare compatibility require explicit
  registered capabilities.

### Decision: Tool execution receives explicit context

Every tool executor will receive a `ToolExecutionContext` containing inbox
identity, canonical address, agent profile identity, request identity, caller
identity when available, and Cloudflare environment bindings. Tool code must use
this context instead of deriving identity from global state.

Alternatives considered:

- Derive mailbox/agent identity from route params inside each tool: rejected
  because it duplicates validation and makes non-HTTP surfaces harder.
- Pass the full request object into every tool: rejected because it couples tool
  execution to one transport surface.

### Decision: Treat MCP as a surface over the same capabilities

MCP listing and execution will filter registered capabilities by `mcp` surface
and the current inbox/agent profile. MCP will not expose tools that are agent
only or disabled for the inbox.

Alternatives considered:

- MCP-specific tool registry: rejected because it creates two permission models.
- Expose every registered tool through MCP by default: rejected because some
  tools are automation-only or unsafe outside the agent execution loop.

### Decision: Keep persistence additive and official-baseline compatible

This change will use additive profile metadata inside the existing R2-backed
mailbox settings record. It should not require D1 for the foundation slice,
though the design must not block a later D1 control-plane migration.

Alternatives considered:

- Introduce D1 immediately: deferred because the official source does not depend
  on D1 and this foundation can be validated without that migration.
- Store profile metadata in a separate sidecar R2 key: deferred because the
  first foundation slice should minimize read-path and consistency complexity.
- Store profile config only in code: rejected because inbox-specific behavior
  must be configurable per inbox.

### Decision: Use Durable Objects for runtime actors, not all business entities

Durable Objects are appropriate for entities that combine durable state,
behavior, and serialized request handling. In this product, good Durable Object
candidates include inbox runtime state, agent sessions, workflow run
coordinators, and a future Router Agent.

Durable Objects are not the primary storage model for metadata and control-plane
entities such as users, address registry records, inbox profiles, tool
definitions, permission assignments, billing records, or audit logs. Those
entities belong in a control plane such as D1 or in R2 when this official
baseline slice intentionally avoids D1.

This change treats `InboxProfile` as metadata loaded from R2-backed mailbox
settings, not as a Durable Object. The existing `MailboxDO` remains the runtime
actor for inbox-local message state.

Alternatives considered:

- Create one Durable Object for every business entity: rejected because it would
  make global querying, uniqueness checks, permission administration,
  migrations, reporting, and operations dashboards unnecessarily difficult.
- Avoid Durable Objects except for the existing mailbox: rejected as a long-term
  direction because agent sessions, workflow coordinators, and future routing
  actors can benefit from serialized stateful execution.

### Decision: Keep agent and tool configuration internal for this slice

This change will seed or default agent profiles and enabled tools internally. It
will not add a user-facing configuration UI for selecting prompts, models,
automation policies, or tool permissions.

Alternatives considered:

- Add full UI configuration immediately: deferred because the runtime contract
  should stabilize before exposing product controls.
- Hardcode all configuration in the agent runtime: rejected because inbox-level
  behavior needs a data-shaped profile contract even before UI exists.

### Decision: Defer Router Agent until routable objects are stable

This change will not build an independent Router Agent. Users will continue to
work inside an explicitly selected inbox, and inbound email will route by
recipient address. The foundation will still make future routing possible by
giving inboxes, agent profiles, and tool capabilities stable identities.

Alternatives considered:

- Add Router Agent now: rejected because the current foundation is defining the
  routable objects first. A router would otherwise have unclear targets and
  could become a hardcoded policy hub.
- Depend only on manual routing forever: rejected as a long-term direction
  because a future global chat entry point should be able to recommend or select
  target inboxes when the user has not already chosen one.

Future routing policy:

- Inbound email recipient address remains a strong route to an inbox.
- A future router can assist global chat routing, but it must not bypass access
  policy, tool permissions, or high-risk action confirmation.
- The next routing step should be assisted routing with explainable
  recommendations before autonomous routing.

## Risks / Trade-offs

- Transitional email identity can calcify -> Mitigation: document
  email-address-based `MailboxDO` identity as transitional and keep profile
  APIs separated from storage names.
- Profile metadata in R2 can become a weak control plane -> Mitigation: keep the
  profile loader interface narrow so a later D1-backed implementation can
  replace it.
- Agent profiles may be mistaken for true multi-agent orchestration ->
  Mitigation: explicitly scope this change to profile-based behavior selection,
  not multi-agent planning or delegation.
- Tool registry can become too generic too early -> Mitigation: register only
  existing email tools in this slice and require future tools to add concrete
  specs/tests.
- MCP exposure can accidentally widen permissions -> Mitigation: require
  explicit surface declarations and deny-by-default filtering.
- Existing behavior can regress during refactor -> Mitigation: keep the default
  inbox profile and default email agent profile behavior equivalent to the
  official baseline.

## Migration Plan

1. Define runtime types for inbox profiles, agent profiles, tool capabilities,
   and tool execution context.
2. Add profile loaders that adapt existing mailbox settings into `InboxProfile`
   and default missing fields.
3. Add a default email agent profile equivalent to current behavior.
4. Create the shared tool registry and register current email tools.
5. Update `EmailAgent` to resolve tools and behavior through the profile and
   registry path.
6. Update `EmailMCP` to list and execute only MCP-surface tools from the shared
   registry.
7. Add tests or type-level verification for profile defaults and tool filtering.
8. Run `npm run typecheck` and `npm run build`.

Rollback strategy:

- The change is additive and keeps existing mailbox/settings storage.
- If profile resolution fails, the runtime can fall back to the default inbox
  profile and default email agent profile.
- If the shared registry causes issues, existing tools can remain registered as
  built-ins while the adapter logic is corrected.

## Open Questions

- Which existing tools are safe to expose through MCP by default, and which
  should remain agent-only?
- `AgentProfile` supports model configuration in this implementation. The
  environment default only replaces the built-in profile's Workers AI default
  when an OpenAI-compatible provider is configured.
