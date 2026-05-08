# add-inbox-agent-tool-configuration

Phase 2 turns the runtime-only AgentProfile / ToolCapability foundation into a
product-facing per-inbox configuration flow.

Phase 1 proved that a verified human user can create multiple owned AI inboxes.
This change lets each inbox owner configure:

- the inbox's agent persona and model preference
- inbound auto-draft behavior
- enabled tools for agent and MCP surfaces
- safety behavior for prompt-injection scanning and draft verification

The implementation must stay on the current Cloudflare-native baseline: R2
mailbox settings as MVP control plane, MailboxDO for inbox-local state,
EmailAgent as the first agent executor, and the existing tool registry as the
single source of capability descriptors.
