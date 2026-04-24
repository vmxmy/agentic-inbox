<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# queries

## Purpose
TanStack Query hooks for all server data, plus the centralised query-key factory. Every read/mutation against the worker's `/api/v1/*` API flows through this directory so cache invalidation has a single owner.

## Key Files

| File | Description |
|------|-------------|
| `keys.ts` | **Authoritative** query-key factory (`queryKeys.mailboxes`, `emails`, `folders`, `search`, `config`, `whoami`, `members`, `adminMailboxes`). Treat this as a sacred central registry — adding a query without registering its key here breaks every `invalidateQueries(...)` call elsewhere |
| `mailboxes.ts` | `useMailboxes`, `useMailbox`, `useCreateMailbox`, `useUpdateMailbox`, `useDeleteMailbox` |
| `emails.ts` | Email queries (`useEmails`, `useEmail`, `useThread`) and mutations (`useSendEmail`, `useSaveDraft`, `useReplyToEmail`, `useForwardEmail`, `useDeleteEmail`, `useMarkRead`, `useStarEmail`, `useMoveEmail`, `useMarkThreadRead`) |
| `folders.ts` | `useFolders`, `useCreateFolder`, `useRenameFolder`, `useDeleteFolder` |
| `search.ts` | `useSearchResults` — paginated, query-scoped |
| `identity.ts` | `useWhoami` — returns current user email + admin flag from `/api/v1/whoami`. 5-minute `staleTime` |
| `members.ts` | Mailbox-membership operations: list members, add/remove member, issue invite, accept invite |

## For AI Agents

### Working In This Directory
- **Always use the key factory.** Never inline `["emails", id, ...]` arrays in components — call `queryKeys.emails.list(...)` so invalidation works everywhere.
- **`mutateAsync` callers handle their own errors** in `try/catch`. The global `MutationCache.onError` in `app/root.tsx` only logs unhandled mutation errors; do not rely on it for UX.
- **4xx errors do not retry.** `app/root.tsx` configures the QueryClient to skip retries on `ApiError` with `status >= 400 && < 500`. Match this when configuring per-query retry behaviour.
- **Use `enabled: !!mailboxId` for parameterised queries.** Several hooks accept `mailboxId | undefined` to support the "no mailbox selected" route state — gate `useQuery` execution accordingly so the query key never embeds `undefined`.
- **`useEmails` automatically passes `threaded=true`** when a folder is supplied. Inverse: omitting `folder` returns the flat list (used by thread-detail views).

### Testing Requirements
- Manual: open React Query Devtools (if added) or Network tab. Verify mutations invalidate the right keys (e.g. sending an email invalidates the Sent folder list, the source draft list, and the thread).

### Common Patterns
- One hook file per domain (mailboxes / emails / folders / search / identity / members).
- `useQuery` for reads, `useMutation` for writes. Hooks return the raw query/mutation result — components destructure as needed.
- Cache invalidation pattern: on mutation success, `queryClient.invalidateQueries({ queryKey: queryKeys.emails.list(mailboxId, ...) })`.

## Dependencies

### Internal
- `~/services/api` — typed fetch wrappers (single transport)
- `~/types` — Email/Folder/Mailbox shapes

### External
- `@tanstack/react-query` 5

<!-- MANUAL: -->
