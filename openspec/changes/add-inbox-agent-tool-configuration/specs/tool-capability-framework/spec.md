## ADDED Requirements

### Requirement: Tool catalog is exposed for configuration
The system SHALL expose backend-owned tool capability metadata so the frontend can render configurable tools without hardcoding the canonical registry.

#### Scenario: Catalog lists built-in tools
- **GIVEN** built-in tool capabilities are registered in the worker
- **WHEN** the frontend requests the tool catalog
- **THEN** the system SHALL return stable ids, names, descriptions, supported surfaces, and permission metadata for configurable tools

#### Scenario: Catalog marks risky tools
- **GIVEN** a tool can mutate inbox state or send external email
- **WHEN** the tool appears in the catalog response
- **THEN** the response SHALL include permission metadata that lets the UI show the associated risk

#### Scenario: Catalog includes editability
- **GIVEN** a tool is not editable by ordinary users in this phase
- **WHEN** the tool appears in the catalog or config options response
- **THEN** the response SHALL include editability metadata and a stable lock reason

### Requirement: Inbox tool policy can be configured explicitly
The system SHALL allow an inbox owner to save an explicit tool allow-list for editable capabilities on the inbox's agent and MCP surfaces.

#### Scenario: Owner saves enabled tool ids
- **GIVEN** a verified user owns an AI inbox
- **WHEN** the user saves a set of enabled tool ids from the catalog
- **THEN** the system SHALL persist only registered and editable tool ids in the inbox's configuration
- **AND** future agent and MCP tool resolution SHALL use the saved policy

#### Scenario: Unknown tool id rejected
- **GIVEN** a client submits a tool id that is not registered in the backend catalog
- **WHEN** the system validates the inbox tool configuration
- **THEN** the system SHALL reject the update with a validation error

#### Scenario: Locked tool id rejected
- **GIVEN** a client submits a registered tool id that is locked or not editable for ordinary users
- **WHEN** the system validates the inbox tool configuration
- **THEN** the system SHALL reject the update with a validation error

#### Scenario: Disabled tool is unavailable at execution time
- **GIVEN** a tool is registered but not enabled for the effective inbox and agent profile
- **WHEN** an agent or MCP client attempts to execute that tool
- **THEN** the system SHALL reject the execution as unavailable for that inbox

### Requirement: User-facing default tool preset is explicit
The system SHALL write an explicit default tool policy when a user saves configuration, rather than relying on transitional empty-list semantics.

#### Scenario: First save writes explicit tool ids
- **GIVEN** a newly created user-owned inbox has no explicit tool allow-list
- **WHEN** the user saves the agent/tool configuration page
- **THEN** the system SHALL persist the selected built-in tool ids explicitly

#### Scenario: Send-mail tools remain locked
- **GIVEN** a tool sends external email
- **WHEN** ordinary user-owned inbox configuration options are generated
- **THEN** the system SHALL show the tool as locked or not editable
- **AND** the system SHALL NOT allow the ordinary user to enable that send-mail tool in Phase 2

### Requirement: MCP configuration exposure is read-only in Phase 2
The system SHALL NOT allow MCP clients to mutate inbox agent, tool, or safety configuration in this phase.

#### Scenario: MCP reads available tools under saved policy
- **GIVEN** an inbox has a saved tool policy
- **WHEN** an MCP client lists or executes tools for that inbox
- **THEN** the MCP surface SHALL reflect the saved policy

#### Scenario: MCP cannot write config
- **GIVEN** an MCP client requests a configuration mutation
- **WHEN** Phase 2 configuration is enforced
- **THEN** the system SHALL reject or omit mutation capabilities for inbox agent, tool, and safety configuration
