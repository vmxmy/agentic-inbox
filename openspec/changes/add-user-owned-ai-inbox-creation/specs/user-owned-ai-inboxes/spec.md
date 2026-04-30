## ADDED Requirements

### Requirement: Generated user username
The system SHALL assign every authenticated human user a stable, globally unique username derived from their verified login identity.

#### Scenario: Username generated for new user
- **WHEN** a verified user account is created or first needs an inbox namespace
- **THEN** the system stores a normalized username for that user

#### Scenario: Username collision handled
- **WHEN** the normalized base username is already assigned to another user
- **THEN** the system stores a unique suffixed username for the new user

#### Scenario: Username remains stable
- **WHEN** a user creates multiple inboxes over time
- **THEN** the system uses the same stored username for every derived ordinary inbox address

### Requirement: User creates AI inbox entity
The system SHALL allow an authenticated user to create multiple AI inbox entities by providing a display name and a subname.

#### Scenario: Successful inbox creation
- **WHEN** an authenticated user submits a valid display name and valid subname
- **THEN** the system creates an inbox owned by that user

#### Scenario: Multiple inboxes per user
- **WHEN** a user creates two inboxes with different subnames
- **THEN** the system stores both inboxes as separate entities for that user

#### Scenario: Duplicate subname rejected for same user
- **WHEN** a user creates an inbox with a subname already used under their username and root domain
- **THEN** the system rejects the request with a conflict error

### Requirement: Subname validation
The system SHALL validate user-entered inbox subnames before deriving an email address.

#### Scenario: Valid subname accepted
- **WHEN** a user submits a subname containing only lowercase letters, numbers, and hyphens with valid length and shape
- **THEN** the system accepts the subname

#### Scenario: Invalid subname rejected
- **WHEN** a user submits a subname with unsupported characters, leading hyphen, trailing hyphen, repeated hyphens, or invalid length
- **THEN** the system rejects the subname with a user-readable validation error

#### Scenario: Reserved subname rejected
- **WHEN** a user submits a reserved subname such as `admin`, `api`, `mcp`, `auth`, or `system`
- **THEN** the system rejects the subname with a user-readable validation error

### Requirement: Server-derived ordinary inbox address
The system SHALL derive the ordinary inbox email address on the server as `username.subname@root-domain`.

#### Scenario: Address derived from authenticated user
- **WHEN** an authenticated user creates an inbox with subname `reimburse`
- **THEN** the system derives the address using the user's stored username and configured root domain

#### Scenario: Client cannot override address namespace
- **WHEN** a client submits a full email address or another user's username during ordinary inbox creation
- **THEN** the system ignores or rejects that client-supplied address data and uses only server-derived address data

### Requirement: Display name and subname are separate
The system SHALL store and return a user-facing display name separately from the email-address subname.

#### Scenario: Chinese display name with English subname
- **WHEN** a user creates an inbox with display name `报销` and subname `reimburse`
- **THEN** the system stores the display name as `报销` and derives an address ending in `.reimburse@root-domain`

#### Scenario: Inbox list shows friendly identity
- **WHEN** a user views their inbox list
- **THEN** each inbox shows its display name and derived email address

### Requirement: Transitional mailbox compatibility
The system SHALL keep existing mailbox records usable while introducing AI inbox metadata.

#### Scenario: Legacy mailbox remains visible
- **WHEN** a user has access to an existing mailbox that lacks new inbox metadata
- **THEN** the system keeps the mailbox accessible and does not force-convert it during this change

#### Scenario: New inbox uses existing MailboxDO path
- **WHEN** a new AI inbox is created in this MVP slice
- **THEN** the system may use the full derived email address as the transitional MailboxDO name

