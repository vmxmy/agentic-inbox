<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# email-panel

## Purpose
Internal building blocks for `app/components/EmailPanel.tsx`. Splits the large panel component into the header (sender / subject / actions), the toolbar (read/star/move/delete + reply menu), the dialogs (delete confirmation, move-to-folder picker), and the two body renderers — `SingleMessageView` (one email) and `ThreadMessage` (collapsible thread item).

## Key Files

| File | Description |
|------|-------------|
| `EmailPanelHeader.tsx` | Top of the panel — subject line, participant chips (`from`/`to`/`cc`), date, star toggle, close button |
| `EmailPanelToolbar.tsx` | Action row beneath the header — mark read/unread, star, move-to-folder trigger, delete trigger, reply / reply-all / forward menu (wired into `useUIStore.startCompose`) |
| `EmailPanelDialogs.tsx` | Confirmation dialogs (delete + move) implemented with Kumo `Dialog` — keeps modal state out of the parent panel |
| `SingleMessageView.tsx` | Renders one email — body via `EmailIframe`, attachments via `EmailAttachmentList`, plus the inline-image rewrite |
| `ThreadMessage.tsx` | One row inside a thread — collapsed snippet by default, expands to a full `SingleMessageView`. Manages its own expand/collapse state |

## For AI Agents

### Working In This Directory
- **Components here are private to `EmailPanel`.** Do not import them from routes or other top-level components — go through `EmailPanel.tsx`. Treating them as a public API would couple too many things to the panel's internal layout.
- **No TanStack Query calls in `ThreadMessage` body.** The thread query is fired once at the panel level and the per-message bodies are fetched inside `SingleMessageView` (or pre-loaded when the thread expands). Doing it again per row would N+1 the API.
- **Email body rendering must stay inside `EmailIframe`.** It sandboxes scripts and rewrites `cid:` references to attachment URLs. Replacing it with raw `dangerouslySetInnerHTML` is an XSS regression.
- **Reply / forward routing goes through `useUIStore.startCompose({ mode, originalEmail })`** — never instantiate `<ComposeEmail>` from here directly. The store keeps modal state coherent across keyboard shortcuts, mobile, and the split view.
- **Dialog state belongs in `EmailPanelDialogs.tsx`** so the parent panel doesn't accumulate `useState` for every confirmation. Trigger components pass `onConfirm` callbacks up.
- **Delete vs. trash semantics:** the API "delete" call moves to Trash for non-Trash folders and hard-deletes when called from Trash. The dialog copy must match the actual behaviour for the current folder — pass `currentFolderId` in.

### Testing Requirements
- Manual via the inbox UI:
  - Open a multi-message thread; verify each `ThreadMessage` collapses/expands independently.
  - Use reply / reply-all / forward and confirm `useComposeForm` receives the correct `composeOptions`.
  - Move-to-folder dialog must show only deletable + system folders (excluding `spam` per `SYSTEM_FOLDER_IDS` ordering).
  - Star toggle must invalidate the right query keys (`queryKeys.emails.detail`, `queryKeys.emails.list`).

### Common Patterns
- Default-exported component per file; sibling components are not re-exported via a barrel — import them by file path.
- Phosphor icons throughout, matching the rest of `app/components`.
- Keep visual changes minimal — coordinate with design before introducing new spacing / colour tokens (Kumo theme variables only).

## Dependencies

### Internal
- `~/components/EmailIframe`, `~/components/EmailAttachmentList`
- `~/hooks/useUIStore` — `startCompose`, `closePanel`
- `~/queries/emails` — mutations (`useStarEmail`, `useMarkRead`, `useMoveEmail`, `useDeleteEmail`)
- `~/lib/utils` — `rewriteInlineImages`, `getNonInlineAttachments`, `getSnippetText`
- `~/types` — `Email`, `Attachment`

### External
- `@cloudflare/kumo` (Dialog, Button, Tooltip)
- `@phosphor-icons/react`

<!-- MANUAL: -->
