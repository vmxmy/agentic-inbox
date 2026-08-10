## ADDED Requirements

### Requirement: Mailboxes can belong to an organization
The system SHALL support associating a mailbox with an organization via the `mailboxes.org_id` column. When a mailbox belongs to an org, org members can access it according to their org role and per-mailbox ACL.

#### Scenario: Org mailbox is accessible to org members
- **GIVEN** a mailbox with `org_id` set to an active organization
- **WHEN** an authenticated user who is a member of that org attempts to access the mailbox
- **THEN** the system SHALL grant access (subject to per-mailbox ACL for non-admin members)

#### Scenario: Non-org member cannot access org mailbox
- **GIVEN** a mailbox with `org_id` set to an organization
- **WHEN** an authenticated user who is NOT a member of that org attempts to access the mailbox
- **THEN** the system SHALL return `403` or `404`

### Requirement: Org owner and admin automatically access all org mailboxes
The system SHALL grant org owners and admins access to all mailboxes within their organization, regardless of per-mailbox ACL.

#### Scenario: Org owner accesses any org mailbox without explicit ACL
- **GIVEN** an org mailbox where the user is neither owner nor member in `mailbox_members`
- **WHEN** the org owner attempts to access the mailbox
- **THEN** the system SHALL grant access

#### Scenario: Org admin accesses any org mailbox
- **GIVEN** an org mailbox where the user is neither owner nor member
- **WHEN** an org admin attempts to access the mailbox
- **THEN** the system SHALL grant access

#### Scenario: Org member still subject to per-mailbox ACL
- **GIVEN** an org mailbox where the user is a regular org member (not owner/admin)
- **AND** the user is neither owner nor member in `mailbox_members`
- **WHEN** the user attempts to access the mailbox
- **THEN** the system SHALL return `403`

### Requirement: Org admins can create mailboxes within their organization
The system SHALL allow org owners and admins to create new mailboxes that are automatically associated with their organization.

#### Scenario: Org admin creates mailbox
- **WHEN** an org admin sends `POST /api/v1/mailboxes` with mailbox details while having an active org context
- **THEN** the system SHALL create the mailbox with `org_id` set to the active org
- **AND** an `org_mailboxes` row SHALL be created linking the org and mailbox

#### Scenario: Org member cannot create mailbox
- **WHEN** an org member (non-admin) sends `POST /api/v1/mailboxes`
- **THEN** the system SHALL return `403`

### Requirement: Org mailboxes are listed in org context
The system SHALL include org-associated mailboxes when listing mailboxes for a user with an active org context.

#### Scenario: User sees personal and org mailboxes
- **GIVEN** a user who owns 2 personal mailboxes and belongs to an org with 3 mailboxes
- **WHEN** the user sends `GET /api/v1/mailboxes`
- **THEN** the response SHALL include all 5 mailboxes (2 personal + 3 org)
- **AND** each mailbox SHALL indicate whether it is org-managed

### Requirement: Mailbox creation respects email address restrictions
The system SHALL continue to enforce `EMAIL_ADDRESSES` allowlist restrictions for mailbox creation, regardless of org context.

#### Scenario: Org admin attempts to create mailbox with unauthorized address
- **WHEN** an org admin attempts to create a mailbox with an email not in `EMAIL_ADDRESSES`
- **THEN** the system SHALL return `403` with error "Mailbox creation is restricted to configured EMAIL_ADDRESSES"
