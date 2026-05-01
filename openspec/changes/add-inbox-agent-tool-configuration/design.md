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
- Keep configuration choices backend-owned: model options, tool editability,
  default tool preset, safety defaults, and reset defaults all come from the
  Worker, not from hardcoded frontend policy.

**Non-Goals:**

- A full workflow builder.
- Agent marketplace / template library.
- External MCP server installation UI.
- Arbitrary user-provided tools.
- Ordinary-user automatic sending.
- Multi-tenant admin roles.
- Stable `inbox_id` migration.
- Legacy mailbox migration or legacy mailbox config writes.

## Decisions

### Decision: Add a dedicated user-owned config API instead of expanding raw mailbox update

Use product-facing endpoints such as:

```text
GET   /api/v1/inboxes/:mailboxId/agent-config
PATCH /api/v1/inboxes/:mailboxId/agent-config
GET   /api/v1/inbox-config/options
```

The exact route names can be adjusted during implementation, but the important
boundary is that the new endpoint accepts a constrained config shape rather than
an arbitrary `settings` object.

The structured config API is limited to Phase 1 user-owned inboxes. Legacy
mailboxes may still show their current display name and legacy prompt settings,
but the new Agent/Tools/Safety configuration flow must be read-only or hidden
for legacy records until an owner model exists for them.

Why: `PUT /api/v1/mailboxes/:mailboxId` exists for compatibility and legacy
settings. A structured endpoint is easier to validate, easier to document, and
less likely to accidentally let clients overwrite identity/routing fields.
Limiting writes to user-owned inboxes avoids turning the transitional legacy
mailbox model into a long-term authorization contract.

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

### Decision: Model selection is backend allowlist, not free text

The frontend should not provide a free-text model id field. The Worker should
return a small backend-owned model catalog with stable ids and user-facing
metadata, for example:

```json
{
  "models": [
    { "id": "glm-5.1", "displayName": "GLM 5.1", "tier": "default" },
    { "id": "@cf/moonshotai/kimi-k2.5", "displayName": "Kimi K2.5", "tier": "workers-ai" }
  ],
  "defaultModelId": "glm-5.1"
}
```

If an inbox already has a saved model id that is not in the current allowlist,
the read endpoint may return it as a non-editable or deprecated current value so
the UI can explain the state and let the user reset to a supported model.

Why: free text would push provider availability, billing tier, token limits, and
safety compatibility into an unvalidated string. The provider registry should be
flexible; the user input should be governed.

### Decision: Tool catalog and editability are backend-owned

The frontend should not hardcode the canonical tool list or decide which tools
are editable. It may provide local icons/grouping, but stable ids, descriptions,
surfaces, permission flags, editability, and lock reasons come from the backend
registry/config options.

Tool permission metadata should be rendered in human terms:

- reads inbox
- writes drafts / changes folders
- sends external email
- global / no inbox context
- elevated / system-only capability

This is necessary before we let users turn capabilities on or off.

### Decision: Send-mail tools are visible but locked in Phase 2

Tools that send external mail, such as `send_email` and `send_reply`, should be
visible as high-risk/elevated capabilities but not editable by ordinary users in
Phase 2. The backend should reject any config write that attempts to enable them
and return a stable lock reason such as `drafts_only_in_phase2`.

Why: hiding them makes the product feel arbitrary, but enabling them violates
this phase's product promise: the agent drafts, the human sends. It also risks
root-domain sending reputation if prompt injection or misconfiguration causes
unwanted outbound mail.

### Decision: Default user-facing tool preset should be explicit and safe

The legacy runtime currently treats empty `enabledToolIds` as “all built-ins” to
preserve compatibility. The configuration UI should not rely on that implicit
meaning. When a user saves configuration, it should write an explicit list.

Recommended initial product preset for ordinary inboxes:

- read email/thread
- search/list emails
- draft replies / draft new emails
- update/delete drafts
- move/mark read if needed

External send tools remain locked until a future product slice adds a clear
review/confirmation, quota, audit, and sender reputation model.

### Decision: Safety policy is explicit per inbox but defaults to safe-on

Add a settings-owned safety policy such as:

```json
{
  "agentSafety": {
    "version": 1,
    "promptInjectionScanEnabled": true,
    "threadContextScanEnabled": true,
    "draftVerificationEnabled": true,
    "safetyModelId": null,
    "level": "standard"
  }
}
```

The runtime should continue to fail safe by default: missing safety settings
mean scans and verification remain enabled.

Safety level and safety model choices should be backend-owned options, not free
frontend strings. A per-inbox `safetyModelId` is optional. If absent, the
existing env-level `LLM_SAFETY_MODEL` / `LLM_DEFAULT_MODEL` / Workers AI
fallback chain remains in effect.

### Decision: Config writes are versioned, optimistic, and auditable

Each saved config should include a schema version. Update requests should use a
revision or ETag-style precondition so two browser tabs do not silently overwrite
each other. The exact storage mechanism can be simple for R2 MVP, but the API
contract should include conflict detection.

Every successful config change should append a small audit entry containing at
least actor, inbox address/id, changed fields, timestamp, and a redacted old/new
summary. In this MVP the audit log can live in R2 next to mailbox settings, but
it must not depend on a future D1 migration.

### Decision: Config changes affect future runs, not in-flight runs

The simplest operational semantics are: a saved config applies to the next agent
run for that inbox. In-flight EmailAgent work is not interrupted or retroactively
changed. This avoids needing Durable Object invalidation/broadcast mechanics in
Phase 2.

### Decision: MCP can read config but cannot write it in Phase 2

If MCP exposes configuration at all in Phase 2, it should be read-only. Writes
remain through HTTP API routes protected by the normal user-owned inbox
authorization and UI warnings. This prevents MCP clients from bypassing the
product safety explanations around high-risk tools.

### Decision: Frontend should teach the user's mental model

Settings should be organized around product concepts, not internal classes:

- **Agent**: name, instructions, model, auto-draft toggle.
- **Tools**: what this inbox's agent may do.
- **Safety**: malicious-instruction detection and draft cleanup.

The UI should explain that these settings apply only to the current AI Inbox.
It should also include reset-to-defaults affordances backed by server-provided
defaults.

## Risks / Trade-offs

- **Risk: unsafe tool exposure.** Mitigation: backend catalog permission labels,
  explicit allow-list on save, and keep send tools locked server-side.
- **Risk: raw settings and config endpoint drift.** Mitigation: implement config
  assembly/merge in one helper and use compile verification.
- **Risk: user prompt breaks system safety rules.** Mitigation: keep invariant
  runtime guardrails outside user-editable prompt and retain safety scans.
- **Risk: model id drift.** Mitigation: backend-owned model options, deprecated
  current-value handling, and reset-to-defaults.
- **Risk: silent lost updates.** Mitigation: version/revision precondition on
  config writes.
- **Risk: no accountability for risky changes.** Mitigation: R2 audit log for
  config changes.
- **Risk: too much UI at once.** Mitigation: structured settings page only; no
  workflow builder or template marketplace in this slice.

## Migration Plan

- Existing mailboxes without `agentProfiles` or `agentSafety` load with default
  agent and safe-on safety policy.
- Existing `settings.agentSystemPrompt` remains readable as a legacy prompt
  override.
- First save through the new settings UI writes the structured config shape,
  schema version, explicit tool allow-list, and safety defaults.
- Legacy mailboxes do not receive new config writes in Phase 2; they remain on
  existing compatibility settings.
- No destructive R2 rewrite is required.

## Open Questions

- What initial backend model allowlist should ship for the current deployment?
- Should the audit log store field-level old/new values or only redacted change
  summaries for prompt/safety-sensitive fields?
- Should disabled/locked send tools appear in the UI by default, or only behind
  an “advanced capabilities” disclosure while still being returned by the API?
