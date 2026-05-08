## 1. Shell and route scaffold

- [x] 1.1 Verify `disabledAt` column exists in `workers/db/team-schema.ts`; if absent, add migration
- [x] 1.2 Create `app/routes/admin.tsx` as layout shell with persistent left sidebar and `<Outlet />`
- [x] 1.3 Register nested admin routes in `app/routes.ts`: `_index`, `teams`, `team-users`, `mailboxes`, `users`, `llm-providers`
- [x] 1.4 Implement sidebar nav items (Overview, Teams, Team Users, Mailboxes, Users, LLM Providers) with active-state highlighting via `location.pathname`
- [x] 1.5 Create `app/routes/admin._index.tsx` (Overview): metric cards (team count, mailbox count, ownerless count), warning callout, links to sub-routes

## 2. Section migration (existing functionality)

- [x] 2.1 Extract `TeamsCard` (create form + team list) from `app/routes/admin.tsx` into `app/routes/admin.teams.tsx`
- [x] 2.2 Extract `TeamUsersCard` (create form + setup link + user table) into `app/routes/admin.team-users.tsx`; preserve team selection state via URL `?teamId=`
- [x] 2.3 Extract `MailboxDirectoryCard` (table with Open button) into `app/routes/admin.mailboxes.tsx`
- [x] 2.4 Ensure all three migrated sections preserve existing query keys, mutations, and toast behavior from original `admin.tsx`
- [x] 2.5 Remove migrated code from `app/routes/admin.tsx` (it should now only render `<Outlet />` + sidebar)
- [x] 2.6 Add mobile overview cards: on mobile viewport (`md:hidden`), show clickable cards in Overview linking to each sub-route

## 3. LLM Providers migration from Settings

- [x] 3.1 Extract `LlmProvidersCard` and `LlmProviderForm` from `app/routes/settings.tsx` into `app/components/admin/llm-providers/` (or keep in route file)
- [x] 3.2 Create `app/routes/admin.llm-providers.tsx` consuming the extracted components
- [x] 3.3 Remove `LlmProvidersCard` and `LlmProviderForm` code from `app/routes/settings.tsx`
- [x] 3.4 Remove `{ id: "system", ... }` entry from `SETTINGS_TABS` in `app/routes/settings.tsx:51-58`
- [x] 3.5 Remove conditional render `{activeTab === "system" && ...}` at `app/routes/settings.tsx:747-748`
- [x] 3.6 Verify `api.adminListLlmProviders` and related methods still resolve correctly from the new route

## 4. Backend endpoints

- [x] 4.1 Add `PUT /api/v1/admin/teams/:id` handler in `workers/index.ts`: validate body with Zod partial schema (`displayName?: string`, `disabled?: boolean`); toggle `disabledAt` timestamp; return updated team
- [x] 4.2 Add `PUT /api/v1/admin/teams/:teamId/users/:userId` handler in `workers/index.ts`: validate `{ disabled?: boolean }`; toggle `disabledAt`; return updated team user
- [x] 4.3 Add `POST /api/v1/admin/teams/:teamId/users/:userId/setup-link` handler in `workers/index.ts`: generate fresh `setupUrl` + `setupExpiresAt` using same token generation as create-user endpoint
- [x] 4.4 Add `api.adminUpdateTeam` method in `app/services/api.ts`
- [x] 4.5 Add `api.adminUpdateTeamUser` method in `app/services/api.ts`
- [x] 4.6 Add `api.adminReissueSetupLink` method in `app/services/api.ts`

## 5. Query layer

- [x] 5.1 Add `adminUsers: ["admin", "users"] as const` to `app/queries/keys.ts`
- [x] 5.2 Add `useUpdateTeam` mutation in `app/queries/teams.ts` (invalidates `adminTeams` and `adminMailboxes` on success)
- [x] 5.3 Add `useUpdateTeamUser` mutation in `app/queries/teams.ts` (invalidates `adminTeamUsers(teamId)`)
- [x] 5.4 Add `useReissueSetupLink` mutation in `app/queries/teams.ts` (invalidates `adminTeamUsers(teamId)`)
- [x] 5.5 Create `app/queries/users.ts` with `useAdminUsers` query (uses `GET /api/v1/admin/users`) and `useUpdateUserRole` mutation (uses `POST /api/v1/admin/users/:id/role`, invalidates `adminUsers`)

## 6. Capability gaps (disable, reassign, re-issue)

- [x] 6.1 Add disable/enable toggle button to each team row in `admin.teams.tsx`; wire to `useUpdateTeam`
- [x] 6.2 Add disabled-state visual treatment (badge or opacity) to team rows with `disabledAt` set
- [x] 6.3 Add disable/enable toggle button to each team user row in `admin.team-users.tsx`; wire to `useUpdateTeamUser`
- [x] 6.4 Add "Re-send setup link" button to each team user row; wire to `useReissueSetupLink`; show inline URL with Copy button
- [x] 6.5 Create `admin.users.tsx`: user list table with columns (email, displayName, role badge, emailVerifiedAt, createdAt) and promote/demote role action buttons
- [x] 6.6 Add search input and kind filter (legacy / team / team_user / ownerless) to `admin.mailboxes.tsx`
- [x] 6.7 Add "Reassign owner" button to ownerless legacy mailbox rows; open modal/prompt for email; call `api.adminAssignMailboxOwner` (already exists)
- [x] 6.8 Wire Mailbox Directory filter state to URL query params (`?search=...&kind=...`) so filtered views are shareable

## 7. Verification

- [x] 7.1 TypeScript check: `npx tsc --noEmit` passes with zero errors
- [x] 7.2 Build check: `npm run build` exits 0
- [x] 7.3 Test new backend endpoints (integration tests or manual curl)
- [x] 7.4 Verify admin gate: non-admin user navigating to `/admin/*` sees access denied message
- [x] 7.5 Verify mobile: sidebar hidden on narrow viewport, overview cards link to sub-routes
- [x] 7.6 Verify deep linking: `/admin/mailboxes?search=fin&kind=legacy` loads with filters applied
- [x] 7.7 Verify settings page no longer shows System tab; admin user sees Account, Agents, Rules, Members, Connections only
- [x] 7.8 Verify LLM Providers functionality preserved after migration (create, edit, test, delete still work)
