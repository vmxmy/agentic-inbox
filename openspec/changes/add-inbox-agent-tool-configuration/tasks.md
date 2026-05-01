## 0. Baseline Audit / IR

- [x] 0.1 Confirm current Phase 1 branch is merged into `codex/product-main`.
- [x] 0.2 Read current specs for multi-inbox, multi-agent, and tool capability runtime.
- [x] 0.3 Confirm current settings UI exposes only display name and legacy agent prompt.
- [x] 0.4 Confirm current backend has AgentProfile, ToolCapability registry, and safety model provider foundations.
- [x] 0.5 Ask Claude for independent review of Phase 2 product/design questions and capture artifact.
- [x] 0.6 Before implementation, re-check working tree is clean and no active OpenSpec conflicts exist.

## 1. Config Data Model

- [x] 1.1 Define a constrained user-owned inbox agent config response/request shape with schema version and revision/ETag.
- [x] 1.2 Add helper to assemble config from `InboxProfile`, resolved `AgentProfile`, model options, tool catalog, safety defaults, and reset defaults.
- [x] 1.3 Add helper to merge validated config into existing R2 mailbox settings without changing server-owned routing fields.
- [x] 1.4 Preserve legacy `agentSystemPrompt` read behavior while writing structured config on first save.
- [x] 1.5 Add backend-owned model options and reject unsupported model ids except for read-only deprecated current values.
- [x] 1.6 Add backend-owned safety options/defaults and safe-on resolver behavior.
- [x] 1.7 Add config audit entry shape and R2 persistence helper for successful config changes.
- [x] 1.8 Add compile/unit verification for defaults, partial updates, invalid tool ids, locked send tools, unsupported models, revision conflicts, and server-owned field protection.

## 2. Backend API

- [x] 2.1 Add `GET /api/v1/inbox-config/options` or equivalent options endpoint for models, tool catalog, safety defaults, and reset defaults.
- [x] 2.2 Add `GET /api/v1/inboxes/:mailboxId/agent-config` or equivalent user-owned inbox config read endpoint.
- [x] 2.3 Add `PATCH /api/v1/inboxes/:mailboxId/agent-config` or equivalent constrained update endpoint with revision/ETag conflict handling.
- [x] 2.4 Enforce ownership rules and reject structured config writes for legacy/non-user-owned mailboxes in Phase 2.
- [x] 2.5 Return user-readable validation errors for invalid model, prompt, automation, safety, locked tool, or tool config.
- [x] 2.6 Ensure MCP config exposure, if added, is read-only in Phase 2.

## 3. Runtime Enforcement

- [x] 3.1 Ensure `resolveAgentProfile()` reads structured saved config and preserves default behavior for missing config.
- [x] 3.2 Ensure `createAgentToolSet()` and MCP registration honor explicit saved tool allow-lists.
- [x] 3.3 Add/extend safety policy resolver with safe-on defaults and backend-owned safety levels.
- [x] 3.4 Gate prompt-injection scans, thread scans, and draft verification through resolved safety policy.
- [x] 3.5 Ensure disabled inbound auto-draft persists an explanatory skipped note and does not invoke the model.
- [x] 3.6 Ensure send-mail tools remain unavailable to ordinary user-owned inbox configs even if submitted by the client.
- [x] 3.7 Document/enforce config effective-time semantics: saved changes apply to future agent runs, not in-flight runs.

## 4. Frontend Settings UI

- [x] 4.1 Replace the raw prompt-only settings experience for user-owned inboxes with structured Agent, Tools, and Safety sections.
- [x] 4.2 Load current config and backend options through typed API calls and TanStack Query keys.
- [x] 4.3 Let users edit agent name/instructions/model preference using backend-provided model options, not free text.
- [x] 4.4 Let users toggle inbound auto-draft behavior.
- [x] 4.5 Let users enable/disable editable tool capabilities with permission/risk labels.
- [x] 4.6 Show send-mail/elevated tools as locked or disabled with backend-provided lock reasons.
- [x] 4.7 Let users inspect safety defaults and configure allowed safety controls.
- [x] 4.8 Provide reset-to-default affordances backed by server-provided defaults.
- [x] 4.9 Save through the constrained config endpoint, include revision/ETag, and show conflict/success/error toasts.
- [x] 4.10 Preserve display name/email account settings behavior.
- [x] 4.11 Render legacy mailbox config as compatible/read-only for the new Agent/Tools/Safety flow.

## 5. Verification

- [x] 5.1 Run `openspec validate add-inbox-agent-tool-configuration --strict --no-interactive`.
- [x] 5.2 Run `npm run typecheck`.
- [x] 5.3 Run `npm run build`.
- [x] 5.4 Browser E2E: open an owned inbox settings page, edit agent/tool/safety config, save, reload, and verify persistence.
- [x] 5.5 Browser/API E2E: verify unsupported/locked send tools cannot be enabled.
- [x] 5.6 Browser/API E2E: verify stale revision conflict handling.
- [x] 5.7 Runtime E2E/manual: disable inbound auto-draft and verify a new inbound email does not invoke drafting.
- [x] 5.8 Runtime/API check: disable a tool and verify agent/MCP availability reflects the saved policy.
- [x] 5.9 API check: verify legacy mailbox structured config write is rejected or read-only.
- [x] 5.10 Audit check: verify a successful config change appends an audit record.
