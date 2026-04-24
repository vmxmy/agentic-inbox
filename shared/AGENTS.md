<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# shared

## Purpose
Modules consumed by **both** the frontend (`app/`) and the worker (`workers/`). The only acceptable contents are pure utilities and constants with **no React, no Hono, no DOM, no DO** dependencies — anything that touches a runtime-specific API belongs in `app/lib/` or `workers/lib/`.

## Key Files

| File | Description |
|------|-------------|
| `folders.ts` | Canonical folder ID constants (`Folders.INBOX`, `SENT`, `DRAFT`, `ARCHIVE`, `TRASH`, `SPAM`), `SYSTEM_FOLDER_IDS` for sidebar order, `FOLDER_DISPLAY_NAMES`, `getFolderDisplayName(id)`, plus `FOLDER_TOOL_DESCRIPTION` / `MOVE_FOLDER_TOOL_DESCRIPTION` strings reused in agent + MCP tool schemas |
| `dates.ts` | Date formatting consolidated from previously-scattered helpers — `formatListDate`, `formatDetailDate`, `formatShortDate`, `formatQuotedDate`. Uses a `safeParse` helper so invalid `Date` values yield `null` rather than throwing |

## For AI Agents

### Working In This Directory
- **Single source of truth for folder IDs.** Adding a new system folder means: (1) add it to `Folders`, (2) add a display name, (3) decide whether it appears in `SYSTEM_FOLDER_IDS`, (4) update the tool descriptions used by the AI agent and MCP. Search the codebase for `Folders.` to see every consumer before changing the constant set.
- **No DOM APIs here.** `app/lib/utils.ts:htmlToPlainText` lives in `app/` because it depends on `document.createElement`. If you need an HTML→text helper that runs on the worker, add it to `workers/lib/email-helpers.ts:stripHtmlToText` instead.
- The directory has no `package.json` and no build step — files are imported directly via TypeScript path resolution (`shared/folders` from frontend, `../../shared/folders` from worker).

### Testing Requirements
- Pure unit-testable code. Today there are no tests checked in, but any future test suite should target this directory because the helpers are runtime-agnostic.

### Common Patterns
- `as const` literal types for enum-like objects (see `Folders`).
- Always export both the value (`Folders`) and a derived type (`FolderId`) when defining string-enum constants.

## Dependencies

### Internal
- None — this directory **must not** depend on `app/` or `workers/`.

### External
- None — no third-party packages.

<!-- MANUAL: -->
