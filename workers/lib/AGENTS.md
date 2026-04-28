<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# lib

## Purpose
Worker-side shared library — the support layer between Hono route handlers and the Durable Objects. Contains authorisation, the mailbox middleware, agent configuration, the rule engine, AI security helpers, attachment storage, the email/threading helpers, the canonical request/response Zod schemas, and the tool implementations reused by both the Agent and MCP surfaces.

## Key Files

| File | Description |
|------|-------------|
| `auth.ts` | Per-mailbox ACL layer + internal auth-context envelope. `AuthUser`, `MailboxAcl`, `getUserFromRequest` (decodes Access JWT, honours `INTERNAL_SYSTEM_HEADER` + `DEV_USER_HEADER`), `assertMailboxAccess`, `assertMailboxOwner`, `addMailboxMember`/`removeMailboxMember`, `getMailboxAcl`, `listUserMailboxes`, `isAdmin(env, user)`, `signInviteToken`/`verifyInviteToken` (HS256 via `jose`), `normalizeEmail`, `AuthzError(status, message)`. Internal auth-context helpers: `serializeInternalAuthContext(user, env)` mints a short-lived HS256 JWT carrying `{id, email, role, system?}`; `parseInternalAuthContext(token, env)` verifies and decodes; `readInternalAuthContextHeader(request, env)` reads + verifies the header and returns null on miss/invalid. Defines `INTERNAL_AUTH_CONTEXT_HEADER`, `INTERNAL_SYSTEM_HEADER`, `DEV_USER_HEADER`. The legacy `INTERNAL_USER_HEADER` constant is retained, marked `@deprecated`, and stripped at the Worker boundary so no DO consumer reads it. ACL **reads** (`getMailboxAcl`, `assertMailboxAccess`, `assertMailboxOwner`, `listUserMailboxes`) hit D1 mailbox-directory first; un-backfilled legacy mailboxes are read from R2 and self-healed back into D1. ACL **writes** (`claimMailbox`, `addMailboxMember`, `removeMailboxMember`, `setMailboxOwner`) still dual-write to both R2 and D1 |
| `mailbox-directory.ts` | D1-backed shadow of the R2 ACL blobs (PR 3 control-plane). Reads: `getMailboxRecord`, `listMailboxMembers`, `listMailboxIdsForUser`, `listAllMailboxRecords`. Writes: `upsertMailboxRecord`, `deleteMailboxRecord`, `addMemberRecord`, `removeMemberRecord`, `replaceMembersRecord`. Maintenance: `reconcileUserIds` backfills `user_id` columns once an invited email registers. All writes log-and-swallow on D1 failure so an R2-side ACL op never breaks; the admin endpoint `POST /api/v1/admin/mailbox-directory/backfill` reconciles drift |
| `mailbox.ts` | Hono `requireMailbox` middleware — decodes `:mailboxId`, resolves the user (defensively if upstream did not), runs `assertMailboxAccess`, then attaches a `MailboxDO` stub to `c.var.mailboxStub`. Exports `MailboxContext` for typed handler signatures |
| `agent-config.ts` | Per-mailbox agent config. After PR 5/6 the source of truth is the MailboxDO `mailbox_settings` singleton row (autoDraft, agent/emailReply/invoice model overrides, system prompts, enabled-skills allowlists, invoiceSourceDomains). `getAgentConfig` reads DO-first via `getMailboxSettings()`; on miss, falls back once to the legacy R2 blob, logs a WARN, and self-heals the DO via `replaceMailboxSettings`. `updateAgentConfig` writes exclusively through `updateMailboxSettings` — R2 is no longer mutated for agent-config fields. `setRules` continues to mutate R2 because rules already have their own D1-backed store + mirror. `autoDraft` defaults true for legacy mailboxes (NULL on the DO row → coalesce true). Exports `DEFAULT_AGENT_MODEL`, `FALLBACK_AGENT_MODEL`, `resolveInvoiceSourceDomains`, `AgentConfig`, `AgentConfigUpdate` |
| `rules.ts` | Declarative rule engine v1. Zod schemas (`RuleConditionSchema`, `RuleActionSchema`, `RuleSchema`), `parseRulesLoose(settings)`, and `evaluateRules(rules, facts) → { action, matchedName }`. Conditions: `from`, `fromDomain`, `to`, `subjectContains[]`, `bodyContains[]`, `hasAttachmentExt[]`. Actions: `skipDraft`, `moveTo`, `markRead`, `promptOverride`, `extractAttachmentText` |
| `attachments.ts` | `storeAttachments(bucket, emailId, attachments[])` — base64-decodes inputs and writes to R2 at `attachments/<emailId>/<attachmentId>/<filename>`. Returns `StoredAttachment[]` ready for `MailboxDO.createEmail` |
| `attachment-extract.ts` | Inline attachment text extraction for rule actions. Phase 1 (current): synchronous XML extraction (UTF-8 with GBK fallback for Chinese 全电发票). Phase 2 (planned): PDF OCR via deferred webhook. Exports `extensionOf(filename)`, `extractAttachmentsInline(attachments)` |
| `ai.ts` | AI-powered security/quality helpers — `isPromptInjection(ai, body)` (prompt-injection scanner gate before auto-draft) and `verifyDraft(ai, draftBody)` (strips agent meta-commentary from inline drafts) |
| `email-helpers.ts` | Cross-cutting helpers — `getMailboxStub(env, id)`, `listMailboxes(bucket)`, `validateSender` + `SenderValidationError`, `generateMessageId(domain)`, `buildReferencesChain`, `buildThreadingHeaders`, `resolveOriginalEmail`, `getFullEmail`/`getFullThread`, `stripHtmlToText`, `textToHtml`, `formatEmailDate` |
| `schemas.ts` | Shared Zod schemas + TypeScript types — `EmailMetadata`, `EmailFull`, `AttachmentInfo`, `SendEmailRequestSchema`, etc. Single source of truth for request/response shapes used by routes and tools |
| `tools.ts` | Implementation of every email tool (list/get/get_thread/search/draft_reply/draft_email/update_draft/delete_email/send_reply/send_email/mark_read/move/discard_draft). Same module powers both `EmailAgent` and `EmailMCP` so the two surfaces stay aligned |
| `invoice-tools.ts` | Invoice + reimbursement-bundle tool wrappers consumed by `InvoiceAgent` (auto-extract in PR3, chat tool surface in PR4). Same `(env, mailboxId, params)` style as `tools.ts`. `toolProcessEmailInvoices` is the orchestration entrypoint — resolves allowed domains, delegates to `MailboxDO.reprocessInvoicesForEmail` (the canonical pipeline entrypoint shared with the existing reprocess path). MCP invoice/bundle tools intentionally stay wired directly to MailboxDO RPC for backwards compatibility |

## For AI Agents

### Working In This Directory
- **Auth invariants:**
  - `__system__` user (set by `INTERNAL_SYSTEM_HEADER === env.INTERNAL_SECRET`) bypasses ACL — used for the inbound-email → auto-draft path. Never expose this header to user-facing code paths.
  - `DEV_USER_HEADER` is honoured **only** when `import.meta.env.DEV` is true. Production bypass is impossible by construction; do not relax this.
  - `assertMailboxAccess` performs claim-on-first-access for legacy mailboxes that pre-date the ACL feature — keep this behaviour to avoid breaking existing deployments.
- **Tool implementations are reused by Agent + MCP.** Add new tools here first; consumers wrap the result. Returning `{ error: string }` is the contract for "expected" failures (agent surfaces it, MCP marks `isError: true`).
- **Rule schemas are strict (`.strict()`).** Adding a new condition/action requires updating the schema, the evaluator, the runtime applier in `workers/index.ts:receiveEmail`, and the Settings UI.
- **Allowed models live in `ALLOWED_AGENT_MODELS`** — if you add one, also add it to the Settings dropdown. `coerceModel` falls back to `DEFAULT_AGENT_MODEL` for unknown values.
- **`SendEmailRequestSchema`** is the gatekeeper for outbound sends/replies/forwards. Validate every send path through it.
- **HTML helpers split by environment:** `email-helpers.ts:stripHtmlToText` runs on the worker (regex-based, no DOM). The browser counterpart lives in `app/lib/utils.ts` and uses DOMPurify + DOM. Do not import the worker version from `app/` or vice versa.
- **Invite tokens** are signed HS256 JWTs with claims `{ mbx, by, exp }`. Issuer must still be the mailbox owner at acceptance time — re-checked in `workers/index.ts:/api/v1/invites/accept`.

### Testing Requirements
- `npm run typecheck` — Zod schemas and Drizzle stubs feed back into route signatures.
- For ACL changes, exercise: owner-only writes (member POST/DELETE, mailbox DELETE, invite issue), member reads, non-member 403, admin overrides via `ADMINS` env var.
- For rule changes: craft an inbound email matching multiple rules and confirm only the first applies (top-down evaluation).

### Common Patterns
- All exported errors extend or use `AuthzError(status, message)` so route handlers can do `if (e instanceof AuthzError) return c.json({ error: e.message }, e.status)`.
- Functions take `env: Env` first, then narrow params. Avoid relying on `globalThis`.
- Mailbox IDs are normalised to lowercase via `normalizeEmail` before any R2 lookup or DO `idFromName` call.

## Dependencies

### Internal
- `workers/durableObject/*` — `MailboxDO` stub type
- `workers/types.ts` — `Env`
- `workers/email-sender.ts` — used by `tools.ts` for send paths
- `shared/folders.ts`, `shared/dates.ts`

### External
- `hono` — `Context`, `createMiddleware`
- `jose` — JWT decode/sign/verify
- `zod` — schema validation
- `drizzle-orm` (transitively, via DO stub types)

<!-- MANUAL: -->
