## MODIFIED Requirements

### Requirement: Inbox profile abstraction
The system SHALL represent each runtime inbox through an inbox profile that includes canonical address, display metadata, lifecycle status, selected agent profile, enabled tool metadata, and **organization affiliation**.

#### Scenario: Existing mailbox loads as inbox profile
- **GIVEN** an existing mailbox is defined by official-baseline mailbox settings
- **WHEN** the runtime loads that mailbox
- **THEN** the system SHALL expose it as an inbox profile
- **AND** the inbox profile SHALL preserve compatibility with existing mailbox state
- **AND** if the mailbox has an `org_id`, the profile SHALL include the org slug and displayName

#### Scenario: Org mailbox profile includes org metadata
- **GIVEN** a mailbox associated with an organization
- **WHEN** the runtime loads the inbox profile
- **THEN** the profile SHALL include `org: { id, slug, displayName }`
- **AND** the profile SHALL remain compatible with existing email agent behavior

### Requirement: Inbound recipient resolves to inbox profile
The system SHALL resolve every inbound email recipient to an inbox profile before storing mail or invoking agent automation. The resolution SHALL continue to use `address_registry` during the migration period, with org data as the future source of truth.

#### Scenario: Known recipient resolves successfully
- **GIVEN** Cloudflare Email Routing delivers mail for a known inbox address
- **WHEN** the Worker handles the inbound message
- **THEN** the Worker SHALL resolve the recipient to an inbox profile
- **AND** the Worker SHALL use the resolved profile for mailbox storage and agent automation
- **AND** the org context SHALL NOT affect inbound routing

## ADDED Requirements

### Requirement: Inbox listing filters by active org context
When a user has an active org context, the system SHALL include org-associated mailboxes in the inbox list.

#### Scenario: User with active org sees org mailboxes
- **GIVEN** a user with active org A
- **AND** org A has 3 associated mailboxes
- **WHEN** the system lists inboxes for the user
- **THEN** the list SHALL include the user's personal mailboxes AND org A's mailboxes
- **AND** each org mailbox SHALL be tagged with its org affiliation

#### Scenario: User without org context sees only personal mailboxes
- **GIVEN** a user with no active org context
- **WHEN** the system lists inboxes for the user
- **THEN** the list SHALL include only mailboxes where the user is owner or member
- **AND** org-associated mailboxes SHALL NOT be included unless the user has direct ACL access
