# multi-inbox-runtime Specification

## Purpose
TBD - created by archiving change add-inbox-agent-tool-framework. Update Purpose after archive.
## Requirements
### Requirement: Inbox profile abstraction
The system SHALL represent each runtime inbox through an inbox profile that includes canonical address, display metadata, lifecycle status, selected agent profile, and enabled tool metadata.

#### Scenario: Existing mailbox loads as inbox profile
- **GIVEN** an existing mailbox is defined by official-baseline mailbox settings
- **WHEN** the runtime loads that mailbox
- **THEN** the system SHALL expose it as an inbox profile
- **AND** the inbox profile SHALL preserve compatibility with existing mailbox state

#### Scenario: Missing optional metadata uses defaults
- **GIVEN** a mailbox settings record does not include new inbox profile fields
- **WHEN** the runtime loads the inbox profile
- **THEN** the system SHALL apply safe default values for optional profile fields
- **AND** the mailbox SHALL remain usable by the existing email agent flow

### Requirement: Inbound recipient resolves to inbox profile
The system SHALL resolve every inbound email recipient to an inbox profile before storing mail or invoking agent automation.

#### Scenario: Known recipient resolves successfully
- **GIVEN** Cloudflare Email Routing delivers mail for a known inbox address
- **WHEN** the Worker handles the inbound message
- **THEN** the Worker SHALL resolve the recipient to an inbox profile
- **AND** the Worker SHALL use the resolved profile for mailbox storage and agent automation

#### Scenario: Unknown recipient is not auto-created
- **GIVEN** Cloudflare Email Routing delivers mail for an unknown recipient address
- **WHEN** the Worker handles the inbound message
- **THEN** the system SHALL NOT create a new inbox profile implicitly
- **AND** the message SHALL be rejected or ignored according to the configured inbound policy

### Requirement: Inbox runtime remains Durable Object compatible
The system SHALL keep Durable Objects as the inbox-local state boundary for this change.

#### Scenario: Profile uses existing MailboxDO storage
- **GIVEN** an inbox profile has been resolved
- **WHEN** the system reads or writes mailbox-local message state
- **THEN** the system SHALL use the existing MailboxDO storage boundary
- **AND** the system SHALL NOT require a stable inbox id migration for this change

### Requirement: Inbox profile persistence is additive
The system SHALL persist inbox profile metadata without breaking existing official-baseline mailbox settings.

#### Scenario: Existing settings remain readable
- **GIVEN** a mailbox settings record was created before this change
- **WHEN** the updated runtime reads the settings
- **THEN** the system SHALL read the record successfully
- **AND** the system SHALL derive a compatible inbox profile from it

#### Scenario: Updated settings remain mailbox compatible
- **GIVEN** the system saves inbox profile metadata for a mailbox
- **WHEN** existing mailbox behavior reads the mailbox settings
- **THEN** the added metadata SHALL NOT prevent existing mailbox behavior from operating

