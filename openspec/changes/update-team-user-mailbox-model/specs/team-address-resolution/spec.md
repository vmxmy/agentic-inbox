## ADDED Requirements

### Requirement: Team address registry
The system SHALL persist every active team primary and team-user address in application-owned control-plane state.

#### Scenario: Team primary address registered
- **WHEN** an admin creates a team
- **THEN** the system stores an active address registry record for `teamName@root-domain`

#### Scenario: Team user address registered
- **WHEN** an admin creates a team user
- **THEN** the system stores an active address registry record for `teamName.userName@root-domain`

### Requirement: Inbound recipient resolves through team address registry
The system SHALL resolve inbound Cloudflare Email Routing recipients through the team address registry before persisting mail.

#### Scenario: Known team primary recipient accepted
- **WHEN** inbound email targets an active team primary address
- **THEN** the system resolves the recipient to that team's mailbox identity
- **AND** the system persists the email to the target mailbox

#### Scenario: Known team user recipient accepted
- **WHEN** inbound email targets an active team-user address
- **THEN** the system resolves the recipient to that user's mailbox identity
- **AND** the system persists the email to the target mailbox

#### Scenario: Unknown recipient rejected
- **WHEN** inbound email targets an address that is not active in the team address registry and is not a supported legacy fixed mailbox
- **THEN** the system rejects or refuses to persist the email according to the unknown-recipient policy

#### Scenario: Address syntax alone does not create records
- **WHEN** inbound email targets a syntactically valid but unregistered `team.user@root-domain` address
- **THEN** the system does not create a team, user, mailbox, or address registry record

### Requirement: Configured root domain is enforced
The system SHALL resolve team/user addresses only for configured root domains.

#### Scenario: Configured domain accepted
- **WHEN** an inbound recipient belongs to the selected configured root domain
- **THEN** the system attempts address-registry resolution

#### Scenario: Unconfigured domain rejected
- **WHEN** an inbound recipient belongs to an unconfigured domain
- **THEN** the system rejects or refuses to persist the email

### Requirement: Address resolution is centralized
The system SHALL centralize address resolution for inbound email, API mailbox access, MCP tools, and agent routing.

#### Scenario: Resolver returns mailbox identity
- **WHEN** a known team-managed address is resolved
- **THEN** the resolver returns the mailbox identity used by `MailboxDO` and agent routing

#### Scenario: Future inbox id migration remains possible
- **WHEN** a future implementation changes from `mailboxId = full email` to `address -> inbox_id`
- **THEN** callers can continue using the centralized resolver contract without re-parsing addresses

### Requirement: Legacy fixed mailbox compatibility
The system SHALL preserve explicitly supported legacy/fixed mailbox addresses during migration.

#### Scenario: Configured legacy fixed mailbox accepted
- **WHEN** a recipient matches an explicitly configured fixed mailbox address that exists in legacy mailbox state
- **THEN** the system may route the email using the legacy mailbox path

#### Scenario: Fixed mailbox mode does not grant team namespace
- **WHEN** a recipient has a configured domain but is absent from the team address registry
- **THEN** the system does not treat that recipient as valid solely because the domain is configured
