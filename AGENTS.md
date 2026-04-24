<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# agentic-inbox

## Purpose
A self-hosted email client with an integrated AI agent, deployed entirely on Cloudflare Workers. Incoming mail arrives via Cloudflare Email Routing, each mailbox is isolated in its own Durable Object (SQLite), attachments live in R2, and a Cloudflare Agents SDK worker drafts replies on behalf of the operator. The same tool layer is also exposed over MCP at `/mcp`.

Architecture:

```
Browser (React SPA) ─┬─> Hono Worker (API + React Router SSR)
                     │     ├─> MailboxDO    (per-mailbox SQLite + R2 attachments)
                     │     ├─> EmailAgent   (AIChatAgent + 9 email tools + Workers AI)
                     │     └─> EmailMCP     (MCP server exposing the same tools)
                     │
                     └─ Cloudflare Access JWT gates every request outside DEV.
```

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Dependencies, scripts (`dev`, `build`, `deploy`, `typecheck`), Cloudflare deploy metadata |
| `wrangler.jsonc` | Worker config: DO bindings (`MAILBOX`, `EMAIL_AGENT`, `EMAIL_MCP`), R2 `BUCKET`, `AI`, `EMAIL`, vars (`DOMAINS`, `EMAIL_ADDRESSES`, `ADMINS`), migrations |
| `react-router.config.ts` | React Router v7 config (SSR enabled, v8 vite environment API) |
| `vite.config.ts` | Vite plugin order: `@cloudflare/vite-plugin`, Tailwind, React Router, tsconfig-paths |
| `tsconfig.json` | Root TS config — references `tsconfig.node.json` and `tsconfig.cloudflare.json` |
| `tsconfig.cloudflare.json` / `tsconfig.node.json` | Split TS project references (worker vs. vite/node tools) |
| `worker-configuration.d.ts` | Wrangler-generated ambient types for `Cloudflare.Env`, DO stubs, R2, AI, etc. |
| `.dev.vars.example` | Template for local secrets: `POLICY_AUD`, `TEAM_DOMAIN`, `INTERNAL_SECRET` |
| `README.md` | Setup walkthrough, Cloudflare Access troubleshooting, feature list, architecture diagram |
| `LICENSE` | Apache 2.0 |
| `demo_app.png` | Screenshot used in README |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `app/` | React Router v7 SPA — routes, components, TanStack Query hooks, Zustand UI state (see `app/AGENTS.md`) |
| `workers/` | Hono Worker entrypoint, Durable Objects, MCP server, AI agent, auth, shared libs (see `workers/AGENTS.md`) |
| `shared/` | Modules shared between frontend and worker — folder IDs, date formatting (see `shared/AGENTS.md`) |
| `public/` | Static assets served verbatim (favicon) (see `public/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Entrypoint is `workers/app.ts` (the Hono worker with email handler + React Router SSR). API routes live in `workers/index.ts`.
- **Access is the trust boundary.** Anyone who passes the configured Cloudflare Access policy can read/write every mailbox. Do not add features that assume per-user data isolation — there is only a per-mailbox ACL (owner + members) stored in R2 settings.
- **Never break the "Access required in production" rule.** `workers/app.ts` returns 500 when `POLICY_AUD`/`TEAM_DOMAIN` are unset outside DEV; that is intentional fail-closed behaviour.
- **Worker-to-worker calls** (inbound email → auto-draft) carry `x-internal-system: <INTERNAL_SECRET>`. Respect this when touching auth — see `workers/lib/auth.ts`.
- Run `npm run typecheck` before declaring worker changes done — it also regenerates `worker-configuration.d.ts` via `wrangler types`.

### Testing Requirements
- No automated test suite is checked in. Validate via `npm run dev` (React Router + wrangler dev) and exercise the flow end-to-end: send via UI, receive via `wrangler email dev`, verify attachments in R2, inspect Durable Object SQLite.
- For Access-gated endpoints, use the `X-Dev-User` header in dev (see `workers/lib/auth.ts:DEV_USER_HEADER`) to impersonate users.

### Common Patterns
- All files carry the Cloudflare Apache 2.0 header — preserve it when editing.
- Tabs for indentation (see `.editorconfig` implicit via existing files).
- Named exports preferred; default exports used for React route components (required by React Router).
- Zod at every request boundary (route handlers validate bodies via schemas from `workers/lib/schemas.ts`).
- TanStack Query keys are centralised in `app/queries/keys.ts` — update keys there, not inline in components.

## Dependencies

### External (runtime)
- React 19 + React Router 7 + `@cloudflare/kumo` — UI framework and component library
- TanStack Query 5 — server state
- Zustand 5 — client UI state (compose modal, side panel)
- TipTap 3.20.2 — rich text compose editor (all `@tiptap/*` overrides pinned to this version)
- Hono 4 — Worker HTTP routing
- Drizzle ORM — SQL query builder for the DO SQLite database
- `@cloudflare/ai-chat` + `agents` + `ai` v6 + `workers-ai-provider` — agent runtime and AI SDK
- `workers-ai-provider` → model `@cf/moonshotai/kimi-k2.5` (default, overridable per mailbox)
- `postal-mime` — inbound MIME parsing
- `jose` — Access JWT verification, invite-token signing
- `dompurify` — sanitize HTML before injecting into compose editor / iframes
- `zod` — schema validation everywhere

### External (dev)
- Wrangler 4 — deploy + local dev runtime
- `@cloudflare/vite-plugin` — runs the worker inside Vite dev server
- Tailwind CSS 4 — styling
- TypeScript 5.8

<!-- MANUAL: Add project-specific notes below this line. Future regenerations preserve this block. -->
