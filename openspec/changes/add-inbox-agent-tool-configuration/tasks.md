## 0. Baseline Audit / IR

- [x] 0.1 Confirm current Phase 1 branch is merged into `codex/product-main`.
- [x] 0.2 Read current specs for multi-inbox, multi-agent, and tool capability runtime.
- [x] 0.3 Confirm current settings UI exposes only display name and legacy agent prompt.
- [x] 0.4 Confirm current backend has AgentProfile, ToolCapability registry, and safety model provider foundations.
- [ ] 0.5 Before implementation, re-check working tree is clean and no active OpenSpec conflicts exist.

## 1. Config Data Model

- [ ] 1.1 Define a constrained inbox agent config response/request shape.
- [ ] 1.2 Add helper to assemble config from `InboxProfile`, resolved `AgentProfile`, tool catalog, and safety defaults.
- [ ] 1.3 Add helper to merge validated config into existing R2 mailbox settings without changing server-owned routing fields.
- [ ] 1.4 Preserve legacy `agentSystemPrompt` read behavior.
- [ ] 1.5 Add compile/unit verification for defaults, partial updates, invalid tool ids, and server-owned field protection.

## 2. Backend API

- [ ] 2.1 Add `GET /api/v1/tools/catalog` or equivalent catalog endpoint backed by `listBuiltinCapabilities()`.
- [ ] 2.2 Add `GET /api/v1/inboxes/:mailboxId/agent-config` or equivalent inbox config read endpoint.
- [ ] 2.3 Add `PATCH /api/v1/inboxes/:mailboxId/agent-config` or equivalent constrained update endpoint.
- [ ] 2.4 Enforce ownership/visibility rules consistently with existing user-owned inbox access checks.
- [ ] 2.5 Return user-readable validation errors for invalid model, prompt, automation, safety, or tool config.

## 3. Runtime Enforcement

- [ ] 3.1 Ensure `resolveAgentProfile()` reads structured saved config and preserves default behavior for missing config.
- [ ] 3.2 Ensure `createAgentToolSet()` and MCP registration honor explicit saved tool allow-lists.
- [ ] 3.3 Add/extend safety policy resolver with safe-on defaults.
- [ ] 3.4 Gate prompt-injection scans, thread scans, and draft verification through resolved safety policy.
- [ ] 3.5 Ensure disabled inbound auto-draft persists an explanatory skipped note and does not invoke the model.

## 4. Frontend Settings UI

- [ ] 4.1 Replace the raw prompt-only settings experience with structured Agent, Tools, and Safety sections.
- [ ] 4.2 Load current config and tool catalog through typed API calls and TanStack Query keys.
- [ ] 4.3 Let users edit agent name/instructions/model preference and inbound auto-draft behavior.
- [ ] 4.4 Let users enable/disable tool capabilities with permission/risk labels.
- [ ] 4.5 Let users inspect safety defaults and configure allowed safety controls.
- [ ] 4.6 Save through the constrained config endpoint and show success/error toasts.
- [ ] 4.7 Preserve display name/email account settings behavior.

## 5. Verification

- [ ] 5.1 Run `openspec validate add-inbox-agent-tool-configuration --strict --no-interactive`.
- [ ] 5.2 Run `npm run typecheck`.
- [ ] 5.3 Run `npm run build`.
- [ ] 5.4 Browser E2E: open an owned inbox settings page, edit agent/tool/safety config, save, reload, and verify persistence.
- [ ] 5.5 Runtime E2E/manual: disable inbound auto-draft and verify a new inbound email does not invoke drafting.
- [ ] 5.6 Runtime/API check: disable a tool and verify agent/MCP availability reflects the saved policy.
