## ADDED Requirements

### Requirement: Active org context is resolved per request
The system SHALL resolve the active organization for each authenticated request. The resolution order SHALL be: (1) explicit org switch header/body, (2) user's `default_org_id`, (3) first org the user belongs to.

#### Scenario: User with active org context accesses mailbox
- **GIVEN** a user belongs to org A and org B
- **AND** the user's `default_org_id` is org A
- **WHEN** the user makes any API request without explicit org switch
- **THEN** the system SHALL resolve org A as the active org
- **AND** `AuthUser.orgId` SHALL be set to org A's id
- **AND** `AuthUser.orgRole` SHALL be set to the user's role in org A

#### Scenario: User with no orgs has null org context
- **GIVEN** a user who does not belong to any organization
- **WHEN** the user makes an API request
- **THEN** `AuthUser.orgId` SHALL be undefined
- **AND** `AuthUser.orgRole` SHALL be undefined
- **AND** the request SHALL proceed with existing non-org logic

### Requirement: Users can switch their active organization
The system SHALL provide an endpoint for users to explicitly switch their active organization.

#### Scenario: User switches to another org
- **WHEN** an authenticated user sends `POST /api/v1/orgs/switch` with `{ orgId: "org-b-id" }`
- **AND** the user is a member of org B
- **THEN** the system SHALL update `users.default_org_id` to org B's id
- **AND** the system SHALL return `200` with `{ ok: true }`
- **AND** subsequent requests SHALL resolve org B as the active org

#### Scenario: User attempts to switch to non-member org
- **WHEN** a user sends `POST /api/v1/orgs/switch` with an orgId they do not belong to
- **THEN** the system SHALL return `403` with error "Not a member of this organization"

### Requirement: Internal auth context carries org information
The system SHALL include `orgId` and `orgRole` in the internal JWT claims used for worker-to-DO communication.

#### Scenario: DO receives org context via internal header
- **GIVEN** a request with active org context
- **WHEN** the worker forwards the request to a Durable Object with `x-internal-auth-context` header
- **THEN** the JWT claims SHALL include `orgId` and `orgRole`
- **AND** the DO SHALL be able to read these values via `readInternalAuthContextHeader`

### Requirement: whoami endpoint returns org information
The system SHALL include the user's organizations and active org context in the `whoami` response.

#### Scenario: whoami includes orgs for multi-org user
- **WHEN** an authenticated user sends `GET /api/v1/whoami`
- **THEN** the response SHALL include:
  - `orgs`: array of org summaries (id, slug, displayName, role)
  - `activeOrgId`: the currently active org id
  - `activeOrgRole`: the user's role in the active org

#### Scenario: whoami for user with no orgs
- **WHEN** a user with no org memberships sends `GET /api/v1/whoami`
- **THEN** `orgs` SHALL be an empty array
- **AND** `activeOrgId` and `activeOrgRole` SHALL be `null`

### Requirement: Org context is bypassed when feature switch is off
When `ORG_MODE_ENABLED` is false, the system SHALL skip all org resolution and behave exactly as before.

#### Scenario: Feature disabled ignores org data
- **GIVEN** `ORG_MODE_ENABLED=false`
- **WHEN** any authenticated request is made
- **THEN** `AuthUser.orgId` SHALL NOT be set
- **AND** `GET /api/v1/whoami` SHALL NOT include org fields
- **AND** mailbox access SHALL use existing ACL logic only
