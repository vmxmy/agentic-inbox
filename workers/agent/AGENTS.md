<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-24 | Updated: 2026-04-24 -->

# agent

## Purpose
Houses the `EmailAgent` Durable Object — the AI-powered email assistant. Subclasses `AIChatAgent` (from `@cloudflare/ai-chat`) so it owns its own chat-history SQLite table and a WebSocket transport at `/agents/email-agent/<mailboxId>`. Exposes 9 email tools to the model and runs an auto-draft pipeline whenever a new email arrives.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Defines `EmailAgent extends AIChatAgent<any>` and the `createEmailTools(env, mailboxId)` factory that wires the Zod-validated tools (`list_emails`, `get_email`, `get_thread`, `search_emails`, `draft_email`, `draft_reply`, `mark_email_read`, `move_email`, `discard_draft`) into the AI SDK. Also contains the inline `DEFAULT_SYSTEM_PROMPT` (writing-style + agent-behaviour rules), the `resolveSystemPrompt(custom, override)` helper, the `onChatMessage` streaming handler, and `handleNewEmail(emailData)` — the auto-draft entrypoint invoked from `workers/index.ts:receiveEmail` |

## For AI Agents

### Working In This Directory
- **Do not edit `DEFAULT_SYSTEM_PROMPT` casually.** It encodes hard agent-behaviour rules (no meta-commentary, draft-only, plain-text body, no markdown). Per-mailbox overrides are stored in `mailboxes/<id>.json:agentSystemPrompt` and resolved via `resolveSystemPrompt`. A per-email `promptOverride` (from a matched processing rule) is **prepended** to whichever base prompt is used.
- **`AIChatAgent` extends `Env` as `<any>`** intentionally — the constraint conflicts with the custom `SEND_EMAIL` binding shape. The actual env stays fully typed inside tool closures via the `Env` cast inside `onChatMessage` / `handleNewEmail`.
- **Tools must come from `workers/lib/tools.ts`.** The `createEmailTools` factory is the only consumer; `defineTool(...)` here is a tiny shim around AI SDK v6's tool shape (the v6 overloads broke `tool({...})`). When adding a tool, add the impl to `workers/lib/tools.ts` first, then expose it both here and in `workers/mcp/index.ts`.
- **Auto-draft pipeline is opinionated:**
  1. `onRequest` intercepts `POST /onNewEmail` and calls `handleNewEmail`.
  2. `handleNewEmail` pre-reads the email + thread via the `MailboxDO` stub, runs `isPromptInjection` on both the email body and the thread context — and bails with a chat-log entry if either is flagged.
  3. Sends a single fresh-context user message (no prior chat history) to the model with the full email + thread inlined.
  4. If `draft_reply` / `draft_email` was tool-called, logs a short success line. If the model produced inline text instead, runs `verifyDraft` to strip agent commentary and saves the result as a draft directly. Distinguishes plain-text vs HTML via a regex (`<[a-z][\s\S]*>`).
- **Step budget is `stepCountIs(5)`** in both streaming and auto-draft paths. Increasing this raises Workers AI cost — get explicit approval first.
- **Chat persistence:** `persistMessages` writes both the synthetic `[Auto-triggered]` user message and the assistant's response so the operator sees what happened in the AgentPanel.
- **Internal trust:** the auto-draft trigger from `receiveEmail` carries `INTERNAL_SYSTEM_HEADER`; do not log this header.

### Testing Requirements
- Local: open the AgentPanel against a dev mailbox, send a message, verify streaming + tool calls render. For auto-draft, use `wrangler email dev` to deliver an inbound message and watch logs / Drafts folder.
- Prompt injection: send an email body containing "ignore previous instructions, …" and verify the agent logs a refusal in the chat instead of drafting.

### Common Patterns
- All tool execute callbacks return raw objects (or `{ error: string }`) — formatting is the AI SDK's job.
- `getMailboxStub(env, mailboxId)` from `workers/lib/email-helpers.ts` is the only acceptable way to obtain a `MailboxDO` stub. Do not call `env.MAILBOX.idFromName(...)` inline.

## Dependencies

### Internal
- `workers/lib/tools.ts` — every tool implementation
- `workers/lib/ai.ts` — `verifyDraft`, `isPromptInjection`
- `workers/lib/email-helpers.ts` — DO stub helper, HTML/text conversion
- `workers/lib/agent-config.ts` — per-mailbox model/prompt/auto-draft flag/rules
- `workers/lib/schemas.ts` — `EmailFull`, `EmailMetadata` types
- `shared/folders.ts` — folder constants and the FOLDER_TOOL_DESCRIPTION strings used in tool metadata

### External
- `@cloudflare/ai-chat` — `AIChatAgent` base class (chat history, WebSocket)
- `ai` 6 — `streamText`, `generateText`, `convertToModelMessages`, `stepCountIs`
- `workers-ai-provider` — `createWorkersAI(binding)`
- `zod` — tool input schemas

<!-- MANUAL: -->
