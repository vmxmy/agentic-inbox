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

### Requirement: Inbox tool policy can be configured explicitly
The system SHALL allow an inbox owner to save an explicit tool allow-list for the inbox's agent and MCP surfaces.

#### Scenario: Owner saves enabled tool ids
- **GIVEN** a verified user owns an AI inbox
- **WHEN** the user saves a set of enabled tool ids from the catalog
- **THEN** the system SHALL persist only registered tool ids in the inbox's configuration
- **AND** future agent and MCP tool resolution SHALL use the saved policy

#### Scenario: Unknown tool id rejected
- **GIVEN** a client submits a tool id that is not registered in the backend catalog
- **WHEN** the system validates the inbox tool configuration
- **THEN** the system SHALL reject the update with a validation error

#### Scenario: Disabled tool is unavailable at execution time
- **GIVEN** a tool is registered but not enabled for the effective inbox and agent profile
- **WHEN** an agent or MCP client attempts to execute that tool
- **THEN** the system SHALL reject the execution as unavailable for that inbox

### Requirement: User-facing default tool preset is explicit
The system SHALL write an explicit default tool policy when a user saves configuration, rather than relying on transitional empty-list semantics.

#### Scenario: First save writes explicit tool ids
- **GIVEN** a legacy or newly created inbox has no explicit tool allow-list
- **WHEN** the user saves the agent/tool configuration page
- **THEN** the system SHALL persist the selected built-in tool ids explicitly

#### Scenario: Send-mail tools remain opt-in
- **GIVEN** a tool sends external email
- **WHEN** the default user-facing tool preset is generated
- **THEN** the system SHALL NOT enable that send-mail tool unless the product flow explicitly asks the user to opt in
