## Why

The Admin dashboard (`app/routes/admin.tsx`) is a single-file single-route page that conflates all admin operations into one monolithic 421-line component. All admin sections (Teams, Team Users, Mailbox Directory) live in one route, making it impossible to bookmark or deep-link to a specific section. Admin capabilities are further fragmented: LLM Provider management lives inside `app/routes/settings.tsx` as an admin-only "System" tab, and several backend-admin endpoints (list all users, reassign legacy mailbox owner) have no UI surface at all. This scatters admin operations across two files with no clear information architecture and prevents adding new admin features cleanly.

## What Changes

- Refactor `/admin` into a nested layout (`app/routes/admin.tsx` as layout shell + sub-routes) with a persistent left sidebar navigation (GitHub Settings style).
- Create 6 sub-routes under `/admin`: **Overview**, **Teams**, **Team Users**, **Mailbox Directory**, **Users**, **LLM Providers**.
- Move `LlmProvidersCard` and `LlmProviderForm` from `app/routes/settings.tsx` into `/admin/llm-providers`.
- **BREAKING**: Remove the "System" tab from Settings page (`app/routes/settings.tsx`). Admins must use `/admin/llm-providers` instead.
- Add missing admin UI surfaces for existing backend APIs: user role management, legacy mailbox owner reassignment, team/user disable toggle, setup link re-issue.
- Add 3 new backend endpoints: `PUT /api/v1/admin/teams/:id`, `PUT /api/v1/admin/teams/:teamId/users/:userId`, `POST /api/v1/admin/teams/:teamId/users/:userId/setup-link`.
- Mobile strategy: sidebar hidden on mobile (`md:hidden`), `/admin` overview shows navigation cards; sub-routes are desktop-only.
- Strict adherence to existing `@cloudflare/kumo` design system; no new dependencies.

## Capabilities

### New Capabilities
- `admin-console`: Unified multi-route admin interface for managing teams, team users, mailbox directory, global users, and LLM provider registry.

### Modified Capabilities
- *(none — no existing spec-level requirements are changing; this is a UI reorganization and capability-gap fill, not a behavioral change to existing capabilities.)*

## Impact

- `app/routes/admin.tsx` — becomes layout shell; existing component logic splits into sub-route files.
- `app/routes/settings.tsx` — System tab and `LlmProvidersCard`/`LlmProviderForm` removed.
- `app/routes.ts` — add nested admin sub-routes.
- `app/services/api.ts` — 3 new admin endpoint methods.
- `app/queries/teams.ts` — new mutations for disable/edit/setup-link.
- `app/queries/keys.ts` — add `adminUsers` key.
- `app/queries/users.ts` *(new)* — query hooks for admin user list and role mutation.
- `workers/index.ts` — 3 new backend route handlers.
- `workers/db/team-schema.ts` — verify `disabledAt` column (already in schema).
- No new npm dependencies.
