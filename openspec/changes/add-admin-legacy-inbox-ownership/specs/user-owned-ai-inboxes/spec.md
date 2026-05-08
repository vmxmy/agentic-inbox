## ADDED Requirements

### Requirement: Admin identifies legacy inboxes for ownership migration
The system SHALL let an administrator identify existing inboxes that do not yet have user-owned inbox metadata.

#### Scenario: Admin lists legacy inboxes
- **GIVEN** a verified administrator is authenticated
- **WHEN** the administrator opens the legacy inbox migration view or calls the equivalent API
- **THEN** the system SHALL list existing inboxes that lack `userOwnedInbox` metadata
- **AND** the response SHALL include enough non-sensitive context to choose the correct inbox, such as address and display name

#### Scenario: Non-admin cannot list legacy inboxes
- **GIVEN** a verified user is not an administrator
- **WHEN** the user requests the legacy inbox migration list
- **THEN** the system SHALL reject the request without exposing legacy inbox metadata

### Requirement: Admin assigns owner metadata to legacy inbox
The system SHALL let an administrator assign explicit user-owned inbox metadata to an existing legacy inbox without changing the inbox's canonical email address or stored mailbox data.

#### Scenario: Admin assigns owner successfully
- **GIVEN** a legacy inbox exists without `userOwnedInbox` metadata
- **AND** a verified administrator provides an owner email and logical subname
- **WHEN** the administrator confirms the assignment
- **THEN** the system SHALL persist `userOwnedInbox` metadata on the existing mailbox settings document
- **AND** the metadata SHALL identify the assigned owner, stored username, logical subname, root domain, and existing inbox address
- **AND** the system SHALL NOT rename the mailbox address or migrate Durable Object state

#### Scenario: Existing settings are preserved
- **GIVEN** a legacy inbox settings document contains display name, forwarding, signature, prompt, agent config, or other mailbox settings
- **WHEN** an administrator assigns owner metadata
- **THEN** the system SHALL preserve those existing settings unless explicitly documented otherwise

#### Scenario: Admin replaces existing owner
- **GIVEN** an inbox already has `userOwnedInbox` metadata
- **AND** a verified administrator explicitly confirms owner replacement
- **WHEN** the administrator provides a new owner email and logical subname
- **THEN** the system SHALL replace the owner metadata
- **AND** the system SHALL preserve the existing inbox address, mailbox data, and Agent Tools Safety configuration

#### Scenario: Invalid assignment is rejected
- **GIVEN** a verified administrator submits an invalid owner email or invalid logical subname
- **WHEN** the administrator attempts to assign ownership
- **THEN** the system SHALL reject the request with a user-readable validation error
- **AND** the system SHALL NOT write partial owner metadata

### Requirement: Assigned legacy inbox follows user-owned access rules
The system SHALL treat a legacy inbox with admin-assigned owner metadata as a user-owned inbox for visibility and configuration authorization.

#### Scenario: Assigned owner can access inbox
- **GIVEN** an administrator assigned a legacy inbox to a verified owner
- **WHEN** that owner lists or opens their mailboxes
- **THEN** the system SHALL include the assigned inbox according to the same user-owned inbox visibility rules

#### Scenario: Assigned owner can configure Agent Tools Safety
- **GIVEN** an administrator assigned a legacy inbox to a verified owner
- **WHEN** that owner opens the inbox settings page
- **THEN** the system SHALL expose the structured Agent, Tools, and Safety configuration controls for that inbox

#### Scenario: Non-owner cannot access assigned inbox
- **GIVEN** an administrator assigned a legacy inbox to one owner
- **WHEN** a different non-admin user attempts to view or configure that inbox
- **THEN** the system SHALL reject the request without exposing the inbox data or configuration

### Requirement: Ownership assignment is admin-only and audited
The system SHALL restrict legacy inbox ownership assignment to administrators and record successful assignment changes for accountability.

#### Scenario: Ordinary user cannot assign ownership
- **GIVEN** a verified user is not an administrator
- **WHEN** the user attempts to assign or replace inbox owner metadata
- **THEN** the system SHALL reject the request
- **AND** the mailbox settings SHALL remain unchanged

#### Scenario: Assignment is audited
- **GIVEN** a verified administrator successfully assigns or replaces owner metadata for an inbox
- **WHEN** the system persists the ownership change
- **THEN** the system SHALL append an audit entry containing the administrator identity, inbox address, previous owner when present, assigned owner email, timestamp, and action type

#### Scenario: Stale assignment is rejected
- **GIVEN** an administrator loaded legacy inbox settings with an older revision or ETag
- **WHEN** the administrator submits an ownership assignment after the settings changed
- **THEN** the system SHALL reject the stale write with a conflict response
- **AND** the system SHALL NOT overwrite the newer settings
