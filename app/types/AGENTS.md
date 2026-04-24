<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# types

## Purpose
Frontend TypeScript interfaces — shared shapes for data flowing between API responses, query hooks, components, and the Zustand store.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Defines `Mailbox`, `MailboxSettings`, `SignatureSettings`, `Email`, `Attachment`, `Folder`. `Email` covers both single-message responses and the threaded list aggregate (with optional `thread_count`, `thread_unread_count`, `participants`, `needs_reply`, `has_draft` fields) |

## For AI Agents

### Working In This Directory
- **Frontend-side mirror only** — the worker has its own canonical schemas in `workers/lib/schemas.ts` (`EmailMetadata`, `EmailFull`, plus Zod schemas). When the API surface changes, update both sides. There is no automated codegen.
- **Settings shape is loosely typed on purpose.** `MailboxSettings.agentSystemPrompt` is a string the user types and the worker passes verbatim to the AI model — there is no Zod validation in `MailboxSettings` because the worker performs its own validation per field.
- **`Email.body` is `string | null | undefined`.** It is omitted on list responses and present on detail responses. Always narrow before rendering.
- Add new fields here **before** referencing them in components — the codebase does not allow `as any` or `@ts-ignore`.

### Testing Requirements
- `npm run typecheck` will catch any drift with consumers.

### Common Patterns
- Snake_case property names follow the API JSON shape (`thread_id`, `email_references`, `in_reply_to`) — do not camelCase here, the worker emits these as-is from Drizzle column names.

## Dependencies

### Internal
None.

### External
None.

<!-- MANUAL: -->
