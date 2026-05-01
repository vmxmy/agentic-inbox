## ADDED Requirements

### Requirement: Inbox owner can configure effective agent behavior
The system SHALL expose a constrained per-inbox configuration surface for the effective agent profile used by that inbox.

#### Scenario: Owner reads current agent configuration
- **GIVEN** a verified user owns an AI inbox
- **WHEN** the user opens the inbox agent settings
- **THEN** the system SHALL return the effective agent display metadata, instructions, model preference, and automation policy for that inbox

#### Scenario: Owner updates agent instructions
- **GIVEN** a verified user owns an AI inbox
- **WHEN** the user saves new agent instructions through the constrained configuration endpoint
- **THEN** the system SHALL persist those instructions as the inbox's effective agent profile configuration
- **AND** future agent invocations for that inbox SHALL use the saved instructions

#### Scenario: Client cannot modify routing through agent config
- **GIVEN** a client submits agent configuration data
- **WHEN** the payload includes inbox address, owner, storage mailbox id, lifecycle, or other routing metadata
- **THEN** the system SHALL reject or ignore those fields
- **AND** the inbox identity and routing fields SHALL remain server-owned

### Requirement: Inbox automation policy is configurable
The system SHALL allow an inbox owner to control whether inbound email triggers automatic draft generation for that inbox.

#### Scenario: Inbound auto-draft enabled
- **GIVEN** an inbox's automation policy enables inbound auto-draft
- **WHEN** a new email is persisted for that inbox
- **THEN** the agent runtime SHALL invoke the model and available tools according to the effective agent profile

#### Scenario: Inbound auto-draft disabled
- **GIVEN** an inbox's automation policy disables inbound auto-draft
- **WHEN** a new email is persisted for that inbox
- **THEN** the agent runtime SHALL NOT invoke the model to draft a reply
- **AND** the system SHALL record or expose a clear skipped reason for the operator

### Requirement: Inbox safety policy is explicit and safe by default
The system SHALL resolve an explicit safety policy for each inbox before running prompt-injection scanning or draft verification.

#### Scenario: Missing safety policy uses safe defaults
- **GIVEN** an inbox has no saved safety policy
- **WHEN** the agent runtime handles inbound mail or generated draft text
- **THEN** prompt-injection scanning and draft verification SHALL remain enabled

#### Scenario: Safety policy controls scans
- **GIVEN** an inbox has a saved safety policy
- **WHEN** the agent runtime checks email body, thread context, or draft text
- **THEN** the runtime SHALL follow the resolved safety policy for those checks

#### Scenario: Safety model selection remains provider-aware
- **GIVEN** a safety policy does not pin a safety model
- **WHEN** safety checks run
- **THEN** the system SHALL use the existing environment-level safety model resolution fallback chain
