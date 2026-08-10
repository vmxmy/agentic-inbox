## MODIFIED Requirements

### Requirement: Overview section displays key metrics
The Overview section (`/admin`) SHALL display metric cards for: total orgs count, total mailbox count, ownerless legacy mailbox count (if > 0), and a navigation link to each sub-route. The "total teams count" metric SHALL be replaced with "total orgs count".

#### Scenario: Admin views overview with ownerless mailboxes
- **WHEN** an admin visits `/admin` and the mailbox directory contains legacy mailboxes with no owner
- **THEN** a warning callout card is visible showing the count and a link to `/admin/mailboxes?ownerless=true`

#### Scenario: Admin views overview with org metrics
- **WHEN** an admin visits `/admin`
- **THEN** the Overview SHALL display total orgs count (not teams count)
- **AND** a navigation link to the orgs section SHALL be visible

### Requirement: Teams section supports CRUD and disable toggle
**This requirement is deprecated. Team management is replaced by org management.**

The Teams section (`/admin/teams`) SHALL be marked as deprecated. It SHALL display existing teams in read-only mode with a deprecation banner directing admins to use the new org management interface.

#### Scenario: Admin views deprecated teams section
- **WHEN** an admin navigates to `/admin/teams`
- **THEN** a deprecation banner SHALL be displayed
- **AND** existing teams SHALL be listed in read-only mode
- **AND** the create-team form SHALL be disabled

### Requirement: Backend exposes three new admin endpoints
The backend SHALL continue to expose the three endpoints for backward compatibility, but they SHALL operate on the underlying org data:
1. `PUT /api/v1/admin/teams/:id` — operates on org data via compatibility layer
2. `PUT /api/v1/admin/teams/:teamId/users/:userId` — operates on org_members via compatibility layer
3. `POST /api/v1/admin/teams/:teamId/users/:userId/setup-link` — generates setup token

## ADDED Requirements

### Requirement: Admin console includes org management section
The admin console SHALL include a new "Organizations" section (`/admin/orgs`) that lists all organizations, allows viewing details, and supports disabling orgs.

#### Scenario: Admin lists all orgs
- **WHEN** an admin navigates to `/admin/orgs`
- **THEN** a table of all organizations SHALL be displayed with columns: slug, displayName, primaryAddress, member count, and status

#### Scenario: Admin disables an org
- **WHEN** an admin clicks the disable action on an org row
- **THEN** a confirmation dialog SHALL appear
- **AND** upon confirmation, the org SHALL be disabled (soft delete)
- **AND** the row SHALL update to show "Disabled" status
