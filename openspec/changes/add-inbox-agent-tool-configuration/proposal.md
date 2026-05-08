# Change: Configure agent, tools, and safety per AI inbox

## Why

Phase 1 created the core product object: a verified human user can create
multiple AI inboxes with dedicated `username.subname@root-domain` addresses.
Those inboxes are valuable only if each one can behave differently: a
reimbursement inbox, sales inbox, support inbox, and personal assistant inbox
need different instructions, tools, and safety posture.

The code already contains the lower-level runtime seams: `InboxProfile`,
`AgentProfile`, a tool capability registry, model provider resolution, and
safety-model abstraction. What is missing is the product-facing control plane
and UI that let an inbox owner safely configure those seams without editing raw
R2 settings or trusting client-submitted routing metadata.

## What Changes

- Add a product-facing inbox agent configuration API for reading and updating
  the current user's owned inbox configuration.
- Extend settings persistence additively in existing R2 mailbox settings rather
  than introducing D1 in this slice.
- Let an inbox owner configure agent display metadata, system prompt, model
  preference, and inbound auto-draft behavior.
- Let an inbox owner configure enabled tool ids using the existing tool
  capability registry and explicit permission metadata.
- Add a tool catalog API so the frontend can render stable tool names,
  descriptions, surfaces, and risk labels from the backend registry.
- Add a safety policy model for prompt-injection scanning and draft verification
  so safety behavior is explicit and inspectable per inbox.
- Update the inbox settings page from a raw prompt textarea into a structured
  product UI: Agent, Tools, and Safety sections.
- Preserve legacy mailbox compatibility and existing raw mailbox settings
  behavior where needed, but do not let the new config endpoint modify
  server-owned identity/routing fields.

## What Does Not Change

- No D1 or new global database in this slice.
- No custom agent marketplace, external tool installation, or arbitrary code
  execution.
- No new Durable Object class for agent profiles; `EmailAgent` remains the
  first executor.
- No stable `inbox_id` migration; `mailboxId = full email address` remains the
  transitional key.
- No admin/global alias management.
- No organization/team multi-tenancy.

## Impact

- Affected specs:
  - `multi-agent-runtime`
  - `tool-capability-framework`
  - `multi-inbox-runtime`
- Affected frontend:
  - `app/routes/settings.tsx`
  - `app/services/api.ts`
  - `app/queries/mailboxes.ts`
  - `app/types/index.ts`
  - possibly small shared UI helpers/components
- Affected worker/API:
  - `workers/index.ts`
  - `workers/lib/agent-profile.ts`
  - `workers/lib/inbox-profile.ts`
  - `workers/lib/tool-capabilities.ts`
  - `workers/agent/index.ts`
  - optional new helper module such as `workers/lib/inbox-agent-config.ts`
- Affected data:
  - additive fields in existing `mailboxes/<address>.json` R2 settings
  - no destructive migration required
- Verification:
  - OpenSpec validation
  - typecheck and build
  - focused helper verification for config validation/persistence
  - browser E2E for changing config and seeing it reload
  - runtime verification that disabled auto-draft and disabled tools are honored
