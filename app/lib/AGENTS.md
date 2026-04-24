<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# lib

## Purpose
Frontend-only utility functions. Two concerns: HTML/text manipulation for the compose flow + email rendering, and a Gmail-style search-query parser used by the search route.

## Key Files

| File | Description |
|------|-------------|
| `utils.ts` | HTML helpers (DOMPurify-backed `htmlToPlainText`, `stripHtml`, `escapeHtml`, `getSnippetText`), file-size formatting (`formatBytes`), email-list value helpers (`splitEmailList`, `toEmailListValue`), signature/quote builders (`getSignatureBlock`, `buildQuotedReplyBlock`), inline-image CID rewriter (`rewriteInlineImages`), attachment URL builder + downloader. Re-exports `formatListDate`/`formatDetailDate`/`formatShortDate` from `shared/dates` for backwards compatibility |
| `search-parser.ts` | Parses Gmail-style queries (`from:`, `to:`, `subject:`, `in:`, `is:unread/read/starred`, `has:attachment`, `before:`, `after:`) into a `ParsedSearch` object the API consumes. Quoted values supported; everything else falls into the free-text `query` field |

## For AI Agents

### Working In This Directory
- **`htmlToPlainText` is client-only** — it instantiates `document.createElement`. Do not import it inside a module that may execute during SSR. The worker has its own `stripHtmlToText` in `workers/lib/email-helpers.ts` for server-side use.
- **All email HTML must go through DOMPurify before being injected.** `getSignatureBlock`, `htmlToPlainText`, and `buildQuotedReplyBlock` all do this — match the pattern when adding new HTML producers.
- **`escapeHtml` covers the five OWASP characters.** Use it for any text written into HTML attribute or text contexts (e.g. quoted-reply sender names).
- **The search parser is intentionally simple.** No regex operators, no boolean logic — that matches the worker's search implementation. If you add an operator, also wire it into `workers/durableObject/index.ts:searchEmails`.
- Date formatting lives in `shared/dates.ts` — `app/lib/utils.ts` only re-exports the legacy names. Do not duplicate format helpers here.

### Testing Requirements
- These are pure functions — easy to unit-test if/when a test suite is added. Until then, exercise via the search route (`/mailbox/:id/search?q=...`) and the compose flow.

### Common Patterns
- Defensive null/empty handling: helpers return `""` on `null`/`undefined` rather than throwing.
- DOMPurify is always called with default config; if you need to allow extra tags, justify it in a comment and audit for XSS first.

## Dependencies

### Internal
- `shared/dates.ts` — date formatters re-exported here
- `~/types` — `Attachment`

### External
- `dompurify` 3 (+ `@types/dompurify`)

<!-- MANUAL: -->
