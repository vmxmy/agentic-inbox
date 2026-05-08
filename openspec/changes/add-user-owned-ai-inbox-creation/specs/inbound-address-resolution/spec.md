## ADDED Requirements

### Requirement: Inbound recipient resolves through application state
The system SHALL resolve inbound Cloudflare Email Routing recipients through application-owned control-plane state before persisting mail.

#### Scenario: Known recipient accepted
- **WHEN** an inbound email recipient matches an active AI inbox address in application state
- **THEN** the system persists the email to the target inbox

#### Scenario: Unknown recipient rejected
- **WHEN** an inbound email recipient does not match an active AI inbox address or configured fixed mailbox
- **THEN** the system rejects or refuses to persist the email according to the configured unknown-recipient policy

#### Scenario: Inbound email does not auto-create inbox
- **WHEN** an inbound email is addressed to a syntactically valid but unregistered `username.subname@root-domain` address
- **THEN** the system does not create a new inbox

### Requirement: Fixed mailbox mode remains compatible
The system SHALL preserve compatibility with explicitly configured fixed mailbox addresses.

#### Scenario: Configured fixed mailbox accepted
- **WHEN** `EMAIL_ADDRESSES` contains a recipient address and inbound email is sent to that address
- **THEN** the system may route the email using the existing fixed mailbox mode

#### Scenario: Fixed mailbox mode does not grant dynamic namespace
- **WHEN** `EMAIL_ADDRESSES` is configured and inbound email targets an unconfigured dynamic user address
- **THEN** the system does not treat that address as valid solely because the domain is configured

### Requirement: Root domain is validated
The system SHALL validate that inbound recipients belong to a configured root domain before resolving the local part.

#### Scenario: Configured domain accepted
- **WHEN** an inbound recipient belongs to the selected configured root domain
- **THEN** the system attempts application-state resolution for the local part

#### Scenario: Unconfigured domain rejected
- **WHEN** an inbound recipient belongs to an unconfigured domain
- **THEN** the system rejects or refuses to persist the email

### Requirement: Address resolution is centralized
The system SHALL centralize inbound address resolution so future address registry and stable inbox id migration can replace the transitional lookup.

#### Scenario: Resolver returns target mailbox identity
- **WHEN** an active recipient address is resolved
- **THEN** the resolver returns the target mailbox or inbox identity used by the persistence layer

#### Scenario: Resolver can evolve without changing email parsing
- **WHEN** future implementation changes from `mailboxId = full email` to `address -> inbox_id`
- **THEN** the email parsing entrypoint can keep calling the centralized resolver contract

