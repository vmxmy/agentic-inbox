<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# hooks

## Purpose
Reusable React hooks for client-side state. Today this is two hooks:

1. **`useUIStore`** — a Zustand store for transient UI state (selected email, compose modal/panel options, sidebar/agent panel toggles).
2. **`useComposeForm`** — the compose-form state machine shared by `ComposeEmail` (modal) and `ComposePanel` (side panel), wrapping mutations from `~/queries/emails`.

## Key Files

| File | Description |
|------|-------------|
| `useUIStore.ts` | Zustand store: `selectedEmailId`, `_previousEmailId` (to restore selection after close), `composeOptions` (mode, original email, draft email), `isComposing`, `isSidebarOpen`, `isAgentPanelOpen`. Actions: `selectEmail`, `startCompose`, `closePanel`, `closeCompose`, sidebar/agent toggles. **Single source of UI state — do not duplicate.** |
| `useComposeForm.ts` | Compose form orchestration — initialises `to/cc/bcc/subject/body` from `composeOptions`, builds quoted reply blocks (`buildQuotedReplyBlock`), inserts the signature (`getSignatureBlock`), wires save-draft / send / forward / delete-draft mutations, and surfaces toasts via `useKumoToastManager` |

## For AI Agents

### Working In This Directory
- **All UI state goes through `useUIStore`.** If you find yourself reaching for `useState` inside a route to share state across siblings, lift it to the store instead.
- **Server state never lives here.** Email lists, mailboxes, threads — those are TanStack Query queries in `app/queries/`. Hooks in this directory are strictly client state.
- **`useComposeForm` must be the single integration point** between the compose UI and the email-mutation surface (`useSaveDraft`, `useSendEmail`, `useReplyToEmail`, `useForwardEmail`, `useDeleteEmail`). Component files should not call those mutations directly.
- Re-exporting hooks from a barrel file is **not** the convention — import from the specific file (`~/hooks/useUIStore`).
- Zustand store: prefer **action methods on the store** over external setters. The store exposes `selectEmail(id)`, `startCompose(options)`, etc., not raw `setState`.

### Testing Requirements
- Manual via `npm run dev` — verify:
  - Selecting an email updates the URL/panel and survives re-render.
  - Closing compose restores the previously selected email (the `_previousEmailId` field).
  - Reply mode prefills the recipient, prepends `Re:` when not present, and includes the quoted block.

### Common Patterns
- ComposeMode is a string literal union: `"new" | "reply" | "reply-all" | "forward"`.
- Hooks file naming: `useXxx.ts` (camelCase prefix); React enforces the `use*` rule.

## Dependencies

### Internal
- `~/types` (Email)
- `~/lib/utils` (HTML / quoting helpers)
- `~/queries/emails` (mutations)
- `~/queries/mailboxes` (settings for signature)

### External
- `zustand` 5
- `@cloudflare/kumo` (`useKumoToastManager`)
- `react`

<!-- MANUAL: -->
