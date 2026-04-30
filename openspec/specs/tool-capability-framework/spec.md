# tool-capability-framework Specification

## Purpose
TBD - created by archiving change add-inbox-agent-tool-framework. Update Purpose after archive.
## Requirements
### Requirement: Tool capability descriptor
The system SHALL define each agent-accessible or MCP-accessible operation as a tool capability descriptor with stable identifier, name, description, input schema, optional output schema, supported surfaces, permission metadata, and executor binding.

#### Scenario: Existing email operation is registered
- **GIVEN** an existing email operation is available to the current agent implementation
- **WHEN** the worker initializes built-in capabilities
- **THEN** the operation SHALL be registered as a tool capability
- **AND** the agent SHALL discover the operation through the tool registry

### Requirement: Tool registry resolves capabilities by context
The system SHALL resolve available tool capabilities using the current inbox profile, effective agent profile, requested surface, and execution context.

#### Scenario: Surface-supported tool is returned
- **GIVEN** a registered tool supports the requested surface
- **AND** the effective inbox and agent profiles enable the tool
- **WHEN** the runtime requests available tools for that surface
- **THEN** the registry SHALL return that tool capability

#### Scenario: Surface-unsupported tool is filtered out
- **GIVEN** a registered tool does not support the requested surface
- **WHEN** the runtime requests available tools for that surface
- **THEN** the registry SHALL NOT return that tool capability

### Requirement: Tool execution receives explicit context
The system SHALL execute every tool with an explicit execution context containing inbox identity, canonical inbox address, effective agent profile identity, request identity, caller identity when available, and Cloudflare environment bindings.

#### Scenario: Tool executes with inbox context
- **GIVEN** a tool is invoked for a resolved inbox
- **WHEN** the tool executor runs
- **THEN** the executor SHALL receive the resolved inbox context
- **AND** the executor SHALL use that context for inbox-local state access

#### Scenario: Tool execution avoids implicit global identity
- **GIVEN** a tool executor needs mailbox or agent identity
- **WHEN** the executor runs
- **THEN** the executor SHALL use the provided execution context
- **AND** the executor SHALL NOT derive identity from unrelated global state

### Requirement: Agent tool surface uses registry
The system SHALL construct the agent runtime's tools from registered capabilities that support the agent surface and are enabled for the effective inbox and agent profile.

#### Scenario: Agent receives filtered tools
- **GIVEN** multiple tools are registered
- **WHEN** the agent runtime constructs its available tools
- **THEN** the runtime SHALL receive only tools that are enabled for the inbox, enabled for the agent profile, and declared for the agent surface

### Requirement: MCP tool surface uses registry
The system SHALL construct MCP tool listings and execution handlers from registered capabilities that support the MCP surface and are enabled for the effective inbox and agent profile.

#### Scenario: MCP lists only MCP-enabled tools
- **GIVEN** one registered tool supports only the agent surface
- **AND** another registered tool supports the MCP surface
- **WHEN** an MCP client requests available tools
- **THEN** the MCP server SHALL list only tools enabled for the MCP surface and current context

#### Scenario: MCP cannot execute hidden tool
- **GIVEN** a registered tool is not available to the MCP surface for the current context
- **WHEN** an MCP client attempts to execute that tool
- **THEN** the MCP server SHALL reject the execution request

### Requirement: Tool availability is deny-by-default
The system SHALL deny tool availability unless the tool is registered, supports the requested surface, and is enabled by the effective profile configuration.

#### Scenario: Unregistered tool is unavailable
- **GIVEN** a tool identifier is not registered in the tool capability registry
- **WHEN** an agent or MCP client requests that tool
- **THEN** the system SHALL treat the tool as unavailable

#### Scenario: Registered but not enabled tool is unavailable
- **GIVEN** a tool identifier is registered
- **AND** the effective profile configuration does not enable the tool
- **WHEN** an agent or MCP client requests that tool
- **THEN** the system SHALL treat the tool as unavailable

