## Why

The official Cloudflare Agentic Inbox baseline embeds mailbox, agent, and tool
behavior in a compact demo structure. To evolve it into a flexible AI Inbox
platform, we need explicit runtime seams for multiple inboxes, configurable
agent behavior, and governed tool capabilities before adding heavier product
features such as multi-tenant administration or domain-specific agents.

This change creates that foundation while staying close to the official source:
it preserves Cloudflare Workers, Email Routing, Durable Objects, R2, Agents SDK,
and MCP, and avoids importing the current fork's broader D1/auth/domain-specific
architecture in one step.

## What Changes

- Add an `InboxProfile` runtime abstraction over the existing mailbox/settings
  model.
- Resolve inbound recipients and UI/API mailbox operations through inbox
  profiles before invoking mailbox storage or agent automation.
- Add an `AgentProfile` abstraction so each inbox can select or inherit agent
  behavior such as prompt, model, automation policy, and enabled tools.
- Add a `ToolCapability` registry with explicit identity, schemas, execution
  context, supported surfaces, and permission metadata.
- Refactor existing email tools into registered capabilities discovered by the
  agent and MCP adapters.
- Filter available tools by inbox profile, agent profile, and surface.
- Preserve the official baseline's `MailboxDO`, `EmailAgent`, `EmailMCP`, R2
  settings, and email-address-based mailbox identity as transitional
  implementation details.
- Defer user-owned address creation, full organization tenancy, billing,
  operations dashboards, custom domains, and domain-specific agent templates.

## Capabilities

### New Capabilities

- `multi-inbox-runtime`: Defines inbox profiles, address resolution, and
  official-baseline-compatible multi-inbox runtime behavior.
- `multi-agent-runtime`: Defines configurable agent profiles and per-inbox
  agent behavior resolution.
- `tool-capability-framework`: Defines tool registration, surface filtering,
  execution context, and governed tool availability.

### Modified Capabilities

- None. There are no existing archived OpenSpec capabilities yet.

## Impact

- Affected worker/runtime:
  - `workers/app.ts`
  - `workers/index.ts`
  - mailbox settings/profile loading code
  - inbound email recipient resolution
  - agent invocation path
- Affected agent/MCP code:
  - `EmailAgent` tool construction
  - `EmailMCP` tool listing and execution
  - shared tool helper modules
- Affected data:
  - additive inbox profile fields in existing mailbox settings or a compatible
    sidecar settings record
  - additive agent profile and enabled tool metadata
- Affected tests/verification:
  - inbox profile loading and fallback behavior
  - inbound recipient resolution
  - agent profile default/custom behavior
  - tool registry filtering by inbox, agent, and surface
  - current email agent behavior regression checks
- Cloudflare constraints:
  - no per-inbox Cloudflare Email Routing rules
  - no non-Cloudflare mail infrastructure
  - Durable Objects remain the inbox-local state boundary
  - R2 remains acceptable for official-baseline profile/settings persistence in
    this change
