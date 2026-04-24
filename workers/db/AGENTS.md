<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# db

## Purpose
Drizzle ORM schema for the per-mailbox SQLite database that lives inside each `MailboxDO`. Three tables: `folders`, `emails`, `attachments`. There is one database **per mailbox** (one DO instance per mailbox), so every row is implicitly scoped — the schema does not include a `mailbox_id` column.

## Key Files

| File | Description |
|------|-------------|
| `schema.ts` | Drizzle table definitions for `folders` (id PK, name unique, `is_deletable` flag), `emails` (full message metadata + body + threading fields + raw headers), and `attachments` (foreign-keyed to `emails.id` with `onDelete: "cascade"`) |

## For AI Agents

### Working In This Directory
- **Schema changes require migrations.** Edit `workers/durableObject/migrations.ts` to add the `ALTER TABLE` / `CREATE INDEX` statement and bump the migration list. The minimal runner there records applied migrations in a `d1_migrations` table for backwards compatibility with deployments that were originally managed by `workers-qb`.
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
