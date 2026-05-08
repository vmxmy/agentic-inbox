## ADDED Requirements

### Requirement: Platform resolves OAuth credentials before initiating MCP Authorization flow
The system SHALL implement a credential resolution layer consulted before every `addMcpServer` OAuth call. Resolution SHALL follow a strict priority order: (1) per-connection enterprise credentials, (2) platform-level Workers Secrets, (3) error.

#### Scenario: Platform credentials resolve for known provider
- **WHEN** a connection has `providerType: "google-contacts"` in `server_config_json`
- **AND** `GOOGLE_CONTACTS_CLIENT_ID` and `GOOGLE_CONTACTS_CLIENT_SECRET` are present in the Workers environment
- **AND** the connection has NULL `enterprise_credentials_encrypted_json`
- **THEN** the system SHALL inject the platform credentials into the OAuth provider before initiating the MCP Authorization flow
- **AND** the end user SHALL NOT be prompted to enter credentials

#### Scenario: Missing platform credentials for known provider raises error
- **WHEN** a connection has `providerType: "google-contacts"` in `server_config_json`
- **AND** `GOOGLE_CONTACTS_CLIENT_ID` is absent from the Workers environment
- **AND** the connection has NULL `enterprise_credentials_encrypted_json`
- **THEN** the system SHALL throw `ProviderCredentialsNotConfiguredError`
- **AND** the connection attempt SHALL fail with a descriptive error surfaced to the UI

#### Scenario: Generic provider skips platform credential lookup
- **WHEN** a connection has `providerType: "generic"` or NULL `server_config_json`
- **THEN** the system SHALL skip the platform credential lookup
- **AND** the MCP Authorization flow SHALL proceed using whatever credentials the MCP server negotiates (e.g., Dynamic Client Registration)

### Requirement: Platform credential naming follows a deterministic convention
Workers Secrets for provider credentials SHALL follow the pattern `{PROVIDER_SCREAMING_SNAKE}_CLIENT_ID` and `{PROVIDER_SCREAMING_SNAKE}_CLIENT_SECRET`. The mapping from `providerType` to env-var prefix SHALL be defined in a static registry in the worker.

#### Scenario: providerType maps to env-var prefix
- **WHEN** the system resolves credentials for `providerType: "google-contacts"`
- **THEN** it SHALL look up `GOOGLE_CONTACTS_CLIENT_ID` and `GOOGLE_CONTACTS_CLIENT_SECRET`

#### Scenario: providerType maps to env-var prefix for Microsoft
- **WHEN** the system resolves credentials for `providerType: "microsoft-graph"`
- **THEN** it SHALL look up `MICROSOFT_GRAPH_CLIENT_ID` and `MICROSOFT_GRAPH_CLIENT_SECRET`
- **AND** optionally `MICROSOFT_GRAPH_TENANT_ID`

### Requirement: Scopes are sourced from server_config_json
When platform or enterprise credentials are used, the OAuth scopes requested SHALL be read from the `scopes` field of `server_config_json` rather than hardcoded in the worker.

#### Scenario: Scopes from config are passed to OAuth flow
- **WHEN** `server_config_json` contains `"scopes": ["contacts.readonly", "userinfo.profile"]`
- **THEN** the system SHALL request exactly those scopes during the OAuth Authorization flow
- **AND** no additional scopes SHALL be appended automatically

#### Scenario: Missing scopes field uses provider default
- **WHEN** `server_config_json` does not contain a `scopes` field
- **AND** the provider type has a known default scope set in the registry
- **THEN** the system SHALL use the provider's default scopes
