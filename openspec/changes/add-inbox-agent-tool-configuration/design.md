## Context

Current code facts after Phase 1:

- `InboxProfile` is resolved from R2 mailbox settings in `workers/lib/inbox-profile.ts`.
- New user-owned inboxes already write `inboxProfile` and `userOwnedInbox`
  metadata into `mailboxes/<address>.json`.
- `AgentProfile` exists in `workers/lib/agent-profile.ts` and can read custom
  profiles from `settings.agentProfiles[profileId]`.
- `EmailAgent` already resolves `AgentProfile` before constructing model,
  prompt, and tools.
- The tool registry in `workers/lib/tool-capabilities.ts` already lists built-in
  capabilities and filters them by `InboxProfile.enabledToolIds` and
  `AgentProfile.enabledToolIds`.
- Safety model provider resolution exists in `workers/lib/llm-provider.ts`, but
  safety policy is currently implicit in `workers/agent/index.ts`.
- The current settings UI only exposes display name and a legacy
  `agentSystemPrompt` textarea.
- The current generic mailbox update route accepts a raw `settings` object, then
  protects server-owned `inboxProfile` identity/routing fields.

Therefore this change is not about inventing the runtime abstraction. It is
about safely exposing it as product configuration.

## Goals / Non-Goals

**Goals:**

- Provide a user-owned inbox configuration endpoint that is safer than raw
  mailbox settings update.
- Keep R2 mailbox settings as the MVP configuration store.
- Use the existing `AgentProfile` and tool registry as implementation targets.
- Make the frontend settings page understandable to ordinary users.
- Make tool permissions and safety behavior explicit.
- Preserve compatibility for legacy mailboxes and existing prompt override.

**Non-Goals:**

- A full workflow builder.
- Agent marketplace / template library.
- External MCP server installation UI.
- Arbitrary user-provided tools.
- Multi-tenant admin roles.
- Stable `inbox_id` migration.

## Decisions

### Decision: Add a dedicated config API instead of expanding raw mailbox update

Use product-facing endpoints such as:

```text
GET   /api/v1/inboxes/:mailboxId/agent-config
PATCH /api/v1/inboxes/:mailboxId/agent-config
GET   /api/v1/tools/catalog
```

The exact route names can be adjusted during implementation, but the important
boundary is that the new endpoint accepts a constrained config shape rather than
an arbitrary `settings` object.

Why: `PUT /api/v1/mailboxes/:mailboxId` exists for compatibility and legacy
settings. A structured endpoint is easier to validate, easier to document, and
less likely to accidentally let clients overwrite identity/routing fields.

### Decision: Store the default custom profile per inbox under `settings.agentProfiles`

For this MVP, each inbox gets one effective configurable profile. The storage
shape should reuse the current resolver:

```json
{
  "agentProfiles": {
    "default-email-agent": {
      "displayName": "Reimbursement Assistant",
      "description": "Drafts reimbursement replies",
      "systemPrompt": "...",
      "modelId": "glm-5.1",
      "automation": {
        "inboundAutoDraftEnabled": true
      },
      "enabledToolIds": ["get_email", "get_thread", "draft_reply"]
    }
  },
  "inboxProfile": {
    "agentProfileId": "default-email-agent",
    "enabledToolIds": ["get_email", "get_thread", "draft_reply"]
  }
}
```

This avoids introducing a separate global agent-profile store before we have
multiple reusable profiles.

### Decision: Tool catalog is backend-owned

The frontend should not hardcode the canonical tool list. It may provide local
icons/grouping, but stable ids, descriptions, surfaces, and permission flags
come from the backend registry.

Tool permission metadata should be rendered in human terms:

- reads inbox
- writes drafts / changes folders
- sends external email
- global / no inbox context

This is necessary before we let users turn capabilities on or off.

### Decision: Default user-facing tool preset should be safe

The legacy runtime currently treats empty `enabledToolIds` as “all built-ins” to
preserve compatibility. The configuration UI should not rely on that implicit
meaning. When a user saves configuration, it should write an explicit list.

Recommended initial product preset for ordinary inboxes:

- read email/thread
- search/list emails
- draft replies / draft new emails
- update/delete drafts
- move/mark read if needed

External send tools should remain disabled unless a later product decision adds
a clear review/confirmation model. This keeps the product promise aligned with
“agent drafts, human sends”.

### Decision: Safety policy is explicit per inbox but defaults to safe-on

Add a settings-owned safety policy such as:

```json
{
  "agentSafety": {
    "version": 1,
    "promptInjectionScanEnabled": true,
    "threadContextScanEnabled": true,
    "draftVerificationEnabled": true,
    "safetyModelId": null
  }
}
```

The runtime should continue to fail safe by default: missing safety settings
mean scans and verification remain enabled.

A per-inbox `safetyModelId` is optional. If absent, the existing env-level
`LLM_SAFETY_MODEL` / `LLM_DEFAULT_MODEL` / Workers AI fallback chain remains
in effect.

### Decision: Frontend should teach the user's mental model

Settings should be organized around product concepts, not internal classes:

- **Agent**: name, instructions, model, auto-draft toggle.
- **Tools**: what this inbox's agent may do.
- **Safety**: malicious-instruction detection and draft cleanup.

The UI should explain that these settings apply only to the current AI Inbox.

## Risks / Trade-offs

- **Risk: unsafe tool exposure.** Mitigation: backend catalog permission labels,
  explicit allow-list on save, and keep send tools disabled by default.
- **Risk: raw settings and config endpoint drift.** Mitigation: implement config
  assembly/merge in one helper and use compile verification.
- **Risk: user prompt breaks system safety rules.** Mitigation: keep invariant
  runtime guardrails outside user-editable prompt and retain safety scans.
- **Risk: too much UI at once.** Mitigation: structured settings page only; no
  workflow builder or template marketplace in this slice.

## Migration Plan

- Existing mailboxes without `agentProfiles` or `agentSafety` load with default
  agent and safe-on safety policy.
- Existing `settings.agentSystemPrompt` remains readable as a legacy prompt
  override.
- First save through the new settings UI writes the structured config shape.
- No destructive R2 rewrite is required.

## Open Questions

- Should model selection be a free text input in Phase 2, or a small server
  returned list containing the current default and custom value?
- Should non-owner legacy mailboxes expose this config UI, or should the new
  config endpoint be limited to user-owned inboxes first?
- Should send-mail tools be completely hidden in Phase 2 or visible as disabled
  advanced capabilities?
