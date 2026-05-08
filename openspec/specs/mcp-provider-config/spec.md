# mcp-provider-config Specification

## Purpose
TBD - created by archiving change add-mcp-flexible-config. Update Purpose after archive.
## Requirements
### Requirement: MCP connection stores flexible provider configuration
The system SHALL persist a `server_config_json` column on each MCP connection row containing non-sensitive, provider-specific metadata as a JSON object. The column SHALL be nullable; a NULL value is equivalent to `{ "providerType": "generic" }`.

#### Scenario: Connection created with provider config
- **WHEN** a mailbox owner adds an MCP connection with a `serverConfig` payload
- **THEN** the system SHALL validate and store the payload in `server_config_json`
- **AND** the stored value SHALL be retrievable on subsequent reads of the connection

#### Scenario: Connection created without provider config
- **WHEN** a mailbox owner adds an MCP connection without a `serverConfig` payload
- **THEN** the system SHALL store NULL in `server_config_json`
- **AND** the connection SHALL behave as a generic provider

#### Scenario: Unknown provider type is accepted
- **WHEN** a `serverConfig` payload contains a `providerType` not in the known set
- **THEN** the system SHALL accept and store it
- **AND** the system SHALL treat the connection as a generic provider for credential resolution

### Requirement: MCP connection supports enterprise BYOC credential override
The system SHALL persist an `enterprise_credentials_encrypted_json` column on each MCP connection row. When non-NULL, this encrypted blob provides per-connection OAuth credentials (clientId, clientSecret, and optional provider-specific fields) that override any platform-level credentials.

#### Scenario: Enterprise credentials stored encrypted
- **WHEN** a mailbox owner submits enterprise OAuth credentials for a connection
- **THEN** the system SHALL encrypt the full credentials JSON using the existing three-layer key envelope
- **AND** the system SHALL store the ciphertext, IV, salt, and envelope version in the column
- **AND** the plaintext credentials SHALL NOT be persisted anywhere

#### Scenario: Enterprise credentials override platform credentials
- **WHEN** a connection has non-NULL `enterprise_credentials_encrypted_json`
- **AND** the runtime resolves OAuth credentials for that connection
- **THEN** the system SHALL decrypt and use the enterprise credentials
- **AND** platform-level credentials SHALL be ignored for this connection

#### Scenario: Null enterprise credentials fall through to platform
- **WHEN** a connection has NULL `enterprise_credentials_encrypted_json`
- **AND** the runtime resolves OAuth credentials for that connection
- **THEN** the system SHALL attempt to resolve platform-level credentials

### Requirement: API accepts provider config and enterprise credentials at connection creation
The `POST /api/v1/mailboxes/:mailboxId/mcp-connections` endpoint SHALL accept optional `serverConfig` and `enterpriseCredentials` fields in the request body.

#### Scenario: serverConfig field is validated at write time
- **WHEN** a request body includes a `serverConfig` object
- **THEN** the system SHALL validate it against the provider config schema (Zod discriminated union on `providerType`)
- **AND** SHALL reject unknown top-level keys that conflict with the schema
- **AND** SHALL pass through additional unknown keys as opaque metadata

#### Scenario: enterpriseCredentials requires KEK to be configured
- **WHEN** a request body includes an `enterpriseCredentials` object
- **AND** the environment does not have a Key Encryption Key configured
- **THEN** the system SHALL return HTTP 503 with `enterprise_credentials_feature_disabled`

