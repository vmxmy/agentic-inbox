<!-- Parent: ../AGENTS.md -->

# agent-chat

## Purpose
Shared building blocks for `UnifiedAgentPanel` and any future agent chat surface. Holds the per-agent registry (`agents.tsx`), the `@`-mention composer (`MentionAutocomplete.tsx`), and the generic chat bubble (`MessageBubble.tsx`).

## Key Files

| File | Description |
|------|-------------|
| `agents.tsx` | Hardcoded agent registry — one `AgentDef` per agent (id, DO `bindingName`, label, description, icon, toolLabels, suggestedPrompts). Exports `AGENTS` array, `AGENTS_BY_ID` lookup, `DEFAULT_AGENT_ID`, plus `readLastAgent` / `writeLastAgent` (sessionStorage). Adding an agent = append a record here + ensure the matching DO binding exists in `wrangler.jsonc`. |
| `MentionAutocomplete.tsx` | Composer with `@`-mention agent picker. Holds the dropdown / chip / textarea state. Chip is held by the **parent** (UnifiedAgentPanel) as `pendingAgent` and rendered as a separate DOM node — it's never written into the textarea text. Keyboard: `@` opens the dropdown, ↑↓ navigate, Enter / Tab select, Esc closes; Backspace at pos 0 with chip set clears the chip. |
| `MessageBubble.tsx` | Generic chat bubble — user / assistant layout, streaming Markdown via `react-markdown` + `remark-gfm`, tool-call badges via a per-agent `toolLabels: Record<string, { label, icon }>` map, and an optional `renderActions(message)` slot for draft-style action buttons. Also exports `getToolNameFromPart` (AI SDK v6 part-shape parser) so panels can reuse the same logic for per-message helpers like `hasDraftReplyTool`. |

## For AI Agents

### Working In This Directory
- **The agent registry is hardcoded client-side.** Future: promote to `GET /api/v1/agents` if a third agent appears and runtime updates without rebuild become valuable. Today the explicit list is simpler.
- **Per-agent specifics belong in `UnifiedAgentPanel` (the consumer)**, not here. `MessageBubble` knows nothing about email vs invoice; it just renders bubbles. Tool labels, suggested prompts, agent name all live in `agents.tsx`. Extension points for footer buttons (draft actions) live in `UnifiedAgentPanel` and branch by agent id.
- **`renderActions` is the extension point** for per-message UI (draft "Edit & send" button is the current consumer). Pass a closure that captures host state (e.g. `isStreaming`) so this module stays oblivious.
- **The Markdown component map is private.** It bakes in the tab/spacing conventions used by Workers AI output. If a future agent needs different rendering, parameterise instead of forking — having two parallel Markdown configs leads to drift.
- **Chip is parent state, not textarea text.** When `MentionAutocomplete` selects an agent, it updates `value` (strips `@filter`) and calls `onPendingAgentChange(id)`. The chip is rendered as a sibling span inside the textarea container. The parent (UnifiedAgentPanel) routes the message to the chip's agent on submit.

### Testing
- Manual exercise via `npm run dev` — open `/agents/...` chat through `UnifiedAgentPanel` (in `AgentSidebar`'s Chat tab) and confirm: tool badges per agent, `@`-mention dropdown filters by typed prefix, chip backspace clears, both agents stream concurrently if both are addressed in quick succession, sessionStorage records the last-used agent across sends.

## Dependencies

### Internal
- Consumed by `app/components/UnifiedAgentPanel.tsx`. The agent list is the source of truth for the `@`-mention dropdown.

### External
- `react-markdown`, `remark-gfm` — Markdown rendering (only `MessageBubble.tsx`)
- `@cloudflare/kumo` — `Loader`, `Button` (only `MentionAutocomplete.tsx`)
- `@phosphor-icons/react` — agent icons + tool icons + `XIcon` for chip dismiss
- `ai` (type only) — `UIMessage`

<!-- MANUAL: -->
