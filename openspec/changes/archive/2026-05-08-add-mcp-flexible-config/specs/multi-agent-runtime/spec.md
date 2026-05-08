## MODIFIED Requirements

### Requirement: Agent profiles control tool availability
The system SHALL make only the tools enabled by the effective agent profile available to the agent runtime. External MCP tools from connected servers SHALL be included in the available tool set after credential resolution confirms the connection is authorized.

#### Scenario: Enabled tool is available to agent
- **WHEN** a tool is registered in the tool capability registry
- **AND** the effective agent profile enables that tool identifier
- **WHEN** the agent runtime builds its tool list
- **THEN** the tool SHALL be available to the agent if the tool also supports the agent surface

#### Scenario: Disabled tool is hidden from agent
- **GIVEN** a tool is registered in the tool capability registry
- **AND** the effective agent profile does not enable that tool identifier
- **WHEN** the agent runtime builds its tool list
- **THEN** the tool SHALL NOT be available to the agent

#### Scenario: External MCP server tools are included after credential resolution
- **GIVEN** a mailbox has a connected MCP server with a configured `providerType`
- **AND** credential resolution succeeds (platform or enterprise credentials found)
- **WHEN** the agent runtime calls `addMcpServer` for that connection
- **THEN** the tools published by that server SHALL be available to the agent
- **AND** the agent SHALL NOT be required to re-authenticate during the session

#### Scenario: External MCP server tools are excluded when credentials are missing
- **GIVEN** a mailbox has a connected MCP server with a configured `providerType`
- **AND** credential resolution fails (no platform secrets, no enterprise credentials)
- **WHEN** the agent runtime attempts to call `addMcpServer` for that connection
- **THEN** the system SHALL log a `ProviderCredentialsNotConfiguredError`
- **AND** the connection SHALL be skipped rather than crashing the agent run
- **AND** all other tools SHALL remain available

## ADDED Requirements

### Requirement: Agent runtime restores MCP connections with credential injection
When the agent runtime initialises an existing MCP connection that has a `server_config_json` with a known `providerType`, the system SHALL resolve and inject credentials before reconnecting, without requiring the user to re-authorise.

#### Scenario: Credential injection on runtime restore
- **WHEN** the Durable Object wakes up and restores persisted MCP connections
- **AND** a connection has `providerType: "google-contacts"` with platform credentials available
- **THEN** the system SHALL inject the resolved credentials into `MailboxBoundOAuthProvider`
- **AND** the connection SHALL reach `ready` state without triggering a new OAuth redirect
