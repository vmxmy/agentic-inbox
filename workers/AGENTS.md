<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# workers

## Purpose
Cloudflare Workers backend. Hosts the Hono API + React Router SSR (`app.ts`), three Durable Object classes (`MailboxDO`, `EmailAgent`, `EmailMCP`), and an inbound email handler. Cloudflare Access JWT validation gates every HTTP request outside DEV, and a per-mailbox ACL gates DO-level access.

## Key Files

| File | Description |
|------|-------------|
| `app.ts` | Worker entrypoint exported as default. Hono app with Access middleware → MCP forwarding → API routes (`./index`) → Agents WebSocket routing → React Router SSR catch-all. Also exports `MailboxDO`, `EmailAgent`, `EmailMCP` for the runtime, and provides the `email` handler for inbound delivery |
| `index.ts` | All `/api/v1/*` routes — config, whoami, mailbox CRUD + ACL, invites, admin, emails (list/send/draft), threads, reply/forward, folders, search, attachments, **and** the `receiveEmail` function that ingests inbound mail, runs rule evaluation (`lib/rules`), and triggers auto-draft via `EMAIL_AGENT` |
| `types.ts` | `Env` interface — extends `Cloudflare.Env` (from wrangler typegen) with `POLICY_AUD` and `TEAM_DOMAIN` Access secrets |
| `email-sender.ts` | Thin wrapper around the `send_email` binding (`env.EMAIL.send`). Accepts our `SendEmailParams` shape (to/from/cc/bcc/html/text/attachments/replyTo/headers) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `agent/` | `EmailAgent` Durable Object — `AIChatAgent` subclass with 9 email tools, prompt-injection guard, auto-draft pipeline (see `agent/AGENTS.md`) |
| `db/` | Drizzle ORM schema for the per-mailbox SQLite database (`folders`, `emails`, `attachments`) (see `db/AGENTS.md`) |
| `durableObject/` | `MailboxDO` Durable Object — owns the SQLite database, exposes the email/folder/thread/search RPC surface, plus the migration runner (see `durableObject/AGENTS.md`) |
| `lib/` | Shared utilities — auth/ACL, mailbox middleware, email helpers, attachments, AI security, rules engine, agent config, schemas, tool implementations (see `lib/AGENTS.md`) |
| `mcp/` | `EmailMCP` Durable Object — exposes the same tool surface over Model Context Protocol at `/mcp` (see `mcp/AGENTS.md`) |
| `routes/` | Route handlers extracted from `index.ts` — currently `reply-forward.ts` (see `routes/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **Three trust layers:** (1) auth middleware in `app.ts` resolves identity from cookie session / Bearer API key / Access JWT fallback, (2) `getUserFromRequest` returns the resolved user (or `__system__` for internal calls), (3) `assertMailboxAccess` / `assertMailboxOwner` checks the per-mailbox ACL — now sourced from the D1 mailbox-directory tables (`mailboxes`, `mailbox_members`), with R2 `mailboxes/<id>.json` as a self-healing fallback for un-backfilled legacy mailboxes. New mutating endpoints **must** call one of the assertions.
- **Class names matter to migrations.** `wrangler.jsonc` declares `MailboxDO` (v1), `EmailAgent` (v2), `EmailMCP` (v3) as `new_sqlite_classes`. Do not rename without an additional migration tag.
- **Inbound email is asynchronous.** The `email` handler in `app.ts` calls `receiveEmail` and re-throws on failure so Cloudflare retries. Auto-draft runs via `ctx.waitUntil(...)` — do not await it from the email path.
- **MCP and `/agents/*` receive the user via a signed internal auth-context JWT.** `app.ts` strips any client-supplied `INTERNAL_AUTH_CONTEXT_HEADER` (and the legacy email-only `INTERNAL_USER_HEADER`) and re-injects a fresh token carrying the full `{id, email, role, system?}` so DOs can enforce ACL — including admin-only paths — without re-validating auth or round-tripping D1 to recover role. Token is HS256, audience-bound (`internal-do-auth`), 60s TTL.
- **Worker-to-worker auto-draft** sets `INTERNAL_SYSTEM_HEADER: env.INTERNAL_SECRET`. Never log this header value.
- All files use **tabs**.

### Testing Requirements
- `npm run typecheck` runs `wrangler types` then `tsc -b` — required before commit.
- Local: `npm run dev` (React Router + wrangler) plus `wrangler email dev` for inbound mail.
- For MCP: connect from Claude Code / Cursor pointing at the deployed `/mcp` endpoint (Access-protected — use a service token in CI).

### Common Patterns
- Hono context generic: `Context<MailboxContext>` for any handler under `/api/v1/mailboxes/:mailboxId/*` — gives typed `c.var.mailboxStub` and `c.var.user`.
- Drizzle queries inside the DO use `eq`, `and`, `or`, `asc`, `desc`, `sql` from `drizzle-orm`. Sort columns must be looked up via `SORT_COLUMN_MAP` — never interpolate column names into SQL.
- Tool functions live in `lib/tools.ts` and are imported by both `agent/index.ts` and `mcp/index.ts` so the two surfaces stay in lock-step.
- Folder IDs come from `shared/folders.ts:Folders` — do not hardcode `"inbox"` etc. in handlers.

## Dependencies

### Internal
- `shared/folders.ts`, `shared/dates.ts` — cross-stack constants and date formatting

### External
- `hono` 4 — request routing
- `agents` (Cloudflare Agents SDK) — Durable Object base for `EmailAgent` and `EmailMCP`
- `@cloudflare/ai-chat` — `AIChatAgent` base class (chat history persistence, WebSocket transport)
- `ai` 6 + `workers-ai-provider` — AI SDK + Workers AI provider (model `@cf/moonshotai/kimi-k2.5`)
- `@modelcontextprotocol/sdk` — MCP server primitives
- `drizzle-orm` 0.45 + `drizzle-orm/durable-sqlite` — SQLite query builder for the DO
- `postal-mime` — inbound MIME parsing
- `jose` — Access JWT verification + HS256 invite-token signing
- `zod` — schema validation
- `cloudflare:workers` — `DurableObject` base class

<!-- MANUAL: -->
