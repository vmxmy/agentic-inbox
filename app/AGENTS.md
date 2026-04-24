<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# app

## Purpose
React Router v7 SSR application — the entire frontend SPA. Renders the inbox UI, mounts the AI agent side panel, and talks to the worker over `/api/v1/*`. Compiled by Vite via `@react-router/dev` and served from `workers/app.ts`.

## Key Files

| File | Description |
|------|-------------|
| `root.tsx` | App shell — `<Layout>` HTML scaffold, `QueryClientProvider` (per-request QueryClient on SSR, singleton in browser), `LinkProvider` adapting Kumo links to React Router, `ErrorBoundary`, `HydrateFallback` |
| `routes.ts` | Route table — `/`, `/mailbox/:mailboxId/{,emails/:folder,settings,search}`, `/invite/:token`, `/admin`, `*` 404 |
| `entry.server.tsx` | SSR entry — wraps `<ServerRouter>` in `renderToReadableStream`, blocks for bots so crawlers see fully rendered HTML |
| `index.css` | Global styles — Tailwind v4 directives plus `@cloudflare/kumo` theme imports |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `components/` | Top-level layout + view components (Header, Sidebar, EmailPanel, ComposeEmail, AgentPanel, etc.) (see `components/AGENTS.md`) |
| `hooks/` | Reusable React hooks — Zustand UI store, compose form state machine (see `hooks/AGENTS.md`) |
| `lib/` | Frontend-only utilities — DOMPurify-based HTML helpers, Gmail-style search parser (see `lib/AGENTS.md`) |
| `queries/` | TanStack Query hooks + centralised key factories (see `queries/AGENTS.md`) |
| `routes/` | React Router route modules (one file per URL pattern in `routes.ts`) (see `routes/AGENTS.md`) |
| `services/` | API client — typed wrappers around `fetch` with timeout + abort (see `services/AGENTS.md`) |
| `types/` | Frontend TypeScript interfaces — `Mailbox`, `Email`, `Folder`, `Attachment`, settings shapes (see `types/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **SSR is enabled.** Avoid `window`/`document` access at module top level; gate with `typeof window === "undefined"` or use `useEffect`. `app/lib/utils.ts:htmlToPlainText` is an example of a deliberately client-only helper.
- **The QueryClient must not leak across SSR requests.** `root.tsx` uses `useState(getQueryClient)` so each server request creates a fresh client; do not hoist a singleton into module scope.
- **Use centralised query keys.** `queries/keys.ts` is the source of truth for cache invalidation — adding a query without a key factory breaks `useQueryClient().invalidateQueries(...)` calls elsewhere.
- **Prefer `~/` path alias** (configured by `vite-tsconfig-paths`) for absolute imports, and `shared/` for cross-stack modules.
- **Do not bypass `DOMPurify`.** Any HTML originating from email bodies or user input flows through `app/lib/utils.ts:htmlToPlainText` / `escapeHtml` / `getSnippetText` before render.

### Testing Requirements
- Manual via `npm run dev` — the React Router dev server runs through Vite + Cloudflare's plugin, so SSR + worker bindings work locally.
- After UI changes, exercise both the split-pane (`MailboxSplitView`) and the per-email route (`/mailbox/:id/emails/:folder`) — they share components but mount differently.

### Common Patterns
- Default-exported route components (React Router contract); named exports for everything else.
- `useUIStore` (Zustand) holds ephemeral UI state — selected email, compose modal, sidebar open. Server data goes through TanStack Query, never Zustand.
- TipTap editor is encapsulated in `components/RichTextEditor.tsx`; do not import TipTap directly elsewhere.
- Kumo (`@cloudflare/kumo`) provides the design system — buttons, dialogs, tooltips, etc.

## Dependencies

### Internal
- `workers/index.ts` — backend API consumed via `app/services/api.ts`
- `shared/folders.ts`, `shared/dates.ts` — folder IDs and date formatting shared with the worker

### External
- `react`, `react-dom` 19; `react-router` 7
- `@tanstack/react-query` 5
- `@cloudflare/kumo` (UI kit), `@phosphor-icons/react`
- `@tiptap/*` 3.20.2 (overrides pinned in `package.json`)
- `zustand` 5
- `react-markdown` + `remark-gfm` (agent message rendering)
- `dompurify` (HTML sanitisation in `lib/utils.ts`)

<!-- MANUAL: -->
