<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# routes

## Purpose
React Router v7 route modules. One file per URL pattern declared in `app/routes.ts`. Each module default-exports the route component (React Router contract); loaders/actions can be added via named exports as needed.

## Key Files

| File | URL | Purpose |
|------|-----|---------|
| `home.tsx` | `/` | Mailbox picker / first-run experience. Lists mailboxes the user has access to via `useMailboxes`, links into `/mailbox/:id` |
| `mailbox.tsx` | `/mailbox/:mailboxId` | Layout route for everything under a mailbox — renders header + sidebar + `<Outlet>` for child routes |
| `mailbox-index.tsx` | `/mailbox/:mailboxId` (index) | Default landing for a mailbox — typically redirects to the inbox folder |
| `email-list.tsx` | `/mailbox/:id/emails/:folder` | Folder view (Inbox, Sent, Drafts, Archive, Trash, custom). Hosts the split-pane via `MailboxSplitView` |
| `search-results.tsx` | `/mailbox/:id/search` | Renders parsed search results with highlighted match terms (`highlightTerms` helper) |
| `settings.tsx` | `/mailbox/:id/settings` | Per-mailbox settings — signature, auto-reply, agent system prompt + model picker, rules editor, ACL/members, MCP info |
| `invite.tsx` | `/invite/:token` | Accept-invite flow — POSTs to `/api/v1/invites/accept` and redirects into the granted mailbox |
| `admin.tsx` | `/admin` | Admin-only mailbox roster (gated by `isAdmin` on the API; the route still renders for non-admins but the API returns 403) |
| `not-found.tsx` | `*` | 404 catch-all — uses Kumo `Empty` component with a "Go Home" action |

## For AI Agents

### Working In This Directory
- **Routes are declared in `app/routes.ts`, not via filesystem convention.** When adding a route, edit `app/routes.ts` first, then create the module here.
- **Default export = the route component.** Named exports are reserved for React Router conventions (`loader`, `action`, `meta`, `links`, `clientLoader`, `clientAction`, `ErrorBoundary`).
- **Mailbox-scoped routes get `mailboxId` from `useParams`.** Use `useMailbox(mailboxId)` (or `useMailboxes` then find) to resolve the active mailbox object.
- **The settings route is the largest** and is currently being extended for ACL / agent-config / rules. Coordinate with `workers/lib/agent-config.ts` and `workers/lib/rules.ts` — the UI must keep the rule schema in sync.
- **`admin.tsx` and `invite.tsx` are recent additions** — they were untracked when this doc was generated. Treat them as work in progress; check git status before assuming the API surface is final.
- Avoid loaders for now — the codebase uses TanStack Query throughout for data fetching. Mixing loaders with React Query is possible but adds complexity; keep the pattern uniform unless there's a SEO/perf reason.

### Testing Requirements
- Manually exercise each route after changes. Pay particular attention to:
  - `mailbox.tsx` outlet — child routes must mount inside the layout, not full-screen.
  - `search-results.tsx` highlighting — the parser comes from `app/lib/search-parser.ts`.
  - `settings.tsx` rule editor — saving must round-trip through `/api/v1/mailboxes/:id` PUT and reload `useMailbox`.
  - `not-found.tsx` should render for any unknown path under `*`.

### Common Patterns
- React Router params via `useParams<{ mailboxId: string }>()`.
- Navigation via `useNavigate` or Kumo `<Link>` (which is adapted to React Router's link in `app/root.tsx:KumoLink`).
- Error UI bubbles up to `app/root.tsx:ErrorBoundary` via `isRouteErrorResponse`.

## Dependencies

### Internal
- `~/components/*` for layout pieces (Header, Sidebar, MailboxSplitView, EmailPanel, etc.)
- `~/queries/*` for data
- `~/hooks/*` for UI state

### External
- `react-router` 7

<!-- MANUAL: -->
