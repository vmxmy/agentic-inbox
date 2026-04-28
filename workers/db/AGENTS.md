<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# db

## Purpose
Drizzle ORM schemas for two storage tiers:

1. **Per-mailbox SQLite** inside each `MailboxDO` — one database per mailbox instance (`schema.ts`).
2. **Global D1 control plane** at the worker layer (`auth-schema.ts`, `llm-schema.ts`, `mailbox-schema.ts`) — single shared database keyed by `env.DB`.

The two tiers use different migration runners. DO-internal migrations are applied by the in-process runner in `workers/durableObject/migrations.ts`. D1 migrations are SQL files under the repo-root `migrations/` directory, applied via `wrangler d1 migrations apply DB --local|--remote`.

## Key Files

| File | Description |
|------|-------------|
| `schema.ts` | DO-internal SQLite. Tables `folders` (id PK, name unique, `is_deletable` flag), `emails` (full message metadata + body + threading fields + raw headers), `attachments` (FK to `emails.id` with `onDelete: "cascade"`), `invoices` + `invoice_items` (parsed e-invoice records), `bundles` + `bundle_invoices` (reimbursement bundles), `rules` + `rule_history` (declarative inbox rules with row-level CAS) |
| `auth-schema.ts` | D1. Native auth — `users`, `sessions`, `email_tokens`, `api_keys`, `auth_rate_limits`. Backed by `migrations/0001_auth.sql`, `0002_api_keys.sql`, `0003_auth_rate_limits.sql` |
| `llm-schema.ts` | D1. `llm_providers` registry — at most one `is_default = 1` (partial unique index). Backed by `migrations/0004_llm_providers.sql` |
| `mailbox-schema.ts` | D1. `mailboxes` (id PK = lowercased email, owner_user_id FK to users, denormalized owner_email) + `mailbox_members` (composite PK `(mailbox_id, email)`, optional user_id FK). Shadow of the legacy R2 ACL blobs in `mailboxes/<id>.json`; PR 3 dual-writes, PR 4 will cut reads over. Backed by `migrations/0005_mailboxes.sql` |

## For AI Agents

### Working In This Directory
- **Schema changes require migrations — different runner per tier.**
  - **DO-internal SQLite (`schema.ts`):** add the `ALTER TABLE` / `CREATE INDEX` statement to `workers/durableObject/migrations.ts` and bump the migration list. The runner there records applied migrations in a `d1_migrations` table for backwards compatibility with deployments originally managed by `workers-qb`.
  - **Global D1 (`auth-schema.ts`, `llm-schema.ts`, `mailbox-schema.ts`):** add a numbered SQL file in repo-root `migrations/`. Apply locally with `pnpm wrangler d1 migrations apply DB --local`, remote with `... --remote`. The Drizzle table definition must match the SQL exactly — typegen does not auto-derive one from the other.
- **No `mailbox_id` column.** Per-mailbox isolation comes from each DO instance owning its own SQLite database. Adding a `mailbox_id` field is almost certainly wrong — review with a maintainer before doing it.
- **Snake_case columns** (`thread_id`, `email_references`, `in_reply_to`, `message_id`, `raw_headers`). The frontend type `Email` in `app/types/index.ts` mirrors these names directly — do not rename without updating both sides.
- **`email_references` stores JSON-serialised arrays** (the RFC 5322 References header), not relational rows. Parse with `JSON.parse` when reading.
- **Booleans are stored as `integer` 0/1** because SQLite has no real boolean type. Drizzle handles the conversion in queries; raw SQL must match this convention.
- **`raw_headers` stores `JSON.stringify(parsedEmail.headers)`** from `postal-mime`. Used for debugging and to preserve fidelity for forwarded messages.

### Testing Requirements
- After a schema change, run `npm run typecheck` — Drizzle's type inference will surface any consumer that needs updating in `workers/durableObject/index.ts`.
- Validate migrations by deleting `.wrangler/state/v3/` locally and replaying inbound emails to ensure a fresh DO comes up clean.

### Common Patterns
- Foreign keys with `onDelete: "cascade"` so deleting a folder removes its emails and deleting an email removes its attachments.
- All tables use `text("id").primaryKey()` (UUIDs assigned by the worker, not SQLite autoincrement).

## Dependencies

### Internal
- Consumed exclusively by `workers/durableObject/index.ts` (Drizzle queries) and indirectly by every shared tool function in `workers/lib/tools.ts`.

### External
- `drizzle-orm/sqlite-core` — `sqliteTable`, `text`, `integer`

<!-- MANUAL: -->
