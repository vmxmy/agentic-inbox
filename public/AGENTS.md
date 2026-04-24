<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# public

## Purpose
Static assets served verbatim by the worker / Vite dev server. Files placed here are reachable at the root path (e.g. `public/favicon.svg` → `/favicon.svg`).

## Key Files

| File | Description |
|------|-------------|
| `favicon.ico` | Multi-resolution legacy icon (referenced by `app/root.tsx` `<link rel="icon" type="image/x-icon">`) |
| `favicon.svg` | Modern SVG favicon (preferred — referenced first in `app/root.tsx`) |

## For AI Agents

### Working In This Directory
- Anything dropped here ships to production unmodified. Do not place secrets, source maps, or anything you would not publish.
- Reference public assets by absolute path from JSX (`href="/favicon.svg"`), never via import — Vite does not need to process them.

### Testing Requirements
- None beyond ensuring referenced filenames in `app/root.tsx` match what's on disk.

## Dependencies
None.

<!-- MANUAL: -->
