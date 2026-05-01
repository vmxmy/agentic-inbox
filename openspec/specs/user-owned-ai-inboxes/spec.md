# user-owned-ai-inboxes Specification

## Purpose
TBD - created by archiving change add-user-owned-ai-inbox-creation. Update Purpose after archive.
## Requirements
### Requirement: Verified user identity for inbox creation
The system SHALL derive ordinary user inbox ownership from the verified Cloudflare Access identity, not from client-submitted user identity fields.

#### Scenario: Verified identity is available
- **WHEN** an Access-authenticated user calls the ordinary inbox creation API
- **THEN** the system SHALL use the verified Access email as the owner identity

#### Scenario: Verified identity is unavailable
- **WHEN** the system cannot determine a verified user email for an ordinary inbox creation request
- **THEN** the system SHALL reject the request without creating an inbox

### Requirement: Generated user username
The system SHALL assign every verified human user a stable username derived from their verified login identity.

#### Scenario: Username generated for new user
- **WHEN** a verified user first needs an inbox namespace
- **THEN** the system SHALL store a normalized username for that user in application-owned metadata

#### Scenario: Username collision handled
- **WHEN** the normalized base username is already assigned to another user
- **THEN** the system SHALL store a unique suffixed username for the new user

#### Scenario: Username remains stable
- **WHEN** a user creates multiple inboxes over time
- **THEN** the system SHALL use the same stored username for every derived ordinary inbox address

### Requirement: User creates AI inbox entity
The system SHALL allow a verified user to create multiple AI inbox entities by providing a display name and a subname.

#### Scenario: Successful inbox creation
- **WHEN** a verified user submits a valid display name and valid subname
- **THEN** the system SHALL create an inbox owned by that user
- **AND** the inbox SHALL be usable through the existing MailboxDO runtime

#### Scenario: Multiple inboxes per user
- **WHEN** a user creates two inboxes with different subnames
- **THEN** the system SHALL store both inboxes as separate entities for that user

#### Scenario: Duplicate subname rejected for same user
- **WHEN** a user creates an inbox with a subname already used under their username and root domain
- **THEN** the system SHALL reject the request with a conflict error

### Requirement: Subname validation
The system SHALL validate user-entered inbox subnames before deriving an email address.

#### Scenario: Valid subname accepted
- **WHEN** a user submits a subname containing only lowercase letters, numbers, and hyphens with valid length and shape
- **THEN** the system SHALL accept the subname

#### Scenario: Invalid subname rejected
- **WHEN** a user submits a subname with unsupported characters, leading hyphen, trailing hyphen, repeated hyphens, or invalid length
- **THEN** the system SHALL reject the subname with a user-readable validation error

#### Scenario: Reserved subname rejected
- **WHEN** a user submits a reserved subname such as `admin`, `api`, `mcp`, `auth`, or `system`
- **THEN** the system SHALL reject the subname with a user-readable validation error

### Requirement: Server-derived ordinary inbox address
The system SHALL derive the ordinary inbox email address on the server as `username.subname@root-domain`.

#### Scenario: Address derived from authenticated user
- **WHEN** a verified user with username `alice` creates an inbox with subname `reimburse`
- **THEN** the system SHALL derive the address `alice.reimburse@root-domain`

#### Scenario: Client cannot override address namespace
- **WHEN** a client submits a full email address or another user's username during ordinary inbox creation
- **THEN** the system SHALL reject or ignore that client-supplied address data
- **AND** the system SHALL use only server-derived address data

### Requirement: Display name and subname are separate
The system SHALL store and return a user-facing display name separately from the email-address subname.

#### Scenario: Chinese display name with English subname
- **WHEN** a user creates an inbox with display name `报销` and subname `reimburse`
- **THEN** the system SHALL store the display name as `报销`
- **AND** the system SHALL derive an address ending in `.reimburse@root-domain`

#### Scenario: Inbox list shows friendly identity
- **WHEN** a user views their inbox list
- **THEN** each user-owned inbox SHALL show its display name and derived email address

### Requirement: R2-backed user-owned inbox metadata
The system SHALL persist user-owned inbox metadata additively in the existing R2 mailbox settings model for this MVP.

#### Scenario: User-owned metadata is stored with mailbox settings
- **WHEN** a user-owned inbox is created
- **THEN** the system SHALL write mailbox settings under `mailboxes/<derived-address>.json`
- **AND** the settings SHALL include owner, username, subname, root domain, derived address, and InboxProfile metadata

#### Scenario: Existing settings remain compatible
- **WHEN** existing mailbox code reads settings for a user-owned inbox
- **THEN** the added metadata SHALL NOT prevent existing mailbox behavior from operating

### Requirement: Transitional mailbox compatibility
The system SHALL keep existing mailbox records usable while introducing AI inbox metadata.

#### Scenario: Legacy mailbox remains visible
- **WHEN** a mailbox lacks user-owned inbox metadata
- **THEN** the system SHALL keep the mailbox accessible during this change

#### Scenario: New inbox uses existing MailboxDO path
- **WHEN** a new AI inbox is created in this MVP slice
- **THEN** the system MAY use the full derived email address as the transitional MailboxDO name

