<!-- Parent: ../AGENTS.md -->

# invoice-agent

## Purpose
The `InvoiceAgent` Durable Object — per-mailbox DO that owns the invoice domain. Two responsibilities:

1. **Auto-extraction** — triggered from `workers/index.ts:receiveEmail` via `ctx.waitUntil(INVOICE_AGENT.get(idFromName(mailboxId)).fetch("/onNewEmail", ...))` when a matched rule sets `action.extractInvoice`. The DO orchestrates the deterministic pipeline (detect format → parse XML/OFD → fetch links → OCR → save) by calling tools in `workers/lib/invoice-tools.ts`.
2. **Chat surface** — at `/agents/invoice-agent/<mailboxId>` for user queries about invoices and bundles (list/search invoices, create/manage reimbursement bundles, reprocess emails). Reuses the AIChatAgent base class so chat history, WebSocket transport, and the existing `/agents/*` ACL gate (`workers/app.ts:119-138`) work for free.

## Status

This directory is a **PR1 skeleton**. The class, binding (`INVOICE_AGENT`), and migration tag (`v4`) are wired so the runtime registers the DO, but behaviour is empty:
- `handleNewEmail` is a no-op (PR3 inlines the pipeline).
- `onChatMessage` returns 501 (PR4 wires the tool surface).

Follow-up PRs:

| PR | Scope |
|----|-------|
| PR2 | Extract `processEmailForInvoices` steps into `workers/lib/invoice-tools.ts` (pure functions, callable as agent tools); `receiveEmail` keeps calling the synchronous orchestrator unchanged. |
| PR3 | Switch `receiveEmail` to `ctx.waitUntil(INVOICE_AGENT.fetch("/onNewEmail"))`; `handleNewEmail` invokes the same tool sequence. Auto-extraction becomes async + isolated. |
| PR4 | Implement `onChatMessage` with the full tool set (extraction + invoice queries + bundle ops). Add `INVOICE_DEFAULT_SYSTEM_PROMPT`. Reuse `mailboxes/<id>.json:agentSystemPrompt` (per-mailbox override) — pending decision in PR4. |
| PR5 | Front-end `InvoicePanel` (clone of `AgentPanel` pointing at `/agents/invoice-agent/<mailboxId>`) on the invoices/bundles routes. |

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `InvoiceAgent extends AIChatAgent<any>` — `onRequest` intercepts `POST /onNewEmail` and forwards to `handleNewEmail`; otherwise delegates to the AIChatAgent default (chat WebSocket). Both methods are stubs in PR1. |

## For AI Agents

### Working In This Directory
- **`AIChatAgent` extends `Env` as `<any>`** intentionally — same workaround as `workers/agent/index.ts`. Keep this; the actual env stays fully typed inside method bodies via `this.env as Env`.
- **DO class name is migration-locked.** `wrangler.jsonc` declares `InvoiceAgent` under `v4: { new_sqlite_classes: [...] }`. Do not rename without adding a new migration tag.
- **`/onNewEmail` is the internal trigger.** It is reached only via DO RPC (`agentStub.fetch(...)`) from `workers/index.ts:receiveEmail`; the Worker-to-DO boundary is the trust boundary. No public HTTP path lands here.
- **Public chat path** is `/agents/invoice-agent/<mailboxId>`, gated by `workers/app.ts`'s `/agents/*` ACL middleware. Mailbox access is verified before the request reaches this DO — the DO itself does not re-check the JWT.
- **Tables stay in `MailboxDO`.** This DO writes invoices/bundles via `MailboxDO` RPC (`stub.saveInvoice`, `stub.createBundle`, ...). Do not add Drizzle tables here — invoices.* and bundles.* live in the mailbox SQLite by design.
- **Chat history lives in `this.ctx.storage`** (provided by `AIChatAgent`). No additional schema needed.

### Testing Requirements
- PR1: `npm run typecheck` must pass; the DO compiles and is registered in `wrangler.jsonc`. No runtime exercise yet.
- After PR3: deliver an inbound email with `action.extractInvoice` set by a matched rule, verify the auto-extraction runs in the background (`wrangler tail`) and writes invoices via `MailboxDO`.
- After PR4: open the InvoicePanel chat and exercise tool calls — `list_invoices`, `create_bundle`, `reprocess_invoices_for_email`.

## Dependencies

### Internal (planned)
- `workers/lib/invoice-tools.ts` (PR2) — extraction + bundle tool implementations
- `workers/lib/email-helpers.ts` — `getMailboxStub(env, mailboxId)` to call `MailboxDO` RPC
- `workers/lib/agent-config.ts` — per-mailbox model + system prompt (PR4)
- `shared/folders.ts` — folder constants (rarely needed here)

### External
- `@cloudflare/ai-chat` — `AIChatAgent` base class
- `ai` v6 + `workers-ai-provider` (PR4) — model + streaming
- `zod` (PR4) — tool input schemas

<!-- MANUAL: -->
