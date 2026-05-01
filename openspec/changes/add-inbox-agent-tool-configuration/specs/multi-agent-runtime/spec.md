## ADDED Requirements

### Requirement: Inbox owner can configure effective agent behavior
The system SHALL expose a constrained per-inbox configuration surface for the effective agent profile used by a user-owned inbox.

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

### Requirement: Agent model choices are backend-owned
The system SHALL constrain inbox agent model selection to backend-provided options instead of accepting arbitrary free-text model identifiers.

#### Scenario: Config options include model catalog
- **GIVEN** the frontend requests inbox configuration options
- **WHEN** the system returns model choices
- **THEN** the response SHALL include backend-owned model ids, display names, default model id, and availability metadata

#### Scenario: Unsupported model update rejected
- **GIVEN** a client submits a model id that is not in the backend-owned model options
- **WHEN** the system validates the inbox agent configuration update
- **THEN** the system SHALL reject the update with a validation error

#### Scenario: Existing unknown model shown as deprecated current value
- **GIVEN** an inbox already stores a model id that is no longer in the current backend-owned options
- **WHEN** the owner reads the inbox agent configuration
- **THEN** the system MAY return that model as the current deprecated or custom value
- **AND** the owner SHALL be able to reset to a supported default

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

#### Scenario: Safety options are backend-owned
- **GIVEN** the frontend requests inbox configuration options
- **WHEN** the system returns safety choices
- **THEN** the response SHALL include backend-owned safety defaults and allowed safety levels or controls

### Requirement: Config changes apply to future agent runs
The system SHALL define saved configuration changes as applying to future agent runs without interrupting in-flight work.

#### Scenario: Saved config affects next run
- **GIVEN** an inbox owner saves new agent, tool, or safety configuration
- **WHEN** a later inbound email or chat action invokes the agent
- **THEN** the runtime SHALL resolve and use the saved configuration

#### Scenario: In-flight run is not retroactively changed
- **GIVEN** an agent run is already in progress
- **WHEN** an inbox owner saves new configuration
- **THEN** the in-flight run MAY continue with the configuration it already resolved
