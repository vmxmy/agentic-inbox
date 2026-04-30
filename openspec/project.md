<!--
Copyright (c) 2026 Cloudflare, Inc.
Licensed under the Apache 2.0 license found in the LICENSE file or at:
    https://opensource.org/licenses/Apache-2.0
-->

# Project Context

## Purpose

Agentic Inbox is a Cloudflare-native, email-native AI inbox platform.

The product lets a human user create multiple independent AI inboxes under a
Cloudflare-managed root domain. Each inbox has its own email address, durable
mail/session state, scoped agent behavior, tool permissions, attachments, and
artifacts.

The first product route is a user-owned AI inbox creation flow:

```text
User -> generated username -> many inboxes -> username.subname@root-domain
```

The first concrete workflow template is reimbursement/invoice handling, but the
architecture must remain a generic inbox platform.

## Tech Stack

- TypeScript
- React 19
- React Router 7
- Vite
- Tailwind CSS 4
- Cloudflare Workers
- Hono
- Cloudflare Email Routing / Email Workers
- Cloudflare Email Service `send_email`
- Cloudflare Durable Objects with SQLite
- Cloudflare R2-backed mailbox/settings control plane (current official baseline)
- Cloudflare R2
- Cloudflare Workers AI / provider registry
- Cloudflare Agents SDK
- MCP server/client integrations
- Drizzle ORM
- Zod
- TanStack Query
- Zustand
- TipTap rich text editor
- Vitest for tests in the fork

## Project Conventions

### Code Style

- TypeScript-first.
- Preserve Cloudflare Apache 2.0 headers when editing files.
- Use tabs for indentation where existing files use tabs.
- Prefer named exports except React route components where default exports are
  required by React Router.
- Validate request boundaries with Zod.
- Keep TanStack Query keys centralized in `app/queries/keys.ts`.
- Do not add unrelated refactors to feature work.
- Do not revert user or pre-existing working tree changes.

### Architecture Patterns

- Cloudflare is the platform premise. Do not design default flows that require
  non-Cloudflare email infrastructure.
- The Worker is the external trust boundary.
- Current official-baseline control-plane metadata is R2-backed; future D1/address-registry migration remains possible but is not present today.
- Durable Objects own inbox-local serialized state.
- R2 stores attachment bytes and large artifacts.
- MCP and capabilities are governed tool surfaces, not unrestricted plugin
  execution.
- Email Routing should use a catch-all Worker path for dynamic inbox addresses.
- User-created addresses are governed by application state, not by per-inbox
  Cloudflare dashboard routes.
- Ordinary users can create only `username.subname@root-domain` addresses.
- `username` is generated from verified login identity.
- `subname` is user-entered ASCII address text.
- `display_name` and `subname` are separate.
- Multiple entity inboxes are a core product object, not labels in one inbox.
- Current `mailboxId = full email address` is transitional.
- Future target is `address_registry -> inbox_id -> InboxDO/MailboxDO`.

### Testing Strategy

- Run `npm run typecheck` before declaring worker changes complete.
- Run available compile/build verification when touching auth, MCP, migrations, or helpers; add focused tests/verification files where no test runner exists.
- Run `npm run build` for frontend/runtime build validation.
- For Cloudflare config changes, run `wrangler types` or `npm run typecheck`.
- For inbound email flows, test locally with `wrangler email dev` where
  possible, and document manual verification gaps.
- New product-model helpers should include unit tests for validation,
  derivation, permissions, and routing behavior.

### Git Workflow

- Use worktrees for isolated feature/baseline work.
- Prefer branch prefix `codex/` for new branches.
- Keep commits small and coherent.
- Do not amend commits unless explicitly requested.
- Do not use destructive git commands unless explicitly approved.
- Preserve local dirty work; unrelated changes should be ignored, not reverted.

## Domain Context

The product should be understood in two languages:

User-facing language:

- AI Inbox
- dedicated email address
- work emails
- attachments
- drafts
- outputs

Architecture language:

- user-owned inbox entity
- address registry
- durable work context
- capability registry
- scoped agent
- artifact plane
- control plane

The product is not a generic Gmail clone. It is an agentic email workflow
platform. Labels and email attributes are useful inside an inbox, but they do
not replace inbox entities.

## Important Constraints

- All design must fit Cloudflare Agents Week / Agentic Cloud architecture.
- Receiving email depends on Cloudflare Email Routing and Email Workers.
- Sending email depends on Cloudflare Email Service.
- Production access must fail closed.
- Dynamic user inboxes should not require per-inbox Cloudflare Email Routing
  rules.
- Unknown inbound addresses must not auto-create inboxes.
- Ordinary users must not claim global short aliases such as `finance@` or
  `support@`.
- Multi-tenant features are deferred, but the architecture must preserve
  multi-tenant seams.
- Do not let invoice-specific workflow code become the whole platform model.

## External Dependencies

- Cloudflare account and zone
- Cloudflare Email Routing
- Cloudflare Email Service
- Cloudflare Workers
- Cloudflare Durable Objects
- Cloudflare R2-backed mailbox/settings control plane (current official baseline)
- Cloudflare R2
- Cloudflare Workers AI / AI Gateway-compatible model routing
- Cloudflare Agents SDK
- External MCP servers for optional integrations

