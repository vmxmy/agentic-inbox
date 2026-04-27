# PR 1 Auth Context Implementation Plan

Updated: 2026-04-27

## Purpose

This document turns `PR 1 - MCP auth context contract` from
`docs/architecture-first-wave-checklist.md`
into a code-level implementation plan.

Although the roadmap names MCP explicitly, the implementation should treat this
as a shared internal auth-context upgrade for both:

- `/mcp`
- `/agents/*`

That is the safer cut because both surfaces currently use the same underlying
pattern:

- Hono authenticates the caller
- Hono forwards partial caller context into a Durable Object
- the DO reconstructs user context again

Fixing only MCP would leave the same design debt in the agent surface.

## Problem Statement

The current internal caller-context propagation is incomplete.

Today:

- Hono authenticates the user in `workers/app.ts`
- `/mcp` strips client-supplied `INTERNAL_USER_HEADER` and injects only
  `user.email`
- `/agents/*` does the same for the agent DO path
- the DO then rehydrates caller role by doing a D1 lookup via `findUserByEmail`

This causes three issues:

1. The internal contract is implicit and underspecified
2. Durable Objects have to re-resolve auth from partial identity
3. Role/system semantics still depend on reconstruction instead of transport

The current code already includes a partial mitigation:

- `workers/mcp/index.ts` looks up `currentUserRole` from D1
- `workers/agent/index.ts` looks up `currentUser` from D1

That patch helps, but it is still not the final design we want.

## Primary Goal

Replace the email-only internal identity propagation model with a signed,
explicit internal auth context that preserves:

- user id
- email
- role
- system flag
- issuance metadata

The same auth context envelope should be used by:

- MCP DO
- EmailAgent DO
- InvoiceAgent DO

## Non-Goals

This PR should not:

- migrate mailbox ACL out of R2
- change user-facing auth flows
- add OAuth for MCP
- change capability permission rules
- add approvals or workflows

Keep the cut narrow: transport contract only.

## Current State

### Entry-point auth resolution

`workers/app.ts`

The Worker resolves authenticated user context from:

1. internal system header
2. dev override
3. bearer API key
4. cookie session
5. Access JWT fallback

The result is stored in `c.var.user`.

### Internal forwarding today

`workers/app.ts`

- `/mcp` forwards `INTERNAL_USER_HEADER = user.email`
- `/agents/*` forwards `INTERNAL_USER_HEADER = user.email`

### Durable Object rehydration today

`workers/mcp/index.ts`

- reads `INTERNAL_USER_HEADER`
- normalizes email
- resolves role by `findUserByEmail(...)`
- constructs synthetic `AuthUser`

`workers/agent/index.ts`

- reads `INTERNAL_USER_HEADER`
- normalizes email
- resolves full user by `findUserByEmail(...)`
- stores result in `currentUser`

### Why this is still not ideal

- DO identity depends on D1 lookup even though Hono already had the full user
- system callers cannot use the same envelope shape cleanly
- the transport contract is "some header with an email", not "verified internal auth context"
- every new DO surface will be tempted to repeat the same pattern

## Proposed Design

## New Internal Contract

Introduce a signed internal auth-context token transported in a dedicated
header.

Suggested header:

- `x-internal-auth-context`

Retire or deprecate:

- `x-internal-user-email`

The auth-context token payload should contain:

- `sub`: user id
- `email`: normalized email
- `role`: `"user" | "admin"`
- `system`: boolean
- `aud`: internal audience string
- `iat`: issued-at timestamp
- `exp`: short expiration timestamp

Suggested audience values:

- `"internal-do-auth"`

Suggested expiry:

- 60 seconds

That is short enough for internal handoff and long enough for the Hono -> DO
request path.

## Signing Strategy

Use `env.INTERNAL_SECRET` as the signing key for this PR.

Reason:

- already present
- already used for internal trust and invite signing
- avoids introducing a second secret in the same PR

Future refinement:

- split into a dedicated internal auth-context secret if desired

## Shared Helpers

Add helper functions to `workers/lib/auth.ts`:

- `serializeInternalAuthContext(user: AuthUser, env: Env): Promise<string>`
- `parseInternalAuthContext(token: string, env: Env): Promise<AuthUser>`
- `readInternalAuthContextHeader(request: Request, env: Env): Promise<AuthUser | null>`

Optional helper:

- `buildInternalAuthHeaders(user: AuthUser, env: Env, headers?: HeadersInit): Promise<Headers>`

This keeps all internal identity envelope logic in one place.

## File-by-File Implementation Plan

## 1. `workers/lib/auth.ts`

### Add new constants

Add:

- `INTERNAL_AUTH_CONTEXT_HEADER = "x-internal-auth-context"`
- internal audience constant, for example:
  - `INTERNAL_AUTH_AUDIENCE = "internal-do-auth"`
  - `INTERNAL_AUTH_ISSUER = "agentic-inbox"`

Keep:

- `INTERNAL_SYSTEM_HEADER`

Deprecate:

- `INTERNAL_USER_HEADER`

Do not remove `INTERNAL_USER_HEADER` until all call sites are migrated in this
PR. Remove it at the end if there are no remaining consumers.

### Add JWT payload type

Suggested internal type:

```ts
interface InternalAuthClaims {
	sub: string;
	email: string;
	role: "user" | "admin";
	system?: boolean;
	aud: string;
	iss: string;
	iat: number;
	exp: number;
}
```

### Add signing helper

Implementation sketch:

- normalize email before signing
- set `sub`, `email`, `role`, `system`
- set `aud`
- set `iat`
- set short `exp`

Use `SignJWT` from `jose`, which is already imported in this file.

### Add verification helper

Implementation sketch:

- reject if `INTERNAL_SECRET` is absent
- verify JWT with `jwtVerify`
- validate payload fields
- return `AuthUser`

Hard failure behavior:

- malformed or unverifiable token should resolve to `null` or throw a typed
  auth error depending on the call site

Recommendation:

- shared parser throws
- higher-level request reader returns `null`

### Add request reader

This helper should:

- read `INTERNAL_AUTH_CONTEXT_HEADER`
- return `null` if missing
- parse and verify if present
- return `AuthUser`

### Keep `getUserFromRequest(...)` unchanged

This PR does not need to change the main Hono auth flow. `getUserFromRequest`
can remain the legacy helper for Hono-side request contexts.

## 2. `workers/app.ts`

### Update imports

Replace `INTERNAL_USER_HEADER` usage with new helpers/constants from
`workers/lib/auth.ts`.

### Update `forwardToMcp(...)`

Current behavior:

- delete user-email header
- set user-email header

New behavior:

- delete old internal auth headers
- mint signed internal auth token from `c.var.user`
- set `INTERNAL_AUTH_CONTEXT_HEADER`

Implementation shape:

```ts
const headers = new Headers(c.req.raw.headers);
headers.delete(INTERNAL_AUTH_CONTEXT_HEADER);
const token = await serializeInternalAuthContext(user, c.env);
headers.set(INTERNAL_AUTH_CONTEXT_HEADER, token);
```

Optional cleanup:

- also delete `INTERNAL_USER_HEADER` while the old header still exists, to
  prevent mixed-mode requests during rollout

### Update `/agents/*` forwarding

Do the same signed auth-context injection for `routeAgentRequest(...)`.

This is the key extension beyond "MCP-only" work. It removes the same design
debt from the agent surfaces in the same PR.

### Do not change inbound `email(...)` flow

`receiveEmail -> EmailAgent /onNewEmail` should keep using
`INTERNAL_SYSTEM_HEADER`.

Reason:

- system-triggered paths are semantically different from end-user requests
- they do not originate from an authenticated operator session

## 3. `workers/mcp/index.ts`

### Remove D1 rehydration dependency for request auth

Current behavior:

- stores `currentUserEmail`
- stores `currentUserRole`
- runs `findUserByEmail(...)` in `fetch()`

New behavior:

- store `currentUser: AuthUser | null`
- decode verified internal auth context in `fetch()`
- no D1 lookup in `fetch()`

Suggested field:

```ts
private currentUser: AuthUser | null = null;
```

### Update `fetch(request)`

Implementation sketch:

- `this.currentUser = await readInternalAuthContextHeader(request, this.env)`
- no email-only parsing
- no `findUserByEmail(...)`

### Update `currentUser()` closure in `init()`

Current behavior:

- reconstructs synthetic `AuthUser`

New behavior:

- return `this.currentUser`

### Remove obsolete imports

Likely removable:

- `INTERNAL_USER_HEADER`
- `normalizeEmail`
- `findUserByEmail`

Keep only what the file still needs.

## 4. `workers/agent/index.ts`

### Remove D1 rehydration dependency for request auth

Current behavior:

- reads email header
- rehydrates full user via `findUserByEmail(...)`

New behavior:

- reads signed auth context
- stores `currentUser: AuthUser | null` directly

### Update imports

Replace:

- `INTERNAL_USER_HEADER`
- `normalizeEmail`
- `findUserByEmail`

With:

- `readInternalAuthContextHeader`

### Update `fetch(request)`

Implementation sketch:

```ts
override async fetch(request: Request): Promise<Response> {
	this.currentUser = await readInternalAuthContextHeader(request, this.env as Env);
	return super.fetch(request);
}
```

### Keep `handleNewEmail(...)` semantics unchanged

System-triggered paths should still have `currentUser = null`.

That is desirable:

- auto-draft does not become an operator
- owner-only capability gates remain denied for system-triggered flows

## 5. `workers/mcp/AGENTS.md`

Update directory guidance to reflect the new internal auth-context model.

Current text still says:

- authenticated user comes from `INTERNAL_USER_HEADER`

New text should say:

- authenticated user comes from a signed internal auth-context header
- never trust any client-supplied value without Hono-layer replacement

## 6. `workers/AGENTS.md` and `workers/lib/AGENTS.md`

Update any trust-boundary notes that explicitly describe:

- MCP receives only user email
- Agent DOs receive only email via internal header

These should now describe the signed auth-context envelope.

## API and Type Surface Decisions

## Decision 1: Reuse `AuthUser` as the decoded shape

Recommendation:

- yes

Reason:

- no need for a second user shape at the internal DO boundary
- keeps downstream ACL and capability checks unchanged

## Decision 2: Include `system` in the signed auth context

Recommendation:

- yes

Reason:

- future internal DO surfaces may need to distinguish system and non-system
- preserves semantics without a second transport path

Note:

- this PR should still keep the separate `INTERNAL_SYSTEM_HEADER` path for
  worker-to-worker system calls that do not originate from Hono-authenticated
  user requests

## Decision 3: Keep synthetic MCP ids or transport real ids

Recommendation:

- transport real ids

Reason:

- the Hono layer already knows the real user id
- synthetic ids were only a workaround for the email-only header contract
- real ids improve auditability and future scope mapping

## Decision 4: Should this PR update `/agents/*` too?

Recommendation:

- yes

Reason:

- same trust-boundary issue
- same current reconstruction pattern
- avoids two successive migrations for the same concept

## Rollout Strategy

Use a single-PR cutover rather than a long mixed-mode rollout.

Suggested sequence inside the PR:

1. add shared auth-context helpers
2. update Hono forwarding for `/mcp`
3. update Hono forwarding for `/agents/*`
4. update MCP DO fetch logic
5. update Agent DO fetch logic
6. update docs/comments
7. remove now-unused old header-based logic

Mixed compatibility support is not necessary unless there is an external
runtime dependency on the old internal header, which there should not be.

## Testing Plan

## Minimal automated coverage to add

If tests are practical in this repo, add narrow unit-level coverage for:

- signing and verifying internal auth context
- invalid token rejection
- expired token rejection
- round-trip preservation of:
  - id
  - email
  - role
  - system

Good candidate location:

- `workers/lib/auth` tests if/when such a test module exists

If adding tests in this PR is too much overhead, document the gap and rely on
manual verification plus typecheck.

### Decision (2026-04-27)

The repo currently has no test runner (no `vitest` / `jest` / `playwright`
in `package.json`). Adding test infrastructure is out of scope for this PR's
"transport contract only" cut. Automated coverage for the new internal
auth-context envelope is deferred to a follow-up PR that introduces vitest
(plus `@cloudflare/vitest-pool-workers` for the DO ingress paths).

Follow-up coverage to land in that PR:

- `serializeInternalAuthContext` → `parseInternalAuthContext` round-trip
  preserves `id`, `email`, `role`, `system`
- malformed token → `parseInternalAuthContext` throws `AuthzError(401)`,
  `readInternalAuthContextHeader` returns `null`
- expired token (manipulate `Date.now()` or set `exp` in the past) is
  rejected
- forged `aud`/`iss` tokens are rejected
- request-path smoke: one happy-path request to `/mcp` and one to
  `/agents/<class>/<mailbox>` mints a token Hono → DO and the DO observes
  the decoded user

Tracked in `docs/architecture-first-wave-checklist.md`.

## Manual Verification Checklist

- [ ] normal user opens MCP and only sees allowed mailboxes
- [ ] admin opens MCP and sees admin-level mailbox visibility
- [ ] owner-only MCP operation still works for owner
- [ ] owner-only MCP operation is denied for non-owner non-admin
- [ ] agent chat still works from the UI
- [ ] owner-only capability gating through agent tools still respects admin role
- [ ] auto-draft on inbound email still works

## Commands to Run

- `npm run typecheck`
- `npm run verify` if the local environment is green
- `npm run dev`
- manual MCP/client validation
- `wrangler email dev` for inbound auto-draft smoke test

## Expected Diff Shape

Files expected to change:

- `workers/lib/auth.ts`
- `workers/app.ts`
- `workers/mcp/index.ts`
- `workers/agent/index.ts`
- `workers/mcp/AGENTS.md`
- `workers/AGENTS.md`
- `workers/lib/AGENTS.md`
- optionally `workers/types.ts` if comments/type notes need alignment

Files that should not need behavior changes:

- `workers/index.ts`
- mailbox ACL logic
- rules engine
- auth route handlers
- frontend UI

## Acceptance Criteria

- internal DO-facing auth transport carries full verified user semantics
- MCP no longer depends on D1 role rehydration in `fetch()`
- Agent DO no longer depends on D1 user rehydration in `fetch()`
- admin/system semantics are preserved across Worker -> DO boundaries
- system-triggered auto-draft behavior remains unchanged

## Risks and Mitigations

### Risk: token verification failures break MCP and agent chat

Mitigation:

- keep helper logic centralized
- test both `/mcp` and `/agents/*` in the same PR

### Risk: system-triggered paths accidentally start requiring user auth context

Mitigation:

- do not route `onNewEmail` through the new auth context
- keep `INTERNAL_SYSTEM_HEADER` semantics intact

### Risk: doc drift after behavior changes

Mitigation:

- update the relevant `AGENTS.md` files in the same PR

## Definition of Done

- [ ] full internal auth-context helpers are implemented
- [ ] `/mcp` uses signed auth context instead of email-only forwarding
- [ ] `/agents/*` uses signed auth context instead of email-only forwarding
- [ ] MCP DO stops doing D1 rehydration for request auth
- [ ] Agent DO stops doing D1 rehydration for request auth
- [ ] manual verification covers MCP, agent chat, and auto-draft
- [ ] docs/comments for these trust boundaries are updated
