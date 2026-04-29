# Agent Tool Extension Architecture

Updated: 2026-04-28

## Goal

Agentic Inbox needs a flexible way to extend what agents can do without turning
the LLM into an unrestricted API caller.

The target model:

> Skills change behavior. Capabilities execute local work. MCP connectors bring
> external tools, resources, and prompts into a mailbox under explicit policy.

This document defines the architecture for extending built-in agents with:

- code-backed local capabilities
- mailbox skill packs
- external MCP servers
- MCP prompts and resources
- future high-power tools such as browser, sandbox, or private-network access

## Design Sources

Primary references:

- MCP Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP Resources: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- MCP Prompts: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- Cloudflare Agents MCP client: https://developers.cloudflare.com/agents/api-reference/mcp-client-api/
- Cloudflare Agents McpAgent: https://developers.cloudflare.com/agents/api-reference/mcp-agent-api/
- Cloudflare Skills repo: https://github.com/cloudflare/skills

## Current State

Agentic Inbox already has the right first primitive:

- `workers/lib/capabilities` defines local code-backed capabilities.
- Capabilities can be exposed on `rule-action`, `agent-tool`, and `mcp-tool`
  surfaces.
- `EmailAgent` builds AI SDK tools from the capability registry.
- `EmailMCP` exposes capability-backed tools to external MCP clients.
- Mailbox settings can narrow `emailReplyEnabledSkills`.

The gaps:

- `InvoiceAgent` still owns a separate hand-written tool surface.
- "Skills" currently mean "enabled capability ids" rather than full skill
  packs with prompts, rules, required tools, and validation.
- External MCP servers are not installable as mailbox-scoped tool sources.
- MCP resources and prompts are not represented in the product.
- Capability scopes are descriptors, but not yet full per-mailbox/per-key
  policy.
- Tool calls are logged, but not yet durable audit events with approval state.

## Non-Goals

Do not solve extensibility by:

- giving agents arbitrary REST endpoints
- letting a skill grant authority by prompt text
- auto-importing every external MCP tool into every mailbox
- re-exporting external MCP tools through Agentic Inbox MCP without explicit
  owner approval
- storing credentials in prompts, settings JSON, or client-visible metadata
- mixing tools from multiple mailboxes in one model turn

## Five-Layer Mapping

| Layer | Product object | Rule |
| --- | --- | --- |
| Brain | LLM / model turn | chooses among allowed tools; owns no authority |
| Skills | skill packs, prompts, SOPs | may request tools; cannot grant tools |
| Agent Facade | tool catalog, MCP facade | exposes bounded tools/resources/prompts |
| Limbs | capability implementations and MCP proxy calls | deterministic execution with schemas |
| World State | D1, MailboxDO, R2, external systems | source of truth and audit evidence |

## Extension Types

### 1. Built-In Capability

Code-backed work shipped in the repository.

Examples:

- `core:list-emails`
- `core:get-thread`
- `core:draft-reply`
- `core:extract-invoice`
- `core:webhook`

Use when:

- the operation touches mailbox data
- the action needs strong authorization
- the action has important side effects
- deterministic code is safer than model behavior

### 2. Skill Pack

Soft-coded behavior installed into a mailbox.

A skill pack may include:

- prompt fragments
- SOP text
- required capability ids
- optional capability ids
- default rule templates
- default retrieval resources
- external MCP connector requirements
- validation checklist

Skills do not execute. They shape behavior and request a tool policy.

Example:

```json
{
  "id": "finance.invoice-intake",
  "version": 1,
  "title": "Finance invoice intake",
  "agents": ["invoice", "email-reply"],
  "prompt": "Treat invoice emails as finance intake work...",
  "requiredTools": [
    "builtin:core:extract-invoice",
    "builtin:core:draft-reply"
  ],
  "optionalTools": [
    "builtin:core:search-emails"
  ],
  "defaultRules": [],
  "approvalPolicy": {
    "email.send": "human"
  }
}
```

### 3. External MCP Connector

Mailbox- or instance-scoped connection to an MCP server.

Examples:

- GitHub MCP for issue lookup
- Slack MCP for channel context
- Linear MCP for ticket creation
- internal company MCP behind Access

Use when:

- the external system already has a good MCP server
- the mailbox owner can authorize that system
- the tools can be scoped, named, audited, and optionally approval-gated

### 4. MCP Prompt Or Resource

MCP prompts and resources are context, not authority.

Examples:

- a prompt template from an installed MCP server
- a project resource returned by an external MCP server
- an Agentic Inbox skill prompt exposed through its own hosted MCP endpoint

Use when:

- the agent needs reusable instructions
- the user explicitly selects context
- the result can be size-capped and source-linked

## Target Architecture

```
Mailbox Settings
  - enabled skill packs
  - enabled local tools
  - enabled MCP connectors
  - approval and export policy
        |
        v
Tool Catalog Builder
  - built-in capability provider
  - skill pack provider
  - MCP connector provider
  - resource/prompt provider
        |
        v
Mailbox Tool Catalog
  - normalized tool descriptors
  - prompt fragments
  - resource descriptors
  - risk/approval metadata
        |
        +--> EmailAgent / InvoiceAgent AI SDK tools
        +--> EmailMCP hosted MCP tools/prompts/resources
        +--> Rule action editor
        +--> Audit and approval middleware
```

The Tool Catalog Builder is the missing layer. It should become the one place
that decides which tools a mailbox agent can see.

## Normalized Tool Descriptor

All tool sources should normalize into one descriptor shape.

```ts
type ToolSourceType = "builtin" | "skill" | "mcp";

interface ToolDescriptor {
  id: string;
  sourceType: ToolSourceType;
  sourceId: string;
  name: string;
  displayName: string;
  description: string;
  surfaces: Array<"agent-tool" | "mcp-tool" | "rule-action" | "ui">;
  scopes: string[];
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  risk: "low" | "medium" | "high";
  approval: "none" | "human" | "owner";
}
```

Recommended id format:

| Source | Tool id |
| --- | --- |
| built-in capability | `builtin:core:list-emails` |
| skill-provided prompt/action | `skill:finance.invoice-intake:triage` |
| external MCP tool | `mcp:<connector-id>:<tool-name>` |

AI SDK tool names should be short and model-friendly, but ids should stay
stable and globally namespaced.

## Skill Pack Manifest

Skill packs should be stored as versioned documents.

Recommended repository layout:

```
skills/
  support.triage/
    skill.json
    prompt.md
    rules.json
    README.md
  finance.invoice-intake/
    skill.json
    prompt.md
    rules.json
    README.md
```

Manifest:

```json
{
  "id": "support.triage",
  "version": 1,
  "title": "Support triage",
  "description": "Classify inbound support mail and draft concise replies.",
  "agents": ["email-reply"],
  "requiredTools": [
    "builtin:core:list-emails",
    "builtin:core:get-thread",
    "builtin:core:draft-reply"
  ],
  "optionalTools": [
    "builtin:core:search-emails",
    "mcp:github:search_issues"
  ],
  "requiredScopes": ["mailbox.read", "mailbox.write"],
  "promptFile": "prompt.md",
  "rulesFile": "rules.json",
  "defaultApproval": {
    "email.send": "human",
    "external.http": "owner"
  }
}
```

Install behavior:

1. Owner selects a skill pack.
2. System shows required tools, scopes, and high-risk actions.
3. Owner enables or rejects optional tools.
4. Skill prompt is added to the mailbox agent prompt stack.
5. Rule templates are copied as editable mailbox rules.
6. Enabled tools become mailbox policy rows.

Uninstall behavior:

- remove prompt contribution
- disable tools installed only for that skill
- leave user-edited rules in place unless the owner chooses to delete them
- keep audit history

## MCP Connector Model

Connector object:

```ts
interface McpConnector {
  id: string;
  scope: "instance" | "mailbox";
  mailboxId?: string;
  name: string;
  url: string;
  transport: "auto" | "streamable-http" | "sse";
  authType: "none" | "bearer" | "oauth" | "access-service-token";
  enabled: boolean;
  exportToHostedMcp: boolean;
  discoveredAt?: number;
  status: "pending" | "ready" | "authenticating" | "error";
}
```

Discovery flow:

```
Owner adds MCP server
  -> Worker validates URL and auth mode
  -> connector stored disabled or pending
  -> Agent/MCP connector runtime connects and lists tools/resources/prompts
  -> descriptors are normalized and cached
  -> owner reviews imported tools
  -> selected tools become enabled mailbox policy
```

Execution flow:

```
Agent calls normalized mcp:<connector>:<tool>
  -> tool middleware checks mailbox policy and approval state
  -> MCP connector runtime calls remote tools/call
  -> result is size-capped, sanitized, and source-tagged
  -> audit event records connector id, tool name, input hash, result status
```

Important stance:

Cloudflare Agents SDK can automatically make all tools from a connected MCP
server available to an agent. Agentic Inbox should not use that behavior
directly for mailbox agents. Instead, it should discover the server and then
re-publish only owner-approved tools through the mailbox Tool Catalog Builder.

## Resources And Prompts

MCP resources and prompts should enter the product as context objects:

| MCP object | Agentic Inbox object | Default behavior |
| --- | --- | --- |
| tool | ToolDescriptor | hidden until owner approves |
| prompt | Skill prompt candidate | selectable/pinnable by owner |
| resource | Knowledge/resource descriptor | explicit select/read with size caps |

Rules:

- Resources are never auto-injected into every turn.
- Prompts from external MCP servers are never trusted as policy.
- Prompt text can guide behavior but cannot enable tools.
- Resource reads require the same mailbox and connector policy as tool calls.
- Hosted MCP should expose Agentic Inbox skills as prompts only after they are
  versioned and documented.

## Policy Model

Tool visibility is the intersection of:

1. agent type allowlist
2. mailbox enabled tools
3. skill pack requirements
4. actor role
5. API key scope restrictions
6. approval state
7. connector status

Recommended policy row:

```ts
interface MailboxToolPolicy {
  mailboxId: string;
  toolId: string;
  enabled: boolean;
  allowedSurfaces: string[];
  requiredRole: "member" | "owner" | "admin";
  requiredScopes: string[];
  approval: "none" | "human" | "owner";
  exportToMcp: boolean;
  installedBySkillId?: string;
  updatedBy: string;
  updatedAt: number;
}
```

Risk defaults:

| Tool class | Default risk | Default approval |
| --- | --- | --- |
| mailbox read | low | none |
| draft/create local record | medium | none |
| send email | high | human/owner |
| external HTTP/MCP write | high | owner |
| browser/sandbox/private network | high | owner |
| resource read from external MCP | medium | none or human by connector |

## Agent Tool Assembly

Each agent turn should build tools through a single function:

```ts
async function buildAgentToolCatalog(ctx: {
  env: Env;
  mailboxId: string;
  agentId: "email-reply" | "invoice";
  actor: AuthUser | null;
  surface: "agent-tool";
}): Promise<Record<string, AiSdkTool>>;
```

This replaces per-agent bespoke tool lists over time.

Rules:

- EmailAgent and InvoiceAgent both consume the same catalog builder.
- The catalog builder filters before the model sees tool names.
- Disabled tools are not described to the model.
- Tool descriptions include constraints and recovery guidance.
- Result bodies are bounded before returning to the model.
- High-risk tools return an approval-required result instead of executing.

## Hosted MCP Surface

Agentic Inbox's `/mcp` endpoint should expose:

- local capability tools approved for MCP
- mailbox-aware resources such as selected threads, drafts, or skill docs
- prompts for installed and built-in skill packs

It should not expose:

- every external MCP tool by default
- owner/admin tools to member-scoped API keys
- high-risk external tools without explicit `exportToMcp`
- unbounded email bodies or attachment bytes

MCP naming convention:

| Tool | Name |
| --- | --- |
| built-in mailbox tool | `mailbox_list_emails` or existing stable name |
| skill prompt | prompt name `skill:<id>` |
| external MCP tool re-export | `mcp_<connector>_<tool>` only if approved |

Keep existing public tool names stable where clients may already depend on
them. New tools should use consistent prefixes.

## Data Model Direction

Near-term, mailbox settings can hold enough policy to move quickly.

Target stores:

| Data | Store |
| --- | --- |
| built-in skill pack files | repo `skills/` |
| installed skill pack ids | MailboxDO settings |
| mailbox tool policy | MailboxDO settings first, D1 index later |
| instance MCP connectors | D1 |
| mailbox MCP connectors | MailboxDO settings + encrypted D1 secret refs |
| connector discovered descriptors | D1 cache or MailboxDO cache |
| connector credentials | encrypted D1/R2 envelope or Cloudflare-managed secret path |
| tool audit events | D1 audit table |

Credential rule:

Do not put connector tokens in mailbox settings JSON. Use encrypted credential
records with a deployment secret such as `CONNECTOR_SECRET`, or Cloudflare
managed OAuth/token storage where the Agents SDK owns the flow.

## Implementation Plan

### PR A: Tool Extension Architecture Docs

Scope:

- add this document
- link it from product/foundation/cloudflare guide docs

Acceptance:

- the project has one shared vocabulary for capabilities, skills, MCP
  connectors, prompts, resources, and policy

### PR B: Tool Catalog Core

Scope:

- add `workers/lib/tool-catalog`
- normalize built-in capabilities into `ToolDescriptor`
- add catalog builder for `agent-tool`, `mcp-tool`, and `rule-action`
- keep existing EmailAgent behavior unchanged

Acceptance:

- EmailAgent still sees the same default tools
- `/api/v1/mailboxes/:id/capabilities` can be backed by the catalog
- no external MCP runtime yet

### PR C: InvoiceAgent Capability Migration

Scope:

- convert invoice tools into capabilities
- make InvoiceAgent use the same catalog builder
- wire `invoiceEnabledSkills`

Acceptance:

- invoice tools can be listed, toggled, audited, and exposed consistently
- no hand-written agent-only invoice tool surface remains

### PR D: Skill Pack MVP

Scope:

- add repo-local `skills/` format
- ship `support.triage` and `finance.invoice-intake`
- add install/uninstall APIs
- map installed skills to prompt fragments and enabled tool ids

Acceptance:

- owner can enable a skill pack without code changes
- skill pack required tools are visible before install
- prompt text changes behavior but cannot bypass tool policy

### PR E: MCP Connector Discovery

Scope:

- add MCP connector schema and owner APIs
- connect to a remote MCP server
- discover tools/resources/prompts
- cache descriptors
- show imported tools disabled by default

Acceptance:

- owner can add a read-only test MCP server
- discovered tools appear with source, schema, risk, and annotations
- no discovered tool is available to agents until approved

### PR F: MCP Tool Execution

Scope:

- execute approved external MCP tools through catalog
- add timeout, output cap, sanitization, and audit hooks
- support bearer/custom-header auth first
- defer OAuth unless needed for first connector

Acceptance:

- an enabled external MCP read tool can be called from an agent
- failures return actionable errors
- results are bounded before reaching the LLM

### PR G: MCP Prompts And Resources

Scope:

- represent prompts as skill prompt candidates
- represent resources as explicit selectable context
- expose installed skill prompts/resources from hosted `/mcp`

Acceptance:

- external prompt text never enables tools
- resource reads are size-capped and source-linked
- Agentic Inbox's MCP server can advertise selected skill prompts

### PR H: Policy, Approval, And Scoped Keys

Scope:

- add durable audit events
- enforce API-key scopes and mailbox restrictions
- add approval-required tool results
- add owner approval UI for high-risk tools

Acceptance:

- MCP clients and built-in agents see the same tool policy
- high-risk tools cannot execute silently
- every tool call has an audit event

## First Cut Recommendation

Do not start with external MCP execution.

Start with:

1. Tool Catalog Core
2. InvoiceAgent capability migration
3. Skill Pack MVP

Then add MCP connector discovery and execution.

Reason:

The current code already has a capability registry. If we first make that
registry the universal catalog for all agents, external MCP tools become just
another provider. If we add external MCP first, policy, UI, and audit will
fragment.

## Acceptance Criteria For The Full Design

- A mailbox owner can see every tool an agent may use.
- A skill can request tools but cannot grant authority by itself.
- A built-in capability and an external MCP tool share the same policy path.
- EmailAgent and InvoiceAgent use the same tool catalog mechanism.
- MCP clients see no more authority than the web app grants.
- External MCP tools are discoverable without being enabled.
- High-risk tools require explicit owner or human approval.
- Tool results are bounded, sanitized, and source-linked.
- Prompts/resources are context, not side-effect authority.
- Audit records explain who invoked what, on which mailbox, through which
  surface, and with what result.
