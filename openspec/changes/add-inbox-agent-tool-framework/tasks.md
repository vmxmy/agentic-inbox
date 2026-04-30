## 0. Agent Execution Guardrails

- [x] 0.1 Target the official baseline worktree at `.worktrees/cloudflare-official-build` for implementation work unless explicitly redirected.
- [x] 0.2 For Phase 1, allow writes only to `workers/lib/inbox-profile.ts`, `workers/lib/mailbox.ts`, `workers/index.ts`, `workers/mcp/index.ts`, and optionally `app/types/index.ts`.
- [x] 0.3 Do not change Durable Object schema, MailboxDO identity strategy, attachment storage paths, Cloudflare bindings, D1/auth/tenant code, user-owned address creation, Router Agent, AgentProfile runtime, ToolCapability registry, or agent/tool configuration UI in Phase 1.
- [x] 0.4 Preserve the invariant that R2 mailbox settings remain under `mailboxes/<email>.json`.
- [x] 0.5 Preserve compatibility for existing mailbox settings that do not contain `inboxProfile`.
- [x] 0.6 Preserve compatibility for existing API response shapes consumed by the current frontend.
- [x] 0.7 Ensure unknown inbound recipients do not auto-create inboxes.
- [x] 0.8 Ensure mailbox settings updates do not delete an existing `inboxProfile` when older clients submit settings without that field.
- [x] 0.9 Stop and ask for review if Phase 1 appears to require MailboxDO schema changes, broad unrelated refactors, MCP API shape changes, or changes outside the allowed write scope.

## 1. Baseline Review

- [x] 1.1 Confirm the implementation target is the official-source-compatible runtime path, not the fork-only D1/auth/invoice architecture.
- [x] 1.2 Map current mailbox settings load/save code and identify the smallest adapter point for `InboxProfile`.
- [x] 1.3 Map current `EmailAgent` tool construction and `EmailMCP` tool listing/execution paths.
- [x] 1.4 Record any official-baseline behavior that must remain unchanged before refactoring.

## 2. Inbox Runtime

- [x] 2.1 Define `InboxProfile` and related lifecycle/default types in a shared worker module.
- [x] 2.2 Implement a profile loader that adapts existing mailbox settings into `InboxProfile`.
- [x] 2.3 Add defaulting behavior for legacy settings that do not contain profile metadata.
- [x] 2.4 Add inbound recipient resolution that returns an `InboxProfile` before mailbox storage or agent automation.
- [x] 2.5 Ensure unknown inbound recipients do not implicitly create inbox profiles.
- [x] 2.6 Preserve existing `MailboxDO` read/write identity for this change.

## 3. Agent Runtime

- [x] 3.1 Define `AgentProfile`, automation policy, and enabled tool identifier types.
- [x] 3.2 Implement the default email agent profile equivalent to current behavior.
- [x] 3.3 Resolve the effective agent profile from the inbox profile before agent execution.
- [x] 3.4 Update `EmailAgent` to receive resolved profile behavior instead of hardcoding all behavior internally.
- [x] 3.5 Ensure inboxes without custom profile metadata continue to use the default email agent behavior.

## 4. Tool Capability Framework

- [ ] 4.1 Define `ToolCapability`, tool surface identifiers, permission metadata, and `ToolExecutionContext`.
- [ ] 4.2 Implement a built-in tool registry with lookup and filtering helpers.
- [ ] 4.3 Register existing email agent operations as built-in tool capabilities.
- [ ] 4.4 Filter agent tools by inbox profile, effective agent profile, and `agent` surface.
- [ ] 4.5 Filter MCP tools by inbox profile, effective agent profile, and `mcp` surface.
- [ ] 4.6 Reject execution attempts for unregistered, disabled, or surface-incompatible tools.
- [ ] 4.7 Ensure tool executors use `ToolExecutionContext` for inbox and environment access.

## 5. Integration

- [ ] 5.1 Update inbound email handling to pass resolved inbox and agent profiles into automation.
- [x] 5.2 Update UI/API mailbox operations only as needed to preserve existing behavior through the inbox profile adapter.
- [ ] 5.3 Update MCP listing and execution to use the shared registry instead of a separate tool definition path.
- [ ] 5.4 Keep this change free of required D1 migrations, organization tenancy, billing, custom domains, and domain-specific agents.

## 6. Verification

- [ ] 6.1 Add tests or type-level checks for legacy settings to `InboxProfile` defaulting.
- [ ] 6.2 Add tests for known and unknown inbound recipient resolution.
- [x] 6.3 Add tests for default and custom `AgentProfile` resolution.
- [ ] 6.4 Add tests for tool filtering by agent surface, MCP surface, enabled tools, and unregistered tool ids.
- [ ] 6.5 Verify the default email agent can still perform existing email operations.
- [ ] 6.6 Verify MCP does not list or execute tools that are disabled or not declared for MCP.
- [ ] 6.7 Run `npm run typecheck`.
- [ ] 6.8 Run `npm run build`.
