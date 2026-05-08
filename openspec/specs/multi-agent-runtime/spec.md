# multi-agent-runtime Specification

## Purpose
TBD - created by archiving change add-inbox-agent-tool-framework. Update Purpose after archive.
## Requirements
### Requirement: Agent profile abstraction
The system SHALL define agent behavior through an agent profile containing identity, display metadata, prompt configuration, model configuration when supported, automation policy, and enabled tool identifiers.

#### Scenario: Default agent profile preserves existing behavior
- **GIVEN** an inbox profile does not select a custom agent profile
- **WHEN** the agent runtime is invoked for that inbox
- **THEN** the system SHALL use the default email agent profile
- **AND** the resulting behavior SHALL remain compatible with the official baseline email agent behavior

#### Scenario: Custom agent profile is selected
- **GIVEN** an inbox profile references a configured agent profile
- **WHEN** the agent runtime is invoked for that inbox
- **THEN** the system SHALL apply that agent profile's configured behavior
- **AND** the system SHALL use that profile when resolving available tools

#### Scenario: OpenAI-compatible provider supplies the default model
- **GIVEN** the runtime environment configures an OpenAI-compatible LLM base URL and default model
- **AND** an inbox uses the default agent profile without pinning a custom model
- **WHEN** the agent runtime selects the inference model
- **THEN** the system SHALL use the configured default OpenAI-compatible model for agent inference
- **AND** the system SHALL fall back to the Workers AI default model when the OpenAI-compatible base URL is not configured

#### Scenario: Custom agent profile model is preserved
- **GIVEN** an inbox uses an agent profile with a custom model identifier
- **AND** the runtime environment configures a default OpenAI-compatible model
- **WHEN** the agent runtime selects the inference model
- **THEN** the system SHALL preserve the agent profile's custom model identifier instead of replacing it with the environment default

#### Scenario: Safety checks use the configured provider
- **GIVEN** the runtime environment configures an OpenAI-compatible LLM base URL
- **WHEN** the system performs prompt-injection scanning or draft verification
- **THEN** the system SHALL use the configured OpenAI-compatible safety model when present
- **AND** the system SHALL use the configured default OpenAI-compatible model when no dedicated safety model is present
- **AND** the system SHALL fall back to the original Workers AI safety models when the OpenAI-compatible base URL is not configured

### Requirement: Inbox agent behavior is resolved before execution
The system SHALL resolve the effective agent profile for an inbox before constructing prompts, tools, or automation behavior.

#### Scenario: Agent invocation receives resolved behavior
- **GIVEN** an inbox profile and an inbound automation event
- **WHEN** the system invokes the agent runtime
- **THEN** the runtime SHALL receive the resolved agent profile
- **AND** the runtime SHALL NOT infer agent behavior from unrelated global state

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

### Requirement: Profile-based agents remain compatible with EmailAgent
The system SHALL use the existing EmailAgent runtime as the first executor for agent profiles in this change.

#### Scenario: Default profile executes through EmailAgent
- **GIVEN** an inbox uses the default email agent profile
- **WHEN** the system performs agent automation for that inbox
- **THEN** the system SHALL execute the automation through EmailAgent
- **AND** the system SHALL NOT require a new Durable Object class for the default profile

### Requirement: Agent runtime restores MCP connections with credential injection
When the agent runtime initialises an existing MCP connection that has a `server_config_json` with a known `providerType`, the system SHALL resolve and inject credentials before reconnecting, without requiring the user to re-authorise.

#### Scenario: Credential injection on runtime restore
- **WHEN** the Durable Object wakes up and restores persisted MCP connections
- **AND** a connection has `providerType: "google-contacts"` with platform credentials available
- **THEN** the system SHALL inject the resolved credentials into `MailboxBoundOAuthProvider`
- **AND** the connection SHALL reach `ready` state without triggering a new OAuth redirect

