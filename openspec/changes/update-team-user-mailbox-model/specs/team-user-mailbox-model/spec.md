## ADDED Requirements

### Requirement: Admin creates teams
The system SHALL allow only global admins to create teams with a normalized team name and display name.

#### Scenario: Admin creates team
- **WHEN** a global admin submits a valid team name and display name
- **THEN** the system creates a team record
- **AND** the system derives the team primary mailbox address from the team name and configured root domain

#### Scenario: Non-admin cannot create team
- **WHEN** a non-admin submits a create-team request
- **THEN** the system rejects the request with an authorization error

#### Scenario: Duplicate team rejected
- **WHEN** an admin submits a team name already used by an active team
- **THEN** the system rejects the request with a conflict error

### Requirement: Team primary mailbox is provisioned
The system SHALL provision a mailbox for each created team's primary address.

#### Scenario: Team mailbox seeded
- **WHEN** a team is created successfully
- **THEN** the system creates or activates a mailbox directory record for `teamName@root-domain`
- **AND** the mailbox can be opened by authorized team users and admins

#### Scenario: Team display name is separate from address name
- **WHEN** an admin creates a team with display name `Finance Ops` and team name `finance`
- **THEN** the system stores `Finance Ops` for display
- **AND** the system derives the address from `finance`, not from the display name

### Requirement: Admin creates team users
The system SHALL allow only global admins to create users under a selected team.

#### Scenario: Admin creates team user
- **WHEN** a global admin submits a valid user name and display name for an existing team
- **THEN** the system creates or links a user account for that team user
- **AND** the system derives the user mailbox address as `teamName.userName@root-domain`

#### Scenario: Non-admin cannot create team user
- **WHEN** a non-admin submits a create-team-user request
- **THEN** the system rejects the request with an authorization error

#### Scenario: Duplicate team user rejected within team
- **WHEN** an admin submits a user name already used under the same active team
- **THEN** the system rejects the request with a conflict error

### Requirement: Address components are validated
The system SHALL validate team names and team user names before deriving email addresses.

#### Scenario: Valid address components accepted
- **WHEN** an admin submits lowercase ASCII team and user names that meet length and shape rules
- **THEN** the system accepts the names and stores normalized values

#### Scenario: Invalid address component rejected
- **WHEN** an admin submits a team or user name with unsupported characters, leading separators, trailing separators, repeated separators, or invalid length
- **THEN** the system rejects the request with a user-readable validation error

#### Scenario: Reserved names rejected
- **WHEN** an admin submits a reserved team or user name such as `admin`, `api`, `mcp`, `auth`, or `system`
- **THEN** the system rejects the request with a user-readable validation error

### Requirement: Ordinary users cannot self-create mailboxes
The system SHALL prevent ordinary users from creating arbitrary mailbox addresses in team/user mode.

#### Scenario: Self-serve mailbox creation denied
- **WHEN** an ordinary authenticated user calls the mailbox creation endpoint
- **THEN** the system rejects the request and instructs the user to ask an admin to create a team or user

#### Scenario: Client cannot override derived address
- **WHEN** a client submits a full email address while creating a team or team user
- **THEN** the system ignores or rejects the client-supplied address and uses the server-derived address

### Requirement: Team-derived access
The system SHALL derive mailbox access for team-managed mailboxes from team state.

#### Scenario: Team user accesses team primary mailbox
- **WHEN** a team user opens their team's primary mailbox
- **THEN** the system grants read/write mailbox access

#### Scenario: Team user accesses own mailbox
- **WHEN** a team user opens their own `teamName.userName@root-domain` mailbox
- **THEN** the system grants read/write mailbox access

#### Scenario: Team user cannot access another team by default
- **WHEN** a team user opens a mailbox for another active team
- **THEN** the system rejects the request with an authorization error

#### Scenario: Global admin accesses team mailboxes
- **WHEN** a global admin opens any active team-managed mailbox
- **THEN** the system grants access

### Requirement: Legacy mailbox compatibility
The system SHALL keep existing owner/member mailbox records usable while team-managed records are introduced.

#### Scenario: Legacy mailbox remains accessible
- **WHEN** a user has access to an existing mailbox that lacks team metadata
- **THEN** the system evaluates access using the existing owner/member ACL

#### Scenario: Team-managed mailbox does not require manual owner
- **WHEN** a mailbox is created for a team or team user
- **THEN** the system does not require ordinary owner/member editing for normal access
