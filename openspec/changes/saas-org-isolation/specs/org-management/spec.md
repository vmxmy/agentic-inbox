## ADDED Requirements

### Requirement: Authenticated users can create organizations
The system SHALL allow any authenticated user to create an organization. The organization SHALL have a globally unique slug, a display name, and a primary address derived from the slug and configured domain.

#### Scenario: User creates first organization
- **WHEN** an authenticated user sends `POST /api/v1/orgs` with `{ slug: "acme", displayName: "Acme Corp" }`
- **THEN** the system SHALL create an org with id, slug, displayName, primaryAddress, and createdByUserId set to the caller
- **AND** the caller SHALL be added as an `org_members` row with role `owner`
- **AND** the system SHALL return the created org with `201`

#### Scenario: Duplicate slug rejected
- **WHEN** an authenticated user sends `POST /api/v1/orgs` with a slug that already exists
- **THEN** the system SHALL return `409` with error "Organization slug already exists"

#### Scenario: Invalid slug rejected
- **WHEN** an authenticated user sends `POST /api/v1/orgs` with a slug containing spaces or special characters
- **THEN** the system SHALL return `400` with error "Invalid slug format"

### Requirement: Org owners and admins can update organization details
The system SHALL allow org owners and admins to update the display name of their organization.

#### Scenario: Org owner updates display name
- **WHEN** an org owner sends `PUT /api/v1/orgs/:orgId` with `{ displayName: "Acme Corporation" }`
- **THEN** the organization's displayName SHALL be updated
- **AND** `updatedAt` SHALL be refreshed
- **AND** the system SHALL return `200` with the updated org

#### Scenario: Org member attempts update
- **WHEN** an org member (non-admin) sends `PUT /api/v1/orgs/:orgId`
- **THEN** the system SHALL return `403` with error "Org admin access required"

### Requirement: Org owners can disable organizations
The system SHALL allow org owners to disable an organization via soft delete (setting `disabledAt`). Disabled orgs SHALL not appear in listings or allow new operations.

#### Scenario: Org owner disables org
- **WHEN** an org owner sends `DELETE /api/v1/orgs/:orgId`
- **THEN** the organization's `disabledAt` SHALL be set to current timestamp
- **AND** the org SHALL no longer appear in `GET /api/v1/orgs` for any member
- **AND** the system SHALL return `204`

#### Scenario: Org admin cannot disable org
- **WHEN** an org admin (not owner) sends `DELETE /api/v1/orgs/:orgId`
- **THEN** the system SHALL return `403` with error "Org owner access required"

### Requirement: Users can list their organizations
The system SHALL return all active organizations that the authenticated user is a member of, including their role in each org.

#### Scenario: User with multiple orgs lists them
- **WHEN** an authenticated user sends `GET /api/v1/orgs`
- **THEN** the system SHALL return an array of org objects, each containing id, slug, displayName, primaryAddress, and the user's role
- **AND** disabled orgs SHALL be excluded

#### Scenario: User with no orgs gets empty list
- **WHEN** an authenticated user with no org memberships sends `GET /api/v1/orgs`
- **THEN** the system SHALL return an empty array `[]`

### Requirement: Org members can view organization details
The system SHALL allow any org member to view the details of their organization.

#### Scenario: Member views org details
- **WHEN** an org member sends `GET /api/v1/orgs/:orgId`
- **THEN** the system SHALL return the org details including id, slug, displayName, primaryAddress, and member count

#### Scenario: Non-member attempts to view org
- **WHEN** a user who is not a member of the org sends `GET /api/v1/orgs/:orgId`
- **THEN** the system SHALL return `404` (not `403`, to prevent org enumeration)
