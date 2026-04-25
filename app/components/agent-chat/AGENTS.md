<!-- Parent: ../AGENTS.md -->

# agent-chat

## Purpose
Shared building blocks for the per-agent chat panels (`AgentPanel` for `EmailAgent`, `InvoicePanel` for `InvoiceAgent`). Extracted so the two panels stop duplicating ~150 lines of message-bubble + Markdown + tool-call rendering boilerplate.

## Key Files

| File | Description |
|------|-------------|
| `MessageBubble.tsx` | Generic chat bubble — user / assistant layout, streaming Markdown via `react-markdown` + `remark-gfm`, tool-call badges via a per-agent `toolLabels: Record<string, { label, icon }>` map, and an optional `renderActions(message)` slot for draft-style action buttons. Also exports `getToolNameFromPart` (AI SDK v6 part-shape parser) so panels can reuse the same logic for per-message helpers. |
| `agents.tsx` | Agent registry — `AgentDef` shape (id, bindingName, label, fullName, description, icon, toolLabels, suggestedPrompts, optional `renderActions`) and the `AGENTS` array (currently `email` + `invoice`). Single source of truth; `UnifiedAgentPanel` and `MentionAutocomplete` both consume from here. Includes `DEFAULT_AGENT_ID` and the sessionStorage key for the "last-used agent" memory. |
| `MentionAutocomplete.tsx` | Composer with `@`-mention dropdown + agent chip. Detects `@` at word boundaries, opens an anchored picker filtered by the typed query, ↑/↓/Enter/Tab keyboard navigation, click selection, ESC dismiss. On selection: strips the `@xyz` from the textarea and sets the chip prop. Backspace at cursor 0 clears the chip. Owned by parent (`UnifiedAgentPanel`) so chip state can reset after send. |

## For AI Agents

### Working In This Directory
- **Per-agent specifics belong in the calling panel.** This module knows nothing about email vs invoice — it just renders bubbles. Tool labels, suggested prompts, agent name, draft handling all stay in the panel files. Keep the boundary clean so adding a third agent later is a panel file plus a tool-labels map, nothing else.
- **`renderActions` is the extension point** for per-message UI (draft "Edit & send" button is the current consumer). Pass a closure that captures host state (e.g. `isStreaming`) so this module stays oblivious.
- **The Markdown component map is private.** It bakes in the tab/spacing conventions used by Workers AI output. If a future agent needs different rendering, parameterise instead of forking — having two parallel Markdown configs leads to drift.

### Testing
- Manual exercise via `npm run dev` — open both `/agents/email-agent/...` and `/agents/invoice-agent/...` chats and confirm tool badges, streaming text, code blocks, tables, and draft action buttons all render.

## Dependencies

### Internal
- Consumed by `app/components/AgentPanel.tsx` and `app/components/InvoicePanel.tsx`. Future agents (or the unified-panel work in the `@mention` UX) consume from here too.

### External
- `react-markdown`, `remark-gfm` — Markdown rendering
- `@cloudflare/kumo` — `Loader`
- `@phosphor-icons/react` — `CheckCircleIcon`, `UserIcon`, `WrenchIcon`
- `ai` (type only) — `UIMessage`

<!-- MANUAL: -->
