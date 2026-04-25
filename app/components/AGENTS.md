<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# components

## Purpose
Top-level React components composing the inbox UI: layout (header, sidebar, split view), email reading (panel, iframe, attachment list), composing (compose dialog/panel + rich text editor), and the AI agent surface (sidebar trigger, chat panel, MCP info panel).

## Key Files

| File | Description |
|------|-------------|
| `Header.tsx` | Top app bar — mailbox switcher, search box, settings/admin/agent buttons |
| `Sidebar.tsx` | Left navigation — folder list (system + custom), unread counts, mobile drawer behaviour |
| `MailboxSplitView.tsx` | Two-pane layout combining `email-list` route with `EmailPanel` for desktop split view |
| `EmailPanel.tsx` | Side panel showing the selected email or thread — orchestrates `email-panel/*` subcomponents |
| `EmailIframe.tsx` | Sandboxed `<iframe>` rendering raw email HTML (with sanitisation + inline-image rewriting) |
| `EmailAttachmentList.tsx` | Renders the attachment row beneath an email; download button invokes `getAttachmentUrl` |
| `ComposeEmail.tsx` | Modal compose dialog (legacy / mobile path) — wraps `RichTextEditor` |
| `ComposePanel.tsx` | Side-panel compose surface used by the desktop split view |
| `RichTextEditor.tsx` | TipTap editor wrapper — toolbar, link/image extensions, paste handling. **Sole TipTap consumer** |
| `AgentSidebar.tsx` | Right-edge tabbed panel — "Chat" tab lazy-loads `UnifiedAgentPanel`, "MCP" tab shows `/mcp` endpoint info |
| `UnifiedAgentPanel.tsx` | Single chat surface routing to multiple agent DOs via `@`-mention. Holds two parallel `useAgent` connections (EmailAgent + InvoiceAgent), merges their messages by `createdAt`, renders bubbles via `agent-chat/MessageBubble`. The composer is `agent-chat/MentionAutocomplete`. Default routing target = last-used agent (sessionStorage), falling back to `email`. Email-specific draft action footer wired via `renderActions` |
| `MCPPanel.tsx` | Settings panel showing the `/mcp` endpoint URL with copy buttons (consumed by the Settings route) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `email-panel/` | Internal building blocks for `EmailPanel.tsx` — header, toolbar, dialogs, single-message view, thread message item (see `email-panel/AGENTS.md`) |
| `agent-chat/` | Shared chat-bubble + Markdown + tool-call rendering used by both `AgentPanel` and `InvoicePanel` (see `agent-chat/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **`UnifiedAgentPanel` is lazy-loaded** by `AgentSidebar`. The two `useAgent` connections (EmailAgent + InvoiceAgent) come up in parallel only after the user opens the agent panel — initial paint stays free of the AI SDK bundle.
- **Adding a new agent** = append to `app/components/agent-chat/agents.tsx:AGENTS` (label, icon, toolLabels, suggestedPrompts) + ensure the DO binding exists in `wrangler.jsonc`. The `@`-mention dropdown picks up the new entry automatically. Agent-specific UI extensions (e.g. email's draft action footer) live in `UnifiedAgentPanel` itself, branched by agent id.
- **Email HTML is dangerous.** Render bodies inside `EmailIframe` (sandboxed) or run them through `app/lib/utils.ts` helpers (`htmlToPlainText`, `getSnippetText`, `escapeHtml`). Do **not** set `dangerouslySetInnerHTML` directly with email bodies.
- **TipTap lives only in `RichTextEditor.tsx`.** All `@tiptap/*` imports are pinned to `3.20.2` via `package.json` overrides — do not bypass.
- **Compose state belongs in `useComposeForm`** (`app/hooks/useComposeForm.ts`). The two compose surfaces (`ComposeEmail`, `ComposePanel`) share that hook so behaviour stays consistent.
- **Selection + visibility are in `useUIStore`** (`app/hooks/useUIStore.ts`). Do not store transient UI state in TanStack Query or component-local `useState` if it needs to survive route changes.
- Imports from Kumo (`@cloudflare/kumo`) are preferred over hand-rolled buttons/dialogs/tooltips.

### Testing Requirements
- Manual exercise via `npm run dev`. Focus on:
  - Split view (`MailboxSplitView`) and the standalone email route both render the same panel.
  - Reply / forward populates `useComposeForm` correctly with quoted history.
  - Inline images inside `EmailIframe` resolve via `/api/v1/mailboxes/.../attachments/...`.
  - Agent panel handles tool-call streaming and reconnects WebSocket on tab focus.

### Common Patterns
- Default export per file for components used by routes; named export for helper components inside the same file.
- Phosphor Icons (`@phosphor-icons/react`) for iconography.
- Tailwind utility classes; avoid inline styles unless dynamically computed.

## Dependencies

### Internal
- `app/hooks/useUIStore.ts`, `app/hooks/useComposeForm.ts`
- `app/queries/*` for server data
- `app/lib/utils.ts` for HTML helpers
- `app/services/api.ts` indirectly via the query hooks

### External
- `@cloudflare/kumo` (Button, Dialog, Tooltip, Loader, Empty, Toasty, etc.)
- `@phosphor-icons/react`
- `@tiptap/react` + `@tiptap/starter-kit` (only in `RichTextEditor.tsx`)
- `react-markdown` + `remark-gfm` (only in `agent-chat/MessageBubble.tsx`)
- `dompurify` (only in `EmailIframe.tsx` paths)

<!-- MANUAL: -->
