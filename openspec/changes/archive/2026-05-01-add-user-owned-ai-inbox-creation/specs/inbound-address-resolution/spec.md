## ADDED Requirements

### Requirement: Inbound recipient resolves through registered inbox state
The system SHALL resolve inbound Cloudflare Email Routing recipients through registered inbox state before persisting mail.

#### Scenario: Known user-owned recipient accepted
- **WHEN** an inbound email recipient matches an active user-owned inbox address stored in R2 mailbox settings
- **THEN** the system SHALL persist the email to the target inbox

#### Scenario: Unknown recipient rejected
- **WHEN** an inbound email recipient does not match an active AI inbox address or configured fixed mailbox
- **THEN** the system SHALL reject or refuse to persist the email according to the configured unknown-recipient policy

#### Scenario: Inbound email does not auto-create inbox
- **WHEN** an inbound email is addressed to a syntactically valid but unregistered `username.subname@root-domain` address
- **THEN** the system SHALL NOT create a new inbox

### Requirement: Fixed mailbox mode remains compatible
The system SHALL preserve compatibility with explicitly configured fixed mailbox addresses.

#### Scenario: Configured fixed mailbox accepted
- **WHEN** `EMAIL_ADDRESSES` contains a recipient address and inbound email is sent to that address
- **THEN** the system MAY route the email using the existing fixed mailbox mode

#### Scenario: Fixed mailbox mode does not grant dynamic namespace
- **WHEN** `EMAIL_ADDRESSES` is configured and inbound email targets an unconfigured dynamic user address
- **THEN** the system SHALL NOT treat that address as valid solely because the domain is configured

### Requirement: Root domain is validated for user-owned addresses
The system SHALL validate that user-owned inbound recipients belong to a configured root domain before resolving the local part.

#### Scenario: Configured domain accepted
- **WHEN** an inbound recipient belongs to a configured root domain
- **THEN** the system SHALL attempt registered inbox resolution for the full address

#### Scenario: Unconfigured domain rejected
- **WHEN** an inbound recipient belongs to an unconfigured domain
- **THEN** the system SHALL reject or refuse to persist the email

### Requirement: Address resolution remains centralized
The system SHALL keep inbound address resolution centralized so future address registry and stable inbox id migration can replace the transitional lookup.

#### Scenario: Resolver returns target mailbox identity
- **WHEN** an active recipient address is resolved
- **THEN** the resolver SHALL return the target mailbox or inbox identity used by the persistence layer

#### Scenario: Resolver can evolve without changing email parsing
- **WHEN** future implementation changes from `mailboxId = full email` to `address -> inbox_id`
- **THEN** the email parsing entrypoint SHALL keep calling the centralized resolver contract
