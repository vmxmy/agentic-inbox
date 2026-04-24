<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# mcp

## Purpose
The `EmailMCP` Durable Object — exposes the email tool surface over the Model Context Protocol at `/mcp`. External AI tools (Claude Code, Cursor, etc.) connect after passing Cloudflare Access; the worker injects the authenticated user's email so the DO can enforce per-mailbox ACL inside each tool handler.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `EmailMCP extends McpAgent<Env>` with an `McpServer` named `agentic-inbox` v1.0.0. `fetch` overrides set `currentUserEmail` from `INTERNAL_USER_HEADER` (DOs serialise on the fetch boundary, so the field is safe per-request). `init` registers tools that wrap `workers/lib/tools.ts`, `workers/lib/auth.ts`, and `workers/lib/agent-config.ts` impls and uses helpers `mcpText`/`mcpError`/`mcpResult` to format responses. Two ACL gates: `verifyMailbox` (access) and `verifyOwner` (owner-only, for ACL / invite operations) |

## Tool Categories

| Category | Tools |
|----------|-------|
| Identity | `whoami`, `list_mailboxes` |
| Email reads | `list_emails`, `get_email`, `get_thread`, `search_emails` |
| Email mutations | `mark_email_read`, `star_email`, `move_email`, `mark_thread_read`, `delete_email` |
| Drafts | `create_draft`, `draft_reply`, `update_draft` |
| Outbound | `send_email`, `send_reply`, `forward_email` |
| Folders | `list_folders`, `create_folder`, `rename_folder`, `delete_folder` |
| Settings | `get_mailbox_settings`, `update_mailbox_settings` |
| Agent config | `get_agent_config`, `update_agent_config`, `list_rules`, `set_rules` |
| ACL (access) | `list_members` |
| ACL (owner-only) | `add_member`, `remove_member`, `create_invite` |
| Invite acceptance | `accept_invite` |

## For AI Agents

### Working In This Directory
- **Authenticated user comes from `INTERNAL_USER_HEADER`.** `workers/app.ts` strips any client-supplied value and re-injects the email decoded from the verified Access JWT. **Never** trust this header inside the DO without that upstream filter.
- **Every mailbox-scoped tool must check ACL.** The `requireMailboxForUser(mailboxId)` pattern (see top of `init`) returns an MCP error response if the current user lacks access — call it before invoking the tool helper.
- **Tools come from `workers/lib/tools.ts`, `workers/lib/auth.ts`, and `workers/lib/agent-config.ts`.** Do not duplicate tool logic here. The MCP wrapper just (1) validates input via Zod, (2) checks ACL, (3) calls the helper, (4) wraps the result with `mcpResult` so `{ error: ... }` returns map to MCP errors.
- **ACL matches the HTTP API.** Access-level tools call `verifyMailbox` (owner or member). Owner-only operations (`add_member`, `remove_member`, `create_invite`) call `verifyOwner`, which delegates to `assertMailboxOwner`. `accept_invite` bypasses both — the token itself is the grant — and adds the caller as a member. Keep new tools aligned with the HTTP route's ACL choice or explain why they diverge.
- **`set_rules` and `update_agent_config` throw** on validation failure (ZodError / "Unknown agent model"). The MCP handlers catch and surface `e.message` via `mcpError`. Keep this pattern — raw throws inside a DO propagate as unhelpful `Internal error` responses.
- **Tool naming differs from the Agent.** MCP exposes mailbox-scoped variants (e.g. `list_mailboxes`, `send_reply`, `send_email`, `update_draft`, `delete_email`) that go beyond the Agent's draft-only set — MCP callers can actually send mail. Be explicit about this in tool descriptions.
- **The DO is registered as a sqlite class** (`new_sqlite_classes: ["EmailMCP"]`, migration tag `v3`). Do not change the class name without adding a migration tag.
- **WebSocket transport is provided by `McpAgent.serve("/mcp", { binding: "EMAIL_MCP" })`** — invoked from `workers/app.ts`. The DO runtime owns the connection; this file only registers tools.

### Testing Requirements
- Connect from an MCP client (e.g. Claude Code with the `/mcp` endpoint configured) and exercise:
  - `list_mailboxes` returns only mailboxes the authenticated user can access (via `listUserMailboxes`).
  - Mailbox-scoped tools 403 when the user is not on the ACL.
  - `send_email` enforces `validateSender` + rate limit just like the HTTP API.

### Common Patterns
- One `server.tool(name, description, inputSchema, handler)` registration per tool inside `init`.
- Handlers are `async` and return either `mcpText(result)`, `mcpResult(result)` (when result may carry an `error` field), or `mcpError("...")`.
- ACL helper `currentUser()` returns `null` if the request was unauthenticated — return `mcpError("Authentication required")` in that branch.

## Dependencies

### Internal
- `workers/lib/tools.ts` — tool implementations
- `workers/lib/auth.ts` — ACL checks (`getMailboxAcl`, `hasMailboxAccess`, `listUserMailboxes`), header constants
- `shared/folders.ts` — folder constants + tool description strings

### External
- `agents/mcp` — `McpAgent` Durable Object base
- `@modelcontextprotocol/sdk` — `McpServer`, content/error shapes
- `zod` — input schemas

<!-- MANUAL: -->
