<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# services

## Purpose
Single typed `fetch` wrapper for the worker API — adds a 30-second timeout, supports caller-provided `AbortSignal` (e.g. TanStack Query cancellation), normalises error responses into `ApiError`, and exposes a thin namespace of methods consumed exclusively by the hooks in `app/queries/`.

## Key Files

| File | Description |
|------|-------------|
| `api.ts` | Exports the `ApiError` class (status + body) and the `api` namespace. Internal `request<T>` helper wires JSON encoding, timeout (`REQUEST_TIMEOUT_MS = 30_000`), abort-signal composition (`AbortSignal.any`), and content-type-aware response parsing (JSON vs blob). 204 responses return `undefined as T` |

## For AI Agents

### Working In This Directory
- **All HTTP traffic from the SPA goes through this module.** Do not call `fetch` directly from components or query hooks — extending `api` is mandatory so the timeout, abort handling, and `ApiError` semantics stay consistent.
- **`ApiError` is load-bearing.** `app/root.tsx` inspects `instanceof ApiError` to decide retry policy (skip 4xx, retry 5xx up to 2x). Throw it from any future API method; do not throw a plain `Error`.
- **No auth headers here.** Cloudflare Access cookies are sent automatically by the browser; the worker injects the user identity from the JWT. Never add an `Authorization` header.
- **Blob responses** (attachment downloads) are returned as `Blob` when content-type is not JSON. The `responseType: "blob"` opts the request out of the JSON parse path and sets `Accept: */*`.
- **Cross-origin is intentionally narrow.** `workers/index.ts` CORS only allows same-origin and localhost — do not point this client at an external host expecting CORS to be permissive.

### Testing Requirements
- Manual via the inbox UI. Watch the Network tab to confirm:
  - Aborted queries (e.g. fast navigation) cancel the underlying request.
  - 4xx responses surface a useful error message in toasts (because `ApiError.message` is taken from `body.error`).
  - Long-running attachment downloads complete past the 30s default — extend `REQUEST_TIMEOUT_MS` if you add a streaming endpoint.

### Common Patterns
- One method per API endpoint, named to match the resource verb (`listEmails`, `getEmail`, `sendEmail`, `whoami`, `listMembers`, etc.).
- Mailbox-scoped methods take `mailboxId` as the first argument by convention.
- `signal?: AbortSignal` is forwarded through to `request` so callers can opt into cancellation.

## Dependencies

### Internal
- `~/types` — Email, Folder, Mailbox

### External
- Browser `fetch` and `AbortController`

<!-- MANUAL: -->
