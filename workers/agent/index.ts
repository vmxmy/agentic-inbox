// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	streamText,
	generateText,
	convertToModelMessages,
	stepCountIs,
	type ToolSet,
} from "ai";
import { getLlmProvider, listLlmModels, pickModel, resolveLlmConfig } from "../lib/llm-models";
import { z } from "zod";
import type { EmailFull, EmailMetadata } from "../lib/schemas";
import { verifyDraft, isPromptInjection } from "../lib/ai";
import {
	getMailboxStub,
	stripHtmlToText,
	textToHtml,
} from "../lib/email-helpers";
import { Folders } from "../../shared/folders";
import { getAgentConfig } from "../lib/agent-config";
import {
	get as getCapability,
	invoke as invokeCapability,
} from "../lib/capabilities";
import { readInternalAuthContextHeader, type AuthUser } from "../lib/auth";
import {
	bearerEnvelopeFromConnection,
	buildConnectionFromSdkResult,
	isL4BearerEnabled,
	isL4McpEnabled,
	type AddExternalMcpServerInput,
	type AddExternalMcpServerResult,
	type PublicMcpConnection,
} from "../lib/mcp-connections";
import {
	buildBearerFetch,
	connectBearerMcpServer,
} from "../lib/mcp-bearer-transport";
import {
	categoriseError,
	decryptBearerToken,
	encryptBearerToken,
} from "../lib/mcp-token-crypto";
import { MailboxBoundOAuthProvider } from "../lib/mcp-oauth-provider";
import { parseSdkToolKey, namespaceTool } from "../lib/mcp-tool-namespace";
import {
	MCP_INJECTION_WARNING,
	wrapExternalTool,
	type ExternalToolLike,
} from "../lib/mcp-audit";
import type { Env } from "../types";

// AI SDK v6 changed tool() overloads significantly. We define tools as plain
// objects matching the Tool type to avoid overload resolution issues.
function defineTool(def: {
	description: string;
	parameters: z.ZodType<any>;
	execute: (...args: any[]) => Promise<any>;
}) {
	return {
		description: def.description,
		inputSchema: def.parameters,
		execute: def.execute,
	};
}

/**
 * Default system prompt used when no custom prompt is configured for a mailbox.
 * Users can override this on a per-mailbox basis via the Settings UI.
 */
const DEFAULT_SYSTEM_PROMPT = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.

## Writing Style
Write like a real person. Short, direct, flowing prose. Get to the point. Plain text only - no HTML tags in your replies.

**Formatting rules:**
- Write in natural paragraphs. NO bullet points, NO numbered lists, NO dashes, NO markdown formatting in email drafts.
- NO bold (**), NO italic (*), NO headers (#), NO horizontal rules (---), NO code blocks. Plain text only.
- Links go inline in the text, not on separate lines.
- Don't structure replies like a template or form letter. Just talk normally.

**Agent Behavior Rules (CRITICAL):**
- NEVER output meta-commentary about what you are doing (e.g. do not say "I am drafting a reply to Alex", "I checked the thread", etc).
- When a new email arrives, your ONLY job is to call the \`draft_reply\` tool.
- DO NOT summarize the email. DO NOT explain your actions.
- Output NOTHING except the tool call. If you must output text, it should ONLY be the literal draft text itself if tools fail.
- Before drafting ANY reply, carefully read the full thread history.
- NEVER repeat information that was already shared in a prior message in the thread.
- Your reply should only contain NEW information or directly respond to what the person just said. Move the conversation forward, don't rehash it.

## Who Are You Replying To?
Use the name the person gives in their email body / signature. That's their name - use it. The "from" address is where you send the reply, but the name in the email is how you greet them.

## CRITICAL: Draft Only - Never Send
You can ONLY draft emails. You do NOT have the ability to send emails directly.

- Use draft_reply to draft replies to existing emails
- Use draft_email to draft new outbound emails
- The operator will review and send drafts from the UI - you cannot send them

**CRITICAL: The draft body must contain ONLY the email text.** Never include agent commentary, status messages, meta-notes, markdown formatting, or anything that isn't part of the actual email in the draft body. No "Draft created.", no "---", no "**bold**", no "Here's the draft:", no separators. The body field is the literal email the recipient will read. Everything else goes in your chat message, not in the draft body.

**Don't paste draft contents into the chat.** The drafts are saved via tools - the operator can see them in the Drafts folder. In your chat message, just briefly say what you drafted (e.g. "Drafted a reply to Tim"). Don't duplicate the full email body in the chat.

## Draft Management
Use discard_draft to delete drafts that the operator rejects or that are no longer needed.`;

/**
 * Resolve the system prompt for a mailbox. Uses the custom prompt if set,
 * otherwise falls back to DEFAULT_SYSTEM_PROMPT. An optional per-email
 * `promptOverride` (from a matched processing rule) is prepended verbatim.
 */
function resolveSystemPrompt(
	customPrompt: string | null,
	overrideForThisEmail?: string,
): string {
	const base = customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
	if (!overrideForThisEmail?.trim()) return base;
	return `## Per-email instruction (from matched rule)\n${overrideForThisEmail.trim()}\n\n${base}`;
}

/**
 * Default capability ids the EmailAgent exposes as LLM tools when the mailbox
 * settings blob doesn't pin an explicit `emailReplyEnabledSkills` allowlist.
 * Mirrors the previous hand-written `createEmailTools` set 1:1 so today's
 * model behaviour is preserved exactly.
 */
const EMAIL_AGENT_DEFAULT_SKILLS: readonly string[] = [
	"core:list-emails",
	"core:get-email",
	"core:get-thread",
	"core:search-emails",
	"core:draft-email",
	"core:draft-reply",
	"core:mark-email-read",
	"core:move-email",
	"core:discard-draft",
];

/** `core:list-emails` → `list_emails`. */
function toolNameFromCapabilityId(id: string): string {
	const local = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
	return local.replaceAll("-", "_");
}

/**
 * Build a Map<toolName, Tool> from the Capability registry, filtered to the
 * agent's allowed skill ids. Tool name preservation matters: the EmailAgent
 * system prompt at lines ~80/426/451 references tools by name, and the model
 * was trained on the existing names — drift means re-evaluation.
 */
function buildToolsFor(
	env: Env,
	mailboxId: string,
	agentId: "email-reply",
	enabledSkills: readonly string[] | null,
	allowedDefaults: readonly string[],
	user: AuthUser | null,
): Record<string, ReturnType<typeof defineTool>> {
	// `enabledSkills` only narrows: user-supplied ids outside the agent's
	// allowlist are dropped so an EmailAgent can't accidentally pull invoice
	// tools just because the settings blob was edited by hand.
	const allowed = new Set(allowedDefaults);
	const ids = (enabledSkills ?? allowedDefaults).filter((id) => allowed.has(id));
	const tools: Record<string, ReturnType<typeof defineTool>> = {};
	for (const id of ids) {
		const cap = getCapability(id);
		if (!cap || !cap.surfaces.includes("agent-tool")) continue;
		tools[toolNameFromCapabilityId(id)] = defineTool({
			description: cap.description,
			parameters: cap.inputSchema as z.ZodType<unknown>,
			execute: async (input: unknown): Promise<unknown> => {
				const result = await invokeCapability(
					{ env, mailboxId, agentId, triggeredBy: "agent-tool", user },
					id,
					input,
				);
				return result.ok ? result.value : { error: result.error };
			},
		});
	}
	return tools;
}

function createEmailTools(
	env: Env,
	mailboxId: string,
	enabledSkills: readonly string[] | null = null,
	user: AuthUser | null = null,
) {
	return buildToolsFor(env, mailboxId, "email-reply", enabledSkills, EMAIL_AGENT_DEFAULT_SKILLS, user);
}

// Use `any` for the Env generic to avoid type conflicts between the custom
// SEND_EMAIL binding shape and the AIChatAgent constraint.  The actual env
// is fully typed inside the tools via the closure.
export class EmailAgent extends AIChatAgent<any> {
	/** Per-request authenticated user, decoded from the signed internal
	 *  auth-context JWT injected by the Hono layer (`workers/app.ts:/agents/*`).
	 *  DOs serialise requests on the fetch boundary, so reading this field
	 *  inside `onChatMessage` is safe for the current request. Null for
	 *  system-triggered paths (auto-draft `onNewEmail`) — the registry's
	 *  owner-only gate denies in that case, which is intentional. */
	private currentUser: AuthUser | null = null;
	private bearerCache = new Map<string, string>();
	/**
	 * In-flight `executeTask` AbortControllers keyed by the `taskId` the
	 * caller (RouterAgent) supplies. Lets the router cancel a delegated
	 * sub-task when the user hits stop on the chat. Cleared on completion
	 * (success or error) so a missing entry implies "task already finished".
	 */
	private taskAborters = new Map<string, AbortController>();

	override async fetch(request: Request): Promise<Response> {
		this.currentUser = await readInternalAuthContextHeader(
			request,
			this.env as Env,
		);
		return super.fetch(request);
	}

	async onChatMessage(onFinish: any, options?: { abortSignal?: AbortSignal }) {
		const env = this.env as Env;
		const mailboxId = this.name;
		const config = await getAgentConfig(env, mailboxId);
		const internalTools = createEmailTools(env, mailboxId, config.emailReplyEnabledSkills, this.currentUser);
		const systemPrompt = resolveSystemPrompt(config.customSystemPrompt);
		const cfg = await resolveLlmConfig(env);
		const provider = getLlmProvider(env, cfg);
		const catalog = await listLlmModels(env, { cfg });
		const modelId = pickModel(catalog, config.emailReplyModel ?? config.model, cfg.defaultModel);

		let externalNamespaced: ToolSet = {};
		const l4Enabled = isL4McpEnabled(env);
		if (l4Enabled) {
			const externalRaw = this.mcp.getAITools();
			const stub = getMailboxStub(env, this.name);
			const conns = await stub.listMcpConnections();
			const knownConnIds = conns.map((c) => c.id);
			const connById = new Map(conns.map((c) => [c.id, c]));
			const screener = (text: string) => isPromptInjection(env.AI, text);
			for (const [sdkKey, tool] of Object.entries(externalRaw)) {
				const parsed = parseSdkToolKey(sdkKey, knownConnIds);
				if (!parsed) continue;
				const conn = connById.get(parsed.connId);
				if (!conn) continue;
				// `enabledTools === null` means "no allowlist — every tool flows
				// through". An array (including empty) means the owner explicitly
				// chose the surface — only listed tools are exposed.
				if (
					conn.enabledTools !== null &&
					!conn.enabledTools.includes(parsed.toolName)
				) {
					continue;
				}
				const wrapped = wrapExternalTool({
					tool: tool as ExternalToolLike,
					connId: parsed.connId,
					toolName: parsed.toolName,
					authType: conn.authType,
					appendMcpAudit: (row) => stub.appendMcpAudit(row),
					screener,
					now: () => Date.now(),
					newId: () => crypto.randomUUID(),
				});
				externalNamespaced[namespaceTool(parsed.connId, parsed.toolName)] = wrapped as ToolSet[string];
			}
		}
		const tools: ToolSet = { ...internalTools, ...externalNamespaced };
		// Append the untrusted-content warning whenever the L4 surface is on,
		// not only when at least one external tool merged — the warning is
		// preventative against future merges within the same chat.
		const finalSystemPrompt = l4Enabled
			? systemPrompt + MCP_INJECTION_WARNING
			: systemPrompt;

		const result = streamText({
			model: provider(modelId),
			system: finalSystemPrompt,
			messages: await convertToModelMessages(this.messages),
			tools,
			stopWhen: stepCountIs(5),
			onFinish,
			// Forward the SDK-supplied abortSignal so a stop() from the client
			// actually halts the LLM stream + tool loop instead of letting the
			// run finish in the background.
			abortSignal: options?.abortSignal,
		});

		return result.toUIMessageStreamResponse();
	}

	/**
	 * Handle HTTP requests to the agent DO. Intercepts /onNewEmail
	 * before passing to the default AIChatAgent handler.
	 */
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/onNewEmail" && request.method === "POST") {
			try {
				const emailData = await request.json() as {
					mailboxId: string;
					emailId: string;
					sender: string;
					subject: string;
					threadId: string;
					/** Optional per-email prompt fragment pushed by a matched processing rule. */
					promptOverride?: string;
				};
				const result = await this.handleNewEmail(emailData);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (e) {
				console.error("onNewEmail handler failed:", (e as Error).message);
				return new Response(
					JSON.stringify({ error: (e as Error).message }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		return super.onRequest(request);
	}

	/**
	 * Called when a new email arrives. Reads it, loads the thread,
	 * drafts a response, and saves it to the Drafts folder.
	 */
	async handleNewEmail(emailData: {
		mailboxId: string;
		emailId: string;
		sender: string;
		subject: string;
		threadId: string;
		promptOverride?: string;
	}) {
		const env = this.env as Env;
		const config = await getAgentConfig(env, emailData.mailboxId);
		const tools = createEmailTools(env, emailData.mailboxId, config.emailReplyEnabledSkills);
		const systemPrompt = resolveSystemPrompt(config.customSystemPrompt, emailData.promptOverride);
		const cfg = await resolveLlmConfig(env);
		const provider = getLlmProvider(env, cfg);
		const catalog = await listLlmModels(env, { cfg });
		const modelId = pickModel(catalog, config.emailReplyModel ?? config.model, cfg.defaultModel);

		// Pre-read the email and thread so the agent has full context
		// without needing to waste tool calls discovering it
		const stub = getMailboxStub(env, emailData.mailboxId);

		let emailBody = "";
		let threadContext = "";
		try {
			const email = (await stub.getEmail(emailData.emailId)) as EmailFull | null;
			if (email?.body) {
				const isInjection = await isPromptInjection(env.AI, email.body);
				if (isInjection) {
					console.warn("Skipping auto-draft due to detected prompt injection:", emailData.emailId);
					
					// Log to agent chat so the user knows why it skipped
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"` }],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content: "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection or malicious instructions.",
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection or malicious instructions." }],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					
					return;
				}
				
				emailBody = stripHtmlToText(email.body);
			}

		// Load thread for conversation context
		const threadEmails = (await stub.getEmails({ thread_id: emailData.threadId })) as EmailMetadata[];
		if (threadEmails.length > 1) {
			const fullThread = await Promise.all(
				threadEmails.map(async (e) => {
					const full = (await stub.getEmail(e.id)) as EmailFull | null;
					const text = full?.body ? stripHtmlToText(full.body) : "";
					return { id: e.id, sender: e.sender, recipient: e.recipient, subject: e.subject, date: e.date, folder_id: e.folder_id, body_text: text };
				}),
			);
			fullThread.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
			threadContext = fullThread
				.map((e) => `[${e.date}] ${e.sender} → ${e.recipient} (${e.folder_id}): ${e.body_text.substring(0, 500)}`)
				.join("\n\n");

			// Scan thread context for prompt injection too -- an attacker
			// could plant an injection in an earlier email in the thread
			// that gets included in the agent's prompt.
			if (threadContext) {
				const threadInjection = await isPromptInjection(env.AI, threadContext);
				if (threadInjection) {
					console.warn("Skipping auto-draft due to prompt injection in thread context:", emailData.threadId);
					const newMessages = [
						{
							id: crypto.randomUUID(),
							role: "user" as const,
							content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"` }],
						},
						{
							id: crypto.randomUUID(),
							role: "assistant" as const,
							content: "Blocked auto-draft creation: the thread context appears to contain prompt injection or malicious instructions.",
							createdAt: new Date(),
							parts: [{ type: "text" as const, text: "Blocked auto-draft creation: the thread context appears to contain prompt injection or malicious instructions." }],
						},
					];
					await this.persistMessages([...this.messages, ...newMessages]);
					return;
				}
			}
		}
		} catch (e) {
			console.warn("Pre-read failed, agent will use tools:", (e as Error).message);
		}

		let autoPrompt = `A new email just arrived. Draft an appropriate response using draft_reply.

Email details:
- Mailbox: ${emailData.mailboxId}
- Email ID: ${emailData.emailId}
- From: ${emailData.sender}
- Subject: ${emailData.subject}
- Thread ID: ${emailData.threadId}

Email body:
${emailBody || "(could not pre-read — use get_email to read it)"}`;

		if (threadContext) {
			autoPrompt += `

Full thread history (${emailData.threadId}):
${threadContext}`;
		} else {
			autoPrompt += `

This is the first message in the thread (no prior conversation).`;
		}

		autoPrompt += `

Based on the email content and thread context above, draft a reply using draft_reply. If you need more context, use get_thread with thread ID "${emailData.threadId}".`;

		// Fresh context for auto-draft -- don't include prior chat history
		// to avoid confusing the model with old messages and tool calls
		const messages = [
			{
				role: "user" as const,
				content: autoPrompt,
				parts: [{ type: "text" as const, text: autoPrompt }],
				createdAt: new Date(),
			},
		];

		try {
			const result = await generateText({
				model: provider(modelId),
				system: systemPrompt,
				messages: await convertToModelMessages(messages),
				tools,
				stopWhen: stepCountIs(5),
			});

			// Check if draft_reply was called (saves to Drafts as side effect).
			// If NOT, save the agent's text response as a draft directly.
			const draftToolCalled = result.steps.some((step) =>
				step.toolCalls.some((tc) => tc.toolName === "draft_reply" || tc.toolName === "draft_email"),
			);

			if (!draftToolCalled && result.text.trim()) {
				// Model generated a draft inline as text -- verify with AI
				const sanitizedText = await verifyDraft(env.AI, result.text.trim());
				if (!sanitizedText) {
					// Inline text was entirely agent commentary, skip
				} else {
					const draftId = crypto.randomUUID();
					const draftStub = getMailboxStub(env, emailData.mailboxId);
					const reSubject = emailData.subject.startsWith("Re:")
						? emailData.subject
						: `Re: ${emailData.subject}`;
					await draftStub.createEmail(
						Folders.DRAFT,
						{
							id: draftId,
							subject: reSubject,
							sender: emailData.mailboxId.toLowerCase(),
							recipient: emailData.sender.toLowerCase(),
							date: new Date().toISOString(),
						// verifyDraft may return plain text or HTML depending on its
						// code path. Only wrap in textToHtml if it's plain text.
						body: /<[a-z][\s\S]*>/i.test(sanitizedText)
							? sanitizedText
							: textToHtml(sanitizedText),
						in_reply_to: emailData.emailId,
							email_references: null,
							thread_id: emailData.threadId,
						},
						[],
					);
					// Inline text saved as draft
				}
			}

			// Persist the conversation into the agent's chat history
			// If it called the tool, we just log a simple success message so the chat isn't cluttered
			// with conversational slop.
			const assistantText = draftToolCalled 
				? `Created draft reply to ${emailData.sender}.`
				: result.text;

			const newMessages = [
				{
					id: crypto.randomUUID(),
					role: "user" as const,
					content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
						},
					],
				},
				{
					id: crypto.randomUUID(),
					role: "assistant" as const,
					content: assistantText,
					createdAt: new Date(),
					parts: [
						{
							type: "text" as const,
							text: assistantText,
						},
					],
				},
			];

			await this.persistMessages([...this.messages, ...newMessages]);

			return { status: "draft_generated", text: result.text };
		} catch (e) {
			console.error("Auto-draft failed:", (e as Error).message);
			return { status: "error", error: (e as Error).message };
		}
	}

	// ── External MCP servers (L4 P2) ───────────────────────────────
	//
	// Owner-only RPC surface that pairs SDK MCP connection setup with the
	// `MailboxDO.upsertMcpConnection` metadata write. OAuth can use
	// Cloudflare's high-level `Agent.addMcpServer`; Bearer uses the lower-level
	// MCPClientManager path so the non-serializable fetch closure reaches the
	// live transport without being written to SDK storage. Routes gate caller
	// identity via `assertMailboxOwner`; the `L4_MCP_ENABLED` feature flag here
	// is the second guard so a bypassing caller still cannot mutate state.

	private requireL4Enabled(): void {
		if (!isL4McpEnabled(this.env as Env)) {
			throw new Error("L4 MCP feature disabled");
		}
	}

	private requireL4BearerEnabled(): void {
		if (!isL4BearerEnabled(this.env as Env)) {
			throw new Error("L4 MCP Bearer feature disabled");
		}
	}

	private readBearerTokenForFetch(connId: string): string {
		const token = this.bearerCache.get(connId) ?? "";
		if (!token) throw new Error("bearer_cache_miss");
		return token;
	}

	private async connectCachedBearerMcpServer(input: {
		id: string;
		url: string;
		resetExisting?: boolean;
	}): Promise<{ id: string; state: "ready" }> {
		if (input.resetExisting) {
			await this.mcp.removeServer(input.id).catch(() => undefined);
		}
		const bearerFetch = buildBearerFetch(
			() => input.id,
			(connId) => this.readBearerTokenForFetch(connId),
		);
		return connectBearerMcpServer({
			manager: this.mcp,
			id: input.id,
			url: input.url,
			bearerFetch,
		});
	}

	private async rehydrateBearerMcpServers(): Promise<void> {
		const env = this.env as Env;
		if (!isL4BearerEnabled(env)) return;
		const stub = getMailboxStub(env, this.name);
		const connections = await stub.listBearerMcpConnectionsForRehydrate();
		for (const connection of connections) {
			try {
				const envelope = bearerEnvelopeFromConnection(connection);
				if (!envelope) continue;
				const token = await decryptBearerToken(env, envelope);
				this.bearerCache.set(connection.id, token);
				await this.connectCachedBearerMcpServer({
					id: connection.id,
					url: connection.serverUrl,
					resetExisting: true,
				});
				await stub.upsertMcpConnection({
					...connection,
					transportType: connection.transportType ?? "streamable-http",
					lastState: "ready",
					lastError: null,
				});
			} catch (err) {
				const category = categoriseError(err);
				this.bearerCache.delete(connection.id);
				await this.mcp.removeServer(connection.id).catch(() => undefined);
				await stub.upsertMcpConnection({
					...connection,
					lastState: "error",
					lastError: category,
				}).catch(() => undefined);
				console.warn(
					`Bearer MCP rehydrate failed for ${this.name}/${connection.id}: ${category}`,
				);
			}
		}
	}

	override async onStart(props?: Record<string, unknown>): Promise<void> {
		await super.onStart(props);
		await this.rehydrateBearerMcpServers();
	}

	private async addExternalOAuthMcpServer(
		input: Extract<AddExternalMcpServerInput, { authType: "oauth" }>,
	): Promise<AddExternalMcpServerResult> {
		const env = this.env as Env;
		const sdk = await this.addMcpServer(input.serverName, input.url, {
			callbackHost: input.callbackHost,
		});
		const connectionInput = buildConnectionFromSdkResult({
			serverName: input.serverName,
			serverUrl: input.url,
			displayName: input.displayName,
			addedByUserId: input.addedByUserId,
			addedAt: Date.now(),
			sdk,
		});
		const stub = getMailboxStub(env, this.name);
		const connection = await stub.upsertMcpConnection(connectionInput);
		if (sdk.state === "authenticating") {
			return {
				state: "authenticating",
				connection,
				authUrl: sdk.authUrl,
			};
		}
		return { state: "ready", connection };
	}

	private async addExternalBearerMcpServer(
		input: Extract<AddExternalMcpServerInput, { authType: "bearer" }>,
	): Promise<AddExternalMcpServerResult> {
		this.requireL4BearerEnabled();
		return this.ctx.blockConcurrencyWhile(async () => {
			const env = this.env as Env;
			const encryptedBlob = await encryptBearerToken(env, input.bearerToken);
			const sdkId = crypto.randomUUID();
			this.bearerCache.set(sdkId, input.bearerToken);
			try {
				const sdk = await this.connectCachedBearerMcpServer({
					id: sdkId,
					url: input.url,
				});
				const connectionInput = buildConnectionFromSdkResult({
					serverName: input.serverName,
					serverUrl: input.url,
					displayName: input.displayName,
					addedByUserId: input.addedByUserId,
					addedAt: Date.now(),
					sdk,
					authType: "bearer",
					encryptedBlob,
					transportType: "streamable-http",
				});
				const stub = getMailboxStub(env, this.name);
				const connection = await stub.upsertMcpConnection(connectionInput);
				return { state: "ready", connection };
			} catch (err) {
				this.bearerCache.delete(sdkId);
				await this.mcp.removeServer(sdkId).catch(() => undefined);
				throw err;
			}
		});
	}

	async addExternalMcpServer(
		input: AddExternalMcpServerInput,
	): Promise<AddExternalMcpServerResult> {
		this.requireL4Enabled();
		return input.authType === "bearer"
			? this.addExternalBearerMcpServer(input)
			: this.addExternalOAuthMcpServer(input);
	}

	/**
	 * Phase 3: bind every OAuth connection's `state()` / `checkState()` to
	 * this DO's mailboxId and the current request user. See
	 * `workers/lib/mcp-oauth-provider.ts` for the binding semantics, and
	 * Pre-mortem #1 (`plan §410-423`) for the threat model.
	 */
	override createMcpOAuthProvider(callbackUrl: string) {
		return new MailboxBoundOAuthProvider(
			this.ctx.storage,
			this.name, // clientName — anchors storage keys to this DO
			callbackUrl,
			this.name, // mailboxId === DO instance id
			() => this.currentUser?.id ?? "",
		);
	}

	async removeExternalMcpServer(id: string): Promise<void> {
		this.requireL4Enabled();
		await this.removeMcpServer(id);
		this.bearerCache.delete(id);
		const env = this.env as Env;
		const stub = getMailboxStub(env, this.name);
		await stub.deleteMcpConnection(id);
	}

	async listExternalMcpServers(): Promise<readonly PublicMcpConnection[]> {
		this.requireL4Enabled();
		const env = this.env as Env;
		const stub = getMailboxStub(env, this.name);
		return stub.listMcpConnections();
	}

	async executeTask(
		task: string,
		contextSummary: string,
		taskId?: string,
	): Promise<string> {
		const env = this.env as Env;
		const mailboxId = this.name;
		const config = await getAgentConfig(env, mailboxId);
		const tools = createEmailTools(env, mailboxId, config.emailReplyEnabledSkills, null);
		const systemPrompt = resolveSystemPrompt(config.customSystemPrompt);
		const cfg = await resolveLlmConfig(env);
		const provider = getLlmProvider(env, cfg);
		const catalog = await listLlmModels(env, { cfg });
		const modelId = pickModel(catalog, config.emailReplyModel ?? config.model, cfg.defaultModel);
		const contextPrefix = contextSummary
			? `Conversation context from the user's session:\n${contextSummary}\n\n`
			: "";
		// When the caller (RouterAgent) supplies a taskId, stash an
		// AbortController so a later cancelTask(taskId) can abort the
		// generateText loop. Without taskId we still allocate a controller
		// — keeps the call shape uniform — but it's never reachable for
		// cancellation.
		const aborter = new AbortController();
		if (taskId) this.taskAborters.set(taskId, aborter);
		try {
			const result = await generateText({
				model: provider(modelId),
				system: contextPrefix + systemPrompt,
				messages: [{ role: "user", content: task }],
				tools,
				stopWhen: stepCountIs(8),
				abortSignal: aborter.signal,
			});
			return result.text || "(No response)";
		} finally {
			if (taskId) this.taskAborters.delete(taskId);
		}
	}

	/**
	 * Cancel an in-flight {@link executeTask} previously started with the
	 * given `taskId`. RouterAgent calls this when its own chat stream is
	 * aborted by the user so a delegated sub-task does not keep burning
	 * LLM tokens after the user clicked stop. Idempotent — a missing
	 * entry (task already finished) is a no-op.
	 */
	async cancelTask(taskId: string): Promise<void> {
		const aborter = this.taskAborters.get(taskId);
		if (!aborter) return;
		aborter.abort();
		this.taskAborters.delete(taskId);
	}

	override async destroy(): Promise<void> {
		this.bearerCache.clear();
		await super.destroy();
	}
}
