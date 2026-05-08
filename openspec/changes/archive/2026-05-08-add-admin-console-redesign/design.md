## Context

Currently the Admin dashboard is a single 421-line route at `app/routes/admin.tsx`. All three sections (Teams, Team Users, Mailbox Directory) are rendered in one flat page. URLs cannot deep-link to a specific section, and adding new admin features makes the file grow linearly. Separately, LLM Provider management (`LlmProvidersCard` + `LlmProviderForm`, ~300 lines in `settings.tsx`) is hidden behind a Settings tab that non-admin users cannot see, fragmenting admin operations across two files.

The React Router 7 stack (`react-router.config.ts` at the repo root) supports nested layouts via file convention (`app/routes/admin.tsx` as layout + `app/routes/admin._index.tsx`, `app/routes/admin.teams.tsx`, etc.), so a multi-route refactor is idiomatic and cheap.

The codebase already uses `@cloudflare/kumo` (Button, Badge, Input, Loader, Toast), Tailwind CSS 4 utility tokens, and TanStack Query for server state. We will stay strictly within these existing patterns.

## Goals / Non-Goals

**Goals:**
- Unify all admin UI surfaces in one deep-linkable, multi-route console.
- Support 6 sections: Overview, Teams, Team Users, Mailbox Directory, Users, LLM Providers.
- Maintain zero loss of existing admin functionality (create team, create user, list mailboxes, etc.).
- Close capability gaps: legacy mailbox owner reassignment, user role management, team/user disable toggle, setup link re-issue.
- Keep file sizes under 500 lines per route file (extracting inline forms into small helper components where needed).

**Non-Goals:**
- Visual redesign beyond moving components into the new layout.
- Mobile-optimized sub-routes (desktop-only experience).
- Exposing one-shot maintenance endpoints (`mailbox-directory/backfill`, `rules/backfill`) in the UI.
- Adding audit logs or activity history.
- Changing existing API behavior (only additive backend endpoints).

## Decisions

### 1. Layout: GitHub-Settings-style persistent left sidebar + nested routes
**Rationale**: Gives admins bookmarkable URLs per section, matches mental model of other admin tools (Cloudflare, Vercel, GitHub), and React Router 7 file-based routing makes this trivial (one layout file + one file per route). The sidebar is a lightweight component using flexbox and kumo NavList or plain `<a>` tags with Tailwind utilities; no new dependencies.

**Alternatives considered**:
- Tab bar within a single route: no deep links, still single file.
- Floating action buttons / command palette: less discoverable for non-technical admin users.

### 2. Route structure: flat sibling routes under `app/routes/`
```
app/routes/admin.tsx          ← layout shell (sidebar + <Outlet>)
app/routes/admin._index.tsx   ← Overview
app/routes/admin.teams.tsx    ← Teams
app/routes/admin.team-users.tsx          ← Team Users (with ?teamId= filter)
app/routes/admin.mailboxes.tsx           ← Mailbox Directory
app/routes/admin.users.tsx               ← Users
app/routes/admin.llm-providers.tsx       ← LLM Providers
```
**Rationale**: Flat sibling routes (instead of `teams.$teamId.users.tsx` nesting) keep each file self-contained. Team-user filtering uses a query param (`?teamId=xxx`) because the team list already lives in Teams tab and duplicating it would fragment state. `/admin/team-users` defaults to the last selected team or prompts the admin to choose.

### 3. Query param persistence for Mailbox Directory filters
Mailbox Directory search + kind filters (legacy / team / team_user / ownerless) round-trip through URL query params (`?search=&kind=legacy&ownerless=true`). This makes filtered views shareable and eliminates local UI state that would be lost on reload.

### 4. Soft-delete via `disabledAt` timestamp (not boolean column)
Teams and TeamUsers already have `disabledAt: number | null` in the schema. We toggle by writing/clearing this timestamp. This preserves history and is trivial to add to the existing data model.

### 5. Delete `settings/system` tab outright (no redirect, no dual-source)
**Rationale**: The System tab only contains LLM Providers today. Once the LLM Providers route exists in Admin, the old tab is purely dead UI. Keeping it as a redirect adds tech debt. The existing `ShieldIcon` button in `Header.tsx` already navigates to `/admin`, so admin workflow is not broken.

### 6. Three new backend endpoints (additive only)
- `PUT /api/v1/admin/teams/:id` — partial update (displayName + disabledAt)
- `PUT /api/v1/admin/teams/:teamId/users/:userId` — toggle disabledAt
- `POST /api/v1/admin/teams/:teamId/users/:userId/setup-link` — re-issue one-time setup token
These mirror the exact request/response shapes already used by `POST /api/v1/admin/teams/:teamId/users`.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Moving ~300 lines of LLM Provider UI from settings.tsx without regressions | Extract `LlmProvidersCard` and `LlmProviderForm` into `app/components/admin/` first (leave in settings temporarily), validate tests pass, then cut over. |
| `disabledAt` field not actually in DB schema (only in types) | Verify `workers/db/team-schema.ts` in Task 1; if absent, add migration in Task 1 before any UI references it. |
| Users section (`/admin/users`) lists ALL users, which could be large | Backend already paginates via `listUsers`; if >50 users, add pagination (cursor or offset) in a follow-up. First slice uses full list since current user base is small. |
| Mailbox Directory lists ALL mailboxes the admin can see | Uses `listUserMailboxes(c.env, user)` which is already the authoritative enumeration. If list grows >100, add server-side pagination in a follow-up. |
| PR is large if done all at once | Task list is ordered to support 1–4 PRs (shell first, sections next, capability gaps last). |

## Migration Plan

1. **Task 1 (layout shell + Teams/TeamUsers/MailboxDirectory migration)**: `app/routes/admin.tsx` becomes layout. Sub-route files created. Existing functionality extracted without loss. No backend changes. Can deploy immediately.
2. **Task 2 (LLM Providers migration + delete settings/system)**: Move components, remove tab. Deploy.
3. **Task 3 (Users + backend endpoints)**: New route + 3 new backend endpoints. Deploy.
4. **Task 4 (capability gaps)**: Disable toggles, reassign owner, re-issue setup link, Mailbox Directory filters. Deploy.

Rollback: each step is additive. Rolling back any single PR removes a sub-route or reverts a settings tab removal, but does not break existing data.

## Open Questions

- Should `disabledAt` be surfaced as a visual badge (e.g., "Disabled" pill) in the Teams list, or only via the edit detail view? Recommendation: badge in list for immediate visibility.
- Should the Mailbox Directory search be client-side (filter loaded array) or server-side (`?search=` query param)? Recommendation: client-side for now (total count typically <200), switch to server-side when needed.
