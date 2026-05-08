## ADDED Requirements

### Requirement: Admin layout shell renders sidebar and outlet
The system SHALL render a persistent left sidebar on the `/admin` route layout. The sidebar SHALL list all 6 sections with links. The content area SHALL render the active sub-route via `<Outlet>`.

#### Scenario: Desktop admin sees sidebar
- **WHEN** an admin navigates to `/admin` or any `/admin/*` sub-route on a desktop viewport
- **THEN** the layout renders a left sidebar with section links and the active section content in the right area

#### Scenario: Mobile admin sees no sidebar on sub-routes
- **WHEN** an admin navigates to `/admin/teams` on a mobile viewport
- **THEN** the sidebar is hidden and only the section content is visible

### Requirement: Overview section displays key metrics
The Overview section (`/admin`) SHALL display metric cards for: total teams count, total mailbox count, ownerless legacy mailbox count (if > 0), and a navigation link to each sub-route.

#### Scenario: Admin views overview with ownerless mailboxes
- **WHEN** an admin visits `/admin` and the mailbox directory contains legacy mailboxes with no owner
- **THEN** a warning callout card is visible showing the count and a link to `/admin/mailboxes?ownerless=true`

#### Scenario: Admin views overview with no issues
- **WHEN** an admin visits `/admin` and no ownerless legacy mailboxes exist
- **THEN** metrics cards are shown and no warning callout is rendered

### Requirement: Teams section supports CRUD and disable toggle
The Teams section (`/admin/teams`) SHALL preserve existing create-team form and team list. It SHALL additionally allow an admin to edit a team's displayName and toggle its enabled/disabled state. Disabled teams SHALL be visually distinguished (e.g., strikethrough or "Disabled" badge).

#### Scenario: Admin creates a new team
- **WHEN** an admin fills the create-team form with valid name and displayName and clicks "Create team"
- **THEN** a new team is created, the list refreshes, and a toast confirms success

#### Scenario: Admin disables a team
- **WHEN** an admin clicks the disable toggle on an existing team
- **THEN** a `PUT` request is sent to `/api/v1/admin/teams/:id` with `{ disabled: true }`, the team row updates with a "Disabled" badge, and the team list re-sorts or fades the row

#### Scenario: Admin re-enables a team
- **WHEN** an admin clicks the disable toggle on a disabled team
- **THEN** a `PUT` request is sent with `{ disabled: false }`, the "Disabled" badge is removed, and the team row returns to normal appearance

### Requirement: Team Users section supports create, disable, and setup link re-issue
The Team Users section (`/admin/team-users` or `/admin/team-users?teamId=xxx`) SHALL preserve existing create-user form and user list. It SHALL additionally allow an admin to toggle a user's enabled/disabled state and re-issue a one-time setup link.

#### Scenario: Admin creates a team user
- **WHEN** an admin selects a team, fills the create-user form, and clicks "Create user"
- **THEN** a new user is created, the setup link appears below the form, and the user list refreshes

#### Scenario: Admin disables a team user
- **WHEN** an admin clicks the disable toggle on a team user
- **THEN** a `PUT` request is sent to `/api/v1/admin/teams/:teamId/users/:userId` with `{ disabled: true }`, the user row updates visually

#### Scenario: Admin re-issues a setup link
- **WHEN** an admin clicks "Re-send setup link" on a team user row
- **THEN** a `POST` request is sent to `/api/v1/admin/teams/:teamId/users/:userId/setup-link`, the new setup link is displayed in a toast or inline, and the link is copied to clipboard automatically

### Requirement: Mailbox Directory supports search, filter, and owner reassignment
The Mailbox Directory section (`/admin/mailboxes`) SHALL preserve the existing table of all mailboxes. It SHALL add a search input, kind filter (legacy / team / team_user / ownerless), and a "Reassign owner" action for legacy/ownerless mailboxes.

#### Scenario: Admin filters to ownerless legacy mailboxes
- **WHEN** an admin selects "ownerless" from the kind filter dropdown
- **THEN** the table only shows legacy mailboxes with no owner assigned

#### Scenario: Admin reassigns a legacy mailbox owner
- **WHEN** an admin clicks "Reassign owner" on an ownerless legacy mailbox row, enters a valid registered user email, and confirms
- **THEN** a `POST` request is sent to `/api/v1/admin/mailboxes/:mailboxId/owner` with `{ email: "user@example.com" }`, the row updates to show the new owner, and a toast confirms

#### Scenario: Admin searches mailboxes
- **WHEN** an admin types "finance" in the search input
- **THEN** the table filters to mailboxes whose email or owner contains "finance" (client-side for now)

### Requirement: Users section lists all users with role management
The Users section (`/admin/users`) SHALL list all registered users with columns: email, displayName, role badge, emailVerifiedAt status, and createdAt. Admins SHALL be able to promote a user to admin or demote to user.

#### Scenario: Admin promotes a user to admin
- **WHEN** an admin clicks "Promote to admin" on a user row
- **THEN** a `POST` request is sent to `/api/v1/admin/users/:id/role` with `{ role: "admin" }`, the role badge updates, and the list refreshes

#### Scenario: Admin cannot self-demotion
- **WHEN** an admin attempts to demote themselves
- **THEN** the server returns `400 "Refusing to demote yourself"`, the UI shows an error toast, and no state change occurs

### Requirement: LLM Providers section migrates from Settings
The LLM Providers section (`/admin/llm-providers`) SHALL contain the full `LlmProvidersCard` and `LlmProviderForm` UI currently in `settings.tsx`. It SHALL use the exact same API methods. After migration, the "System" tab SHALL no longer exist in Settings.

#### Scenario: Admin manages LLM providers in admin console
- **WHEN** an admin navigates to `/admin/llm-providers`
- **THEN** the LLM provider registry table is visible with add/edit/test/delete actions identical to the previous Settings tab

#### Scenario: Settings page no longer shows System tab
- **WHEN** an admin navigates to `/mailbox/:id/settings`
- **THEN** the settings tabs show Account, Agents, Rules, Members, Connections — System is absent

### Requirement: Backend exposes three new admin endpoints
The backend SHALL expose:
1. `PUT /api/v1/admin/teams/:id` — partial update accepting `{ displayName?: string, disabled?: boolean }`
2. `PUT /api/v1/admin/teams/:teamId/users/:userId` — partial update accepting `{ disabled?: boolean }`
3. `POST /api/v1/admin/teams/:teamId/users/:userId/setup-link` — generates a fresh setup token, returning `{ setupUrl, setupExpiresAt }`

All endpoints SHALL require admin authentication and return appropriate error codes.

#### Scenario: Admin updates team display name
- **WHEN** an admin sends `PUT /api/v1/admin/teams/:id` with `{ displayName: "New Name" }`
- **THEN** the team's display name is updated, `updatedAt` is refreshed, and `200` is returned

#### Scenario: Admin disables a team user
- **WHEN** an admin sends `PUT /api/v1/admin/teams/:teamId/users/:userId` with `{ disabled: true }`
- **THEN** `disabledAt` is set to current timestamp, `200` is returned, and subsequent list queries reflect the disabled state

#### Scenario: Admin re-issues setup link
- **WHEN** an admin sends `POST /api/v1/admin/teams/:teamId/users/:userId/setup-link`
- **THEN** a new `setupUrl` and `setupExpiresAt` are generated and returned, replacing the previous token

### Requirement: Query layer follows existing patterns
The client-side query layer SHALL extend existing query key factories and mutation hooks:
- `app/queries/keys.ts` SHALL add `adminUsers: ["admin", "users"] as const`
- `app/queries/teams.ts` SHALL add mutations for `useUpdateTeam`, `useUpdateTeamUser`, `useReissueSetupLink`
- `app/queries/users.ts` *(new file)* SHALL add `useAdminUsers` and `useUpdateUserRole`

#### Scenario: Team disable invalidates related queries
- **WHEN** an admin disables a team
- **THEN** `queryClient.invalidateQueries({ queryKey: queryKeys.adminTeams })` is called, and the mailbox directory also invalidates to reflect any team badge changes
