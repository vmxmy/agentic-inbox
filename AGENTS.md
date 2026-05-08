<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

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


<claude-mem-context>
# Memory Context

# [agentic-inbox] recent context, 2026-05-09 3:11am GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (18,828t read) | 1,014,060t work | 98% savings

### Apr 27, 2026
S58 Phase A commit — user asked to commit "Phase A clean" in agentic-inbox (Apr 27 at 8:18 AM)
S59 Commit Cloudflare Agents Week 2026 tutorial doc — ignore AGENTS.md (Apr 27 at 2:08 PM)
S61 PR1 Auth Context Implementation — Signed JWT forwarding replacing INTERNAL_USER_HEADER D1 rehydration pattern in agentic-inbox (Apr 27 at 2:14 PM)
S87 agentic-inbox main Branch Pushed to GitHub — Batch Dept Assignment Feature Shipped (Apr 27 at 3:59 PM)
### Apr 29, 2026
1021 12:01p 🔴 isSameReadinessAction Route Comparison Bug — Query Params Stripped Before Matching
1022 " 🔴 CurrentTaskCard.vue TypeScript Error — issue.action.label Accessed Without Null Guard
1023 " 🔵 CycleDetail UI Fixes — Test Inventory and E2E Gap Confirmed
1024 " 🔵 Working Tree Has Two Unrelated Feature Sets — Batch Dept Assign (S86) and CycleDetail UI Fixes (S86-followup)
1025 12:04p 🔵 Architect Review — CycleDetail UI Fix Risks and Working Tree Map (Agent Gibbs)
1026 " 🟣 resolvePrimaryReadinessAction Added — Deep-Link Recovery for Pending-Filter CTAs
1027 " 🔵 performance-system-V2 Web Build — 151 Tests Pass, Build Clean, Full Verification Complete
1028 12:05p ⚖️ Ralph Session Architect Verification — CycleDetailPage UI Diff Review Scope
1029 " 🟣 Post-resolvePrimaryReadinessAction Verification — 152 Tests Pass, Build Clean
1030 12:06p ⚖️ Architect Verification Task Initiated — CycleDetailPage Ralph Session Scope
1031 12:07p ⚖️ Architect Verdict WATCH — CycleDetail UI Fixes Approved for Merge with Follow-up Items
1032 " 🔄 getPhaseMetricScope Refactored — Label Strings Replaced with PhaseMetricKey Enum Type
1033 12:09p 🔄 CycleDetailPage + Tests + Hint Copy — All Three Architect Follow-ups Applied
1034 12:11p ⚖️ CycleDetail UI Three-Fix Session — Architect Final Verdict CLEAR, Ralph Complete
1035 " 🟣 CycleDetailPage — Three UX Fixes Implemented: CTA Consolidation, Scope Labels, Issue Meta
1036 " ✅ Ralph Session State Fully Cleared — omx CLI Used as MCP Transport Fallback
1039 12:13p ✅ agentic-inbox main Branch Pushed to GitHub — Batch Dept Assignment Feature Shipped
S88 L4 P1 PR #27 Code Review Comment Posted to GitHub (Apr 29 at 12:13 PM)
1040 12:14p 🔵 agentic-inbox CI Failure — package-lock.json Out of Sync with vitest@4.1.5
1041 12:16p 🔵 performance-system-V2 Git Status — 19 Modified Files, 2 Commits Ahead of origin/main
1042 " 🔵 performance-system-V2 PR Scope — 6 Frontend Files, 266 Insertions, cycleDetailPresentation.ts is New
1043 12:17p ✅ agentic-inbox — chore/lockfile-sync-vitest Branch Created from main
1044 12:19p ✅ Commit 727df26 — "fix(web): clarify cycle detail task hierarchy" on codex/cycle-detail-ui-hierarchy
1045 12:20p 🟣 PR #19 Opened — "fix(web): clarify cycle detail task hierarchy" on vmxmy/quanzhou-project
1046 " 🟣 agentic-inbox L4 P1 — mcp_connections Schema, Row Helpers, and Tests Implemented
1047 " 🔵 L4 P1 Code Review — APPROVE-WITH-NITS, All Findings LOW Severity
1048 " 🔵 vitest Fails in Bare Git Worktree — node_modules Not Present
1049 12:21p ✅ L4 P1 PR #27 Code Review Comment Posted to GitHub
S91 agentic-inbox PR #27 (P1 MCP schema) — rebase feat/l4-p1-mcp-schema onto updated main after PR #28 lockfile fix merge, then force-push to trigger CI rerun (Apr 29 at 12:21 PM)
1053 12:25p 🔵 feat/l4-p1-mcp-schema Rebase Blocked by Unstaged Changes
S94 agentic-inbox L4 Phase 2 — MCP connection RPC + EmailAgent flag-gated wrappers implementation and PR creation (Apr 29 at 12:25 PM)
1055 12:29p ✅ agentic-inbox PR #27 Rebased onto Fixed Lockfile, CI Rerunning Pre-Merge
1056 12:30p ✅ agentic-inbox PR #27 (feat/l4-p1-mcp-schema) Merged to Main — P1 Complete
1057 12:31p ✅ PR #27 P1 Branch Rebased and Force-Pushed onto Updated Main
1064 12:32p 🟣 PR #27 (L4 P1 MCP Schema) Merged to main
1066 12:34p 🟣 feat/l4-p2-rpc-methods Branch Created from Updated main
1067 " 🔵 Durable Object RPC Pattern — Existing Methods as Template for P2 MCP RPCs
1068 12:35p 🔵 MailboxDO Class Boundaries and getMailboxStub Call Pattern Mapped
1070 12:36p 🟣 L4_MCP_ENABLED Feature Flag Added to Env Interface
S99 User-Level MCP Server Inventory — 5 Servers Configured in ~/.claude.json (Apr 29 at 12:47 PM)
1102 1:00p ⚖️ agentic-inbox P2 PR #29 — MCP RPC + EmailAgent Wrapper Methods Awaiting CI + Merge
1104 1:01p ✅ agentic-inbox PR #29 (L4-P2 RPC Methods) — Squash Merged to Main
1107 1:06p 🔵 Agents SDK OAuth Callback URL Construction — Default Pattern and Override Path
1108 1:08p 🟣 agentic-inbox L4-P3 — OAuth State Binding Types and Pure Validators Added to mcp-connections.ts
1111 1:10p 🟣 MailboxBoundOAuthProvider — New File Implementing Storage-Layer OAuth State Binding
1112 " 🟣 EmailAgent — createMcpOAuthProvider Override + callbackHost Parameter Added (P3)
1117 1:12p 🟣 agentic-inbox — Three L4 MCP Connection Routes Added to workers/index.ts (P3)
1147 10:09p ✅ mcp-router MCP Server Added to Claude Code Config
1155 10:29p 🔵 User-Level MCP Server Inventory — 5 Servers Configured in ~/.claude.json
S101 litellm MCP not visible in Claude Code — diagnosed and fixed for max-2 account (Apr 29 at 10:29 PM)
1156 10:30p 🔵 litellm MCP Server Not Visible in Active Claude Code Session
1157 10:31p 🔵 agentic-inbox Project Has .mcp.json But enableAllProjectMcpServers is null
1158 " 🔵 max-2 Account ~/.claude.json Has Null mcpServers Field
1160 10:33p 🔵 LiteLLM MCP Server Exposes GitHub Tool — get_me Endpoint Confirmed Available
S102 LiteLLM MCP Server Exposes GitHub Tool — get_me Endpoint Confirmed Available (Apr 29 at 10:33 PM)
### Apr 30, 2026
1163 1:13a 🟣 agentic-inbox L4 P8 Phase 1 — Bearer Token Crypto Infrastructure Shipped as Draft PR #36

Access 1014k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>