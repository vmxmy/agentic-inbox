<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# routes

## Purpose
Route handlers extracted from `workers/index.ts` that warranted their own files. Currently scoped to reply / forward — both are wide enough (sender resolution, threading-chain construction, draft cleanup, attachment storage, sent-folder bookkeeping) that inlining them in `index.ts` would balloon the file.

## Key Files

| File | Description |
|------|-------------|
| `reply-forward.ts` | `handleReplyEmail(c)` and `handleForwardEmail(c)` — Hono handlers wired into `workers/index.ts` at `POST /api/v1/mailboxes/:mailboxId/emails/:id/reply` and `.../forward`. Resolve the original email via `resolveOriginalEmail`, build the References chain (`buildReferencesChain` → `buildThreadingHeaders`), validate sender (`validateSender`), check rate limit (`checkSendRateLimit`), store attachments (`storeAttachments`), insert the new message into Sent (`stub.createEmail(Folders.SENT, ...)` with `in_reply_to`/`email_references`/`thread_id`/raw headers), and delegate the actual SMTP via `sendEmail(c.env.EMAIL, ...)` |

## For AI Agents

### Working In This Directory
- **All trust gates live upstream.** The `requireMailbox` middleware in `workers/lib/mailbox.ts` is mounted at `/api/v1/mailboxes/:mailboxId/*` in `workers/index.ts` — these handlers can assume `c.var.mailboxStub` and `c.var.user` are set and ACL has passed.
- **Threading is RFC 5322-correct.** `buildReferencesChain` follows the conventional rule: `References` becomes the previous References + previous `Message-ID`; `In-Reply-To` is the previous `Message-ID`; `thread_id` is preserved from the original. Do not invent new threading semantics.
- **Sender validation is mandatory.** `validateSender(to, from, mailboxId)` enforces that the `from.email` matches the mailbox address (or one of its allowed addresses). Throws `SenderValidationError` → 400.
- **Rate limit on every send.** Call `checkSendRateLimit()` on the DO stub before invoking `sendEmail` — returns a string error message (or `null`). Surface as 429.
- **Sent folder write happens before SMTP send** so the message appears in the UI immediately. If the SMTP call fails, the message stays in Sent — that mirrors most mail clients and avoids losing user content.
- **Drafts are not auto-deleted by reply/forward.** If the user composed via the draft path, the route caller is responsible for `stub.deleteEmail(draftId)` afterwards (the API request body carries the optional `draft_id`).

### Testing Requirements
- Reply: confirm `Re:` is added once (not twice), references chain extends, original `Message-ID` is preserved.
- Forward: confirm subject is `Fwd:` prefixed, attachments are re-stored in R2 under the new email ID.
- Rate limit: trip `checkSendRateLimit` and verify a 429 with the DO's error string.
- Sender validation: post `from: { email: "wrong@example.com" }` and verify 400.

### Common Patterns
- Hono context generic: `Context<MailboxContext>` — never use the bare Hono context here.
- Use `SendEmailRequestSchema.parse(await c.req.json())` to validate input. The schema rejects malformed/unknown fields.
- Reuse `email-helpers.ts` and `attachments.ts` rather than reimplementing — duplication here is a regression.

## Dependencies

### Internal
- `workers/email-sender.ts` — SMTP send via `EMAIL` binding
- `workers/lib/attachments.ts` — base64 → R2 storage
- `workers/lib/email-helpers.ts` — sender validation, threading, message-ID generation, original-email resolution
- `workers/lib/schemas.ts` — `SendEmailRequestSchema`, `EmailFull`
- `workers/lib/mailbox.ts` — `MailboxContext`
- `shared/folders.ts` — `Folders.SENT`

### External
- `hono` — `Context` typing

<!-- MANUAL: -->
