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
