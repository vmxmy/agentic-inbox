## ADDED Requirements

### Requirement: Org owners and admins can invite users by email
The system SHALL allow org owners and admins to invite users to their organization by email. The invite SHALL include a role (owner/admin/member) and expire after 7 days.

#### Scenario: Org admin invites new member
- **WHEN** an org admin sends `POST /api/v1/orgs/:orgId/members` with `{ email: "new@example.com", role: "member" }`
- **THEN** the system SHALL create an `org_invites` row with a hashed token, expiry 7 days from now, and the specified role
- **AND** an invitation email SHALL be sent to the address with a secure acceptance link
- **AND** the system SHALL return `201` with the invite id

#### Scenario: Invite to existing member rejected
- **WHEN** an org admin sends `POST /api/v1/orgs/:orgId/members` with an email that is already an org member
- **THEN** the system SHALL return `409` with error "User is already a member of this organization"

#### Scenario: Member cannot invite users
- **WHEN** an org member (non-admin) sends `POST /api/v1/orgs/:orgId/members`
- **THEN** the system SHALL return `403` with error "Org admin access required"

### Requirement: Invited users can accept organization invites
The system SHALL allow any authenticated user to accept an organization invite using the token from the invitation email.

#### Scenario: User accepts valid invite
- **WHEN** an authenticated user sends `POST /api/v1/org-invites/accept` with `{ token: "<invite-token>" }`
- **THEN** the system SHALL verify the token hash against `org_invites`
- **AND** the user SHALL be added to `org_members` with the role specified in the invite
- **AND** the invite SHALL be marked as consumed
- **AND** the system SHALL return `200` with the orgId

#### Scenario: Expired invite rejected
- **WHEN** a user attempts to accept an invite after its expiry date
- **THEN** the system SHALL return `400` with error "Invitation has expired"

#### Scenario: Already consumed invite rejected
- **WHEN** a user attempts to accept an invite that has already been consumed
- **THEN** the system SHALL return `400` with error "Invitation has already been used"

### Requirement: Org owners and admins can remove members
The system SHALL allow org owners and admins to remove members from their organization. Owners cannot be removed by admins.

#### Scenario: Org admin removes a member
- **WHEN** an org admin sends `DELETE /api/v1/orgs/:orgId/members/:userId`
- **THEN** the `org_members` row for that user SHALL be deleted
- **AND** the system SHALL return `204`

#### Scenario: Cannot remove org owner
- **WHEN** an org admin sends `DELETE /api/v1/orgs/:orgId/members/:ownerUserId`
- **THEN** the system SHALL return `403` with error "Cannot remove organization owner"

#### Scenario: Member cannot remove anyone
- **WHEN** an org member sends `DELETE /api/v1/orgs/:orgId/members/:userId`
- **THEN** the system SHALL return `403` with error "Org admin access required"

### Requirement: Org owners can change member roles
The system SHALL allow org owners to change the role of any member in their organization.

#### Scenario: Owner promotes member to admin
- **WHEN** an org owner sends `PUT /api/v1/orgs/:orgId/members/:userId/role` with `{ role: "admin" }`
- **THEN** the member's role in `org_members` SHALL be updated to "admin"
- **AND** the system SHALL return `200`

#### Scenario: Admin cannot change roles
- **WHEN** an org admin sends `PUT /api/v1/orgs/:orgId/members/:userId/role`
- **THEN** the system SHALL return `403` with error "Org owner access required"

#### Scenario: Cannot demote the only owner
- **WHEN** an org owner attempts to change the role of the only remaining owner to "admin" or "member"
- **THEN** the system SHALL return `400` with error "Organization must have at least one owner"

### Requirement: Org members can view the member roster
The system SHALL allow any org member to view the list of members in their organization.

#### Scenario: Member views roster
- **WHEN** an org member sends `GET /api/v1/orgs/:orgId/members`
- **THEN** the system SHALL return an array of members, each with userId, email, displayName, role, and joinedAt

#### Scenario: Pending invites included in roster
- **WHEN** an org member views the roster and there are pending invites
- **THEN** the response SHALL include a separate `invites` array with pending invitations (email, role, expiresAt)
