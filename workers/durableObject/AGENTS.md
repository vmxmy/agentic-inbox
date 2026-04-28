<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# durableObject

## Purpose
The `MailboxDO` Durable Object — one instance per mailbox address. Owns the SQLite database (via `drizzle/durable-sqlite`), exposes the email/folder/thread/search RPC surface that every other worker call funnels through, and runs schema migrations on first access.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `MailboxDO extends DurableObject` — RPC methods for folders (`getFolders`, `createFolder`, `updateFolder`, `deleteFolder`), emails (`getEmails`, `getEmail`, `createEmail`, `updateEmail`, `deleteEmail`, `moveEmail`, `getThreadedEmails`, `countThreadedEmails`, `findThreadBySubject`), threads (`getThreadEmails`, `getThreadEmailsLegacy`, `markThreadRead`), search (`searchEmails`, `countSearchResults`), attachments (`getAttachment`), rate-limit (`checkSendRateLimit`), rules (`listRules`, `replaceRules`, `getRuleHistory`), and **mailbox settings** (`getMailboxSettings`, `replaceMailboxSettings`, `updateMailboxSettings` — singleton `mailbox_settings` row owning autoDraft, system prompts, model overrides, enabled-skill allowlists, and invoiceSourceDomains after the PR 5/6 cutover). Exports `MailboxSettingsRow` / `MailboxSettingsInput` / `MailboxSettingsPatch` so worker callers can type the stub call sites. Includes the `NORMALIZED_SUBJECT_SQL` expression for subject-based threading and the safe-sort `SORT_COLUMN_MAP` keyed by an explicit `SortColumn` allowlist |
| `migrations.ts` | Custom migration runner replacing `workers-qb`'s `DOQB.migrations().apply()`. Records applied migrations in a `d1_migrations` table. Strips any `BEGIN`/`COMMIT` wrappers (DO runtime forbids SQL-level transactions) and uses `storage.transactionSync(...)` for atomicity. Defines `mailboxMigrations` — the canonical sequence of `Migration { name, sql }` records |

## For AI Agents

### Working In This Directory
- **One DO per mailbox.** Created via `env.MAILBOX.idFromName(mailboxId)`. Every row in this DO's database belongs to that mailbox by construction — never add a `mailbox_id` column.
- **Sort columns are allowlisted.** `ALLOWED_SORT_COLUMNS` + `SORT_COLUMN_MAP` map string names to typed Drizzle column references so callers cannot inject SQL via `?sortColumn=`. When adding a sortable field, extend both.
- **Threading uses `NORMALIZED_SUBJECT_SQL`.** It strips `Re:` / `Fwd:` / locale-specific prefixes (`Aw:`, `Wg:`, `Réf:`, `Sv:`) before grouping. Hardcoded to the `subject` column — if you reuse it, the column reference must remain identical.
- **Migrations are append-only.** Once a migration has been deployed, do not edit its `sql` field — write a new migration. The runner key is the `name` field; renaming a migration re-applies it.
- **No SQL transactions inside migrations.** The DO runtime rejects `BEGIN TRANSACTION`. Use the `storage.transactionSync(closure)` JS API instead — the runner handles this when a `DurableObjectStorage` is passed.
- **Rate limiting:** `checkSendRateLimit` returns a string error message (or `null`) — call it before every send/reply/forward path (see `workers/index.ts` and `workers/routes/reply-forward.ts`).
- **Subject-based fallback threading:** when an inbound email has neither `In-Reply-To` nor `References`, `findThreadBySubject` looks for an existing thread by normalised subject + sender. Useful for clients that drop the headers; do not remove without a deprecation plan.
- **Attachment metadata only.** This DO stores `attachments` rows but the actual bytes live in R2 at `attachments/<emailId>/<attachmentId>/<filename>`. Deleting an email returns the attachment metadata so the route handler can purge R2.

### Testing Requirements
- Schema/migration changes: delete `.wrangler/state/v3/` and replay inbound emails to confirm a fresh DO migrates cleanly.
- Sort/search changes: validate with `?sortColumn=invalid` to confirm the allowlist rejects unknown columns and falls back safely.
- Threading: send a reply without `In-Reply-To` and verify the subject-based fallback groups it correctly.

### Common Patterns
- Drizzle `eq`, `and`, `or`, `asc`, `desc`, `sql` for query construction. Prefer `sql.raw` only inside trusted, reviewed expressions like `NORMALIZED_SUBJECT_SQL`.
- All DO methods are async even when trivially synchronous — RPC requires awaitable shapes.
- The DO never imports from `app/`. The dependency direction is one-way: worker → DO → DB.

## Dependencies

### Internal
- `workers/db/schema.ts` — Drizzle table definitions
- `shared/folders.ts` — folder ID constants (used to seed default folders on first migration)
- `workers/types.ts` — `Env`

### External
- `cloudflare:workers` — `DurableObject`
- `drizzle-orm` 0.45 + `drizzle-orm/durable-sqlite`

<!-- MANUAL: -->
