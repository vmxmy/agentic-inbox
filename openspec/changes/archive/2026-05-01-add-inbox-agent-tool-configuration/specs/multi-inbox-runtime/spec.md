## ADDED Requirements

### Requirement: Inbox configuration persists additively in R2 settings
The system SHALL persist per-inbox agent, tool, and safety configuration additively in the existing R2 mailbox settings document for this MVP.

#### Scenario: Config save preserves mailbox compatibility
- **GIVEN** an inbox settings document already contains mailbox, user-owned inbox, and inbox profile metadata
- **WHEN** the inbox owner saves agent/tool/safety configuration
- **THEN** the system SHALL preserve existing mailbox behavior and server-owned inbox metadata

#### Scenario: Missing config remains usable
- **GIVEN** an existing mailbox settings document lacks agent, tool, or safety configuration
- **WHEN** the runtime loads the inbox profile
- **THEN** the system SHALL apply default configuration and keep the inbox usable

#### Scenario: Config includes schema version
- **GIVEN** the system persists structured inbox configuration
- **WHEN** the settings document is written
- **THEN** the persisted configuration SHALL include a schema version for future migrations

### Requirement: Owned inbox config respects user visibility
The system SHALL apply the same user-owned inbox access rules to configuration reads and writes as it applies to inbox detail and list APIs.

#### Scenario: Owner can update owned inbox config
- **GIVEN** a verified user owns an AI inbox
- **WHEN** the user saves configuration for that inbox
- **THEN** the system SHALL persist the configuration

#### Scenario: Non-owner cannot update owned inbox config
- **GIVEN** a verified user does not own an AI inbox
- **WHEN** the user attempts to read or write configuration for that inbox
- **THEN** the system SHALL return not found or forbidden without exposing the inbox configuration

#### Scenario: Legacy mailbox config write rejected
- **GIVEN** a mailbox does not have user-owned inbox metadata
- **WHEN** a client attempts to write structured Agent/Tools/Safety configuration for it
- **THEN** the system SHALL reject the write or expose the mailbox as read-only for this configuration flow

### Requirement: Config updates use optimistic concurrency
The system SHALL detect stale inbox configuration writes to avoid silent overwrite between multiple editing sessions.

#### Scenario: Update includes current revision
- **GIVEN** a user reads inbox configuration with a revision or ETag
- **WHEN** the user saves changes with the current revision
- **THEN** the system SHALL accept the update if the stored revision still matches

#### Scenario: Stale update rejected
- **GIVEN** a user reads inbox configuration with an older revision
- **WHEN** another save has already changed the stored configuration
- **THEN** the system SHALL reject the stale update with a conflict response

### Requirement: Config changes are audited
The system SHALL record successful inbox configuration changes with enough context for debugging and accountability.

#### Scenario: Successful update appends audit entry
- **GIVEN** an inbox owner successfully saves agent, tool, or safety configuration
- **WHEN** the system persists the change
- **THEN** the system SHALL append an audit entry containing actor, inbox identity, changed fields, timestamp, and a redacted old/new summary

#### Scenario: Sensitive values are redacted in audit
- **GIVEN** a configuration change includes long prompts or sensitive safety/model values
- **WHEN** the audit entry is written
- **THEN** the system SHALL avoid storing unnecessary full sensitive content in the audit log
