// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tool capability registry — Phase 3 of the inbox-agent-tool framework.
 *
 * Defines a single source of truth for every email operation exposed to
 * the chat agent (`agent` surface) and the MCP server (`mcp` surface).
 *
 * Design notes
 * ------------
 * - Capabilities are **registered up-front** as plain descriptors. Both
 *   the agent runtime and the MCP server enumerate from this registry
 *   instead of building parallel hardcoded definitions.
 * - Resolution is **deny-by-default**: a tool is only available when it
 *   is registered, declares the requested surface, and is permitted by
 *   the effective inbox + agent profile policy.
 * - Business logic lives in `workers/lib/tools.ts`. This module only
 *   wraps those functions with surface-specific adapters (input schemas,
 *   output shaping). It deliberately does not duplicate behavior.
 * - The agent and MCP surfaces can use slightly different inputs for the
 *   same capability (e.g. agent's `draft_reply` takes plain-text `body`,
 *   MCP's takes `bodyHtml`). Each surface adapter on a capability owns
 *   its own input schema and result-shaping.
 *
 * Transitional empty-list behavior (Phase 3)
 * ------------------------------------------
 * The default agent profile and most legacy inboxes have empty
 * `enabledToolIds`. To preserve current behavior for unconfigured
 * inboxes, an empty list is interpreted as "all built-in tools for this
 * surface are available". A non-empty list narrows availability to the
 * intersection. When a future phase introduces an explicit opt-in flow,
 * this transitional behavior can be tightened.
 */

import { z } from "zod";
import type { ZodRawShape, ZodTypeAny } from "zod";
import {
	Folders,
	FOLDER_TOOL_DESCRIPTION,
	MOVE_FOLDER_TOOL_DESCRIPTION,
} from "../../shared/folders";
import {
	toolListMailboxes,
	toolListEmails,
	toolGetEmail,
	toolGetThread,
	toolSearchEmails,
	toolDraftReply,
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolSendEmail,
	toolMarkEmailRead,
	toolMoveEmail,
	toolDiscardDraft,
} from "./tools";
import type { InboxProfile } from "./inbox-profile";
import type { AgentProfile } from "./agent-profile";
import type { Env } from "../types";

// ── Surface and permission types ───────────────────────────────────

export type ToolSurface = "agent" | "mcp";

export interface ToolPermissions {
	/** Mutates inbox state (drafts, folders, read flags). */
	mutates: boolean;
	/** Sends mail to the outside world. */
	sendsMail: boolean;
	/** Operates without an inbox context (e.g. list_mailboxes). */
	global?: boolean;
}

// ── Execution context ──────────────────────────────────────────────

/**
 * Context passed to every capability executor. Inbox-scoped capabilities
 * receive a non-null `inboxProfile` and `mailboxId`. Global capabilities
 * (currently only `list_mailboxes`) may receive null inbox fields.
 */
export interface ToolExecutionContext {
	env: Env;
	surface: ToolSurface;
	mailboxId: string | null;
	canonicalAddress: string | null;
	inboxProfile: InboxProfile | null;
	agentProfile: AgentProfile | null;
}

// ── MCP result shape ───────────────────────────────────────────────

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

// ── Capability descriptor ──────────────────────────────────────────

export interface AgentSurfaceAdapter {
	/** Optional override for the surface-facing description. */
	description?: string;
	inputSchema: z.ZodObject<ZodRawShape>;
	execute: (
		input: Record<string, unknown>,
		ctx: ToolExecutionContext,
	) => Promise<unknown>;
}

export interface McpSurfaceAdapter {
	/** Optional override for the surface-facing description. */
	description?: string;
	/** Raw zod shape for `server.tool(...)`. Must include `mailboxId` unless capability is global. */
	inputShape: ZodRawShape;
	execute: (
		input: Record<string, unknown>,
		ctx: ToolExecutionContext,
	) => Promise<McpToolResult>;
}

export interface ToolCapability {
	id: string;
	displayName: string;
	description: string;
	surfaces: ToolSurface[];
	permissions: ToolPermissions;
	agent?: AgentSurfaceAdapter;
	mcp?: McpSurfaceAdapter;
}

// ── Internal helpers ───────────────────────────────────────────────

function mcpText(result: unknown): McpToolResult {
	return {
		content: [
			{ type: "text", text: JSON.stringify(result, null, 2) },
		],
	};
}

function mcpError(message: string): McpToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: message }) }],
		isError: true,
	};
}

function mcpResult(result: Record<string, unknown>): McpToolResult {
	if ("error" in result) {
		return {
			content: [
				{ type: "text", text: JSON.stringify(result, null, 2) },
			],
			isError: true,
		};
	}
	return mcpText(result);
}

// Common MCP fields
const mcpMailboxIdField: Record<string, ZodTypeAny> = {
	mailboxId: z
		.string()
		.describe("The mailbox email address (e.g. user@example.com)"),
};

// ── Capability descriptors ─────────────────────────────────────────
// Each capability wraps shared business logic from workers/lib/tools.ts.
// Keep these declarations focused: schema + execute, no new business logic.

const listMailboxes: ToolCapability = {
	id: "list_mailboxes",
	displayName: "List mailboxes",
	description: "List all available mailboxes",
	surfaces: ["mcp"],
	permissions: { mutates: false, sendsMail: false, global: true },
	mcp: {
		inputShape: {},
		execute: async (_input, ctx) => mcpText(await toolListMailboxes(ctx.env)),
	},
};

const listEmails: ToolCapability = {
	id: "list_emails",
	displayName: "List emails",
	description:
		"List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: false, sendsMail: false },
	agent: {
		description:
			"List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id). Use folder='inbox' for received emails, 'sent' for sent emails.",
		inputSchema: z.object({
			folder: z
				.string()
				.default(Folders.INBOX)
				.describe(FOLDER_TOOL_DESCRIPTION),
			limit: z
				.number()
				.default(20)
				.describe("Maximum number of emails to return"),
			page: z
				.number()
				.default(1)
				.describe("Page number for pagination"),
		}),
		execute: async (input, ctx) => {
			const { folder, limit, page } = input as {
				folder: string;
				limit: number;
				page: number;
			};
			return toolListEmails(ctx.env, ctx.mailboxId as string, {
				folder,
				limit,
				page,
			});
		},
	},
	mcp: {
		description:
			"List emails in a mailbox folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
		inputShape: {
			...mcpMailboxIdField,
			folder: z
				.string()
				.default(Folders.INBOX)
				.describe(FOLDER_TOOL_DESCRIPTION),
			limit: z
				.number()
				.default(20)
				.describe("Maximum number of emails to return"),
			page: z
				.number()
				.default(1)
				.describe("Page number for pagination"),
		},
		execute: async (input, ctx) => {
			const { folder, limit, page } = input as {
				folder: string;
				limit: number;
				page: number;
			};
			return mcpText(
				await toolListEmails(ctx.env, ctx.mailboxId as string, {
					folder,
					limit,
					page,
				}),
			);
		},
	},
};

const getEmail: ToolCapability = {
	id: "get_email",
	displayName: "Get email",
	description: "Get a single email with its full body content.",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: false, sendsMail: false },
	agent: {
		description:
			"Get a single email with its full body content and attachments. Use this to read the actual content of an email.",
		inputSchema: z.object({
			emailId: z.string().describe("The email ID to retrieve"),
		}),
		execute: async (input, ctx) => {
			const { emailId } = input as { emailId: string };
			return toolGetEmail(ctx.env, ctx.mailboxId as string, emailId);
		},
	},
	mcp: {
		description:
			"Get a single email with its full body content. Use this to read the actual content of an email.",
		inputShape: {
			...mcpMailboxIdField,
			emailId: z.string().describe("The email ID to retrieve"),
		},
		execute: async (input, ctx) => {
			const { emailId } = input as { emailId: string };
			const result = await toolGetEmail(
				ctx.env,
				ctx.mailboxId as string,
				emailId,
			);
			if ("error" in result) {
				return {
					content: [{ type: "text", text: "Email not found" }],
					isError: true,
				};
			}
			return mcpText(result);
		},
	},
};

const getThread: ToolCapability = {
	id: "get_thread",
	displayName: "Get thread",
	description:
		"Get all emails in a conversation thread, sorted chronologically.",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: false, sendsMail: false },
	agent: {
		description:
			"Get all emails in a conversation thread. This is essential for understanding the full context of a conversation before drafting a response. Returns all messages sorted chronologically.",
		inputSchema: z.object({
			threadId: z
				.string()
				.describe(
					"The thread_id to retrieve all messages for. Get this from an email's thread_id field.",
				),
		}),
		execute: async (input, ctx) => {
			const { threadId } = input as { threadId: string };
			return toolGetThread(ctx.env, ctx.mailboxId as string, threadId);
		},
	},
	mcp: {
		description:
			"Get all emails in a conversation thread. Returns all messages sorted chronologically.",
		inputShape: {
			...mcpMailboxIdField,
			threadId: z
				.string()
				.describe("The thread_id to retrieve all messages for"),
		},
		execute: async (input, ctx) => {
			const { threadId } = input as { threadId: string };
			return mcpText(
				await toolGetThread(ctx.env, ctx.mailboxId as string, threadId),
			);
		},
	},
};

const searchEmails: ToolCapability = {
	id: "search_emails",
	displayName: "Search emails",
	description: "Search for emails matching a query across subject and body.",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: false, sendsMail: false },
	agent: {
		description:
			"Search for emails matching a query across subject and body fields.",
		inputSchema: z.object({
			query: z
				.string()
				.describe("Search query to match against subject and body"),
			folder: z
				.string()
				.optional()
				.describe("Optional folder to restrict search to"),
		}),
		execute: async (input, ctx) => {
			const { query, folder } = input as {
				query: string;
				folder?: string;
			};
			return toolSearchEmails(ctx.env, ctx.mailboxId as string, {
				query,
				folder,
			});
		},
	},
	mcp: {
		description:
			"Search for emails matching a query across subject and body fields.",
		inputShape: {
			...mcpMailboxIdField,
			query: z
				.string()
				.describe("Search query to match against subject and body"),
			folder: z
				.string()
				.optional()
				.describe("Optional folder to restrict search to"),
		},
		execute: async (input, ctx) => {
			const { query, folder } = input as {
				query: string;
				folder?: string;
			};
			return mcpText(
				await toolSearchEmails(ctx.env, ctx.mailboxId as string, {
					query,
					folder,
				}),
			);
		},
	},
};

const draftEmail: ToolCapability = {
	id: "draft_email",
	displayName: "Draft new email",
	description: "Draft a new outbound email and save it to the Drafts folder.",
	surfaces: ["agent"],
	permissions: { mutates: true, sendsMail: false },
	agent: {
		description:
			"Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review. Use this for composing new outbound emails. Write the body as plain text — no HTML tags.",
		inputSchema: z.object({
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line"),
			body: z
				.string()
				.describe(
					"The plain text body of the email. No HTML — just write normally.",
				),
		}),
		execute: async (input, ctx) => {
			const { to, subject, body } = input as {
				to: string;
				subject: string;
				body: string;
			};
			return toolDraftEmail(ctx.env, ctx.mailboxId as string, {
				to,
				subject,
				body,
				isPlainText: true,
			});
		},
	},
};

const draftReply: ToolCapability = {
	id: "draft_reply",
	displayName: "Draft reply",
	description: "Draft a reply to an existing email.",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: true, sendsMail: false },
	agent: {
		description:
			"Draft a reply to an existing email and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review and send from the UI. Write the body as plain text — no HTML tags.",
		inputSchema: z.object({
			originalEmailId: z
				.string()
				.describe("The ID of the email being replied to"),
			to: z.string().email().describe("Recipient email address"),
			subject: z
				.string()
				.describe("Subject line (usually 'Re: ...')"),
			body: z
				.string()
				.describe(
					"The plain text body of the reply. No HTML — just write normally.",
				),
		}),
		execute: async (input, ctx) => {
			const { originalEmailId, to, subject, body } = input as {
				originalEmailId: string;
				to: string;
				subject: string;
				body: string;
			};
			return toolDraftReply(ctx.env, ctx.mailboxId as string, {
				originalEmailId,
				to,
				subject,
				body,
				isPlainText: true,
				runVerifyDraft: true,
			});
		},
	},
	mcp: {
		description:
			"Draft a reply to an email and save it to the Drafts folder. Does NOT send — saves a draft for review.",
		inputShape: {
			...mcpMailboxIdField,
			originalEmailId: z
				.string()
				.describe("The ID of the email being replied to"),
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line (usually 'Re: ...')"),
			bodyHtml: z.string().describe("The HTML body of the reply"),
		},
		execute: async (input, ctx) => {
			const { originalEmailId, to, subject, bodyHtml } = input as {
				originalEmailId: string;
				to: string;
				subject: string;
				bodyHtml: string;
			};
			const result = await toolDraftReply(
				ctx.env,
				ctx.mailboxId as string,
				{
					originalEmailId,
					to,
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
				},
			);
			return mcpResult(result as Record<string, unknown>);
		},
	},
};

const createDraft: ToolCapability = {
	id: "create_draft",
	displayName: "Create draft",
	description: "Create a new draft email. Can be a new email or a reply draft.",
	surfaces: ["mcp"],
	permissions: { mutates: true, sendsMail: false },
	mcp: {
		inputShape: {
			...mcpMailboxIdField,
			to: z
				.string()
				.optional()
				.describe("Recipient email address (optional for early drafts)"),
			subject: z.string().describe("Subject line"),
			bodyHtml: z.string().describe("The HTML body of the draft"),
			in_reply_to: z
				.string()
				.optional()
				.describe("The ID of the email this draft is replying to (optional)"),
			thread_id: z
				.string()
				.optional()
				.describe("Thread ID to attach this draft to (optional)"),
		},
		execute: async (input, ctx) => {
			const { to, subject, bodyHtml, in_reply_to, thread_id } = input as {
				to?: string;
				subject: string;
				bodyHtml: string;
				in_reply_to?: string;
				thread_id?: string;
			};
			const result = await toolDraftEmail(
				ctx.env,
				ctx.mailboxId as string,
				{
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					in_reply_to,
					thread_id,
				},
			);
			if ("error" in result) {
				return mcpResult(result as Record<string, unknown>);
			}
			// Preserve the original create_draft response shape
			return mcpText({
				status: "draft_created",
				draftId: result.draftId,
				threadId: result.threadId,
				message: "Draft created in Drafts folder.",
			});
		},
	},
};

const updateDraft: ToolCapability = {
	id: "update_draft",
	displayName: "Update draft",
	description: "Update an existing draft email's content.",
	surfaces: ["mcp"],
	permissions: { mutates: true, sendsMail: false },
	mcp: {
		inputShape: {
			...mcpMailboxIdField,
			draftId: z.string().describe("The ID of the draft to update"),
			to: z.string().optional().describe("Updated recipient email address"),
			subject: z.string().optional().describe("Updated subject line"),
			bodyHtml: z.string().optional().describe("Updated HTML body"),
		},
		execute: async (input, ctx) => {
			const { draftId, to, subject, bodyHtml } = input as {
				draftId: string;
				to?: string;
				subject?: string;
				bodyHtml?: string;
			};
			const result = await toolUpdateDraft(
				ctx.env,
				ctx.mailboxId as string,
				{ draftId, to, subject, bodyHtml },
			);
			if ("error" in result) {
				if (result.error === "Draft not found") {
					return {
						content: [{ type: "text", text: "Draft not found" }],
						isError: true,
					};
				}
				return mcpResult(result as Record<string, unknown>);
			}
			return mcpText(result);
		},
	},
};

const deleteEmail: ToolCapability = {
	id: "delete_email",
	displayName: "Delete email",
	description: "Permanently delete an email by ID.",
	surfaces: ["mcp"],
	permissions: { mutates: true, sendsMail: false },
	mcp: {
		inputShape: {
			...mcpMailboxIdField,
			emailId: z.string().describe("The email ID to delete"),
		},
		execute: async (input, ctx) => {
			const { emailId } = input as { emailId: string };
			const result = await toolDeleteEmail(
				ctx.env,
				ctx.mailboxId as string,
				emailId,
			);
			return mcpResult(result as Record<string, unknown>);
		},
	},
};

const sendReply: ToolCapability = {
	id: "send_reply",
	displayName: "Send reply",
	description: "Send a reply to an email. Only after confirmation.",
	surfaces: ["mcp"],
	permissions: { mutates: true, sendsMail: true },
	mcp: {
		inputShape: {
			mailboxId: z
				.string()
				.describe("The mailbox email address to send from"),
			originalEmailId: z
				.string()
				.describe("The ID of the email being replied to"),
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line"),
			bodyHtml: z.string().describe("The HTML body of the reply"),
		},
		execute: async (input, ctx) => {
			const { originalEmailId, to, subject, bodyHtml } = input as {
				originalEmailId: string;
				to: string;
				subject: string;
				bodyHtml: string;
			};
			const result = await toolSendReply(
				ctx.env,
				ctx.mailboxId as string,
				{ originalEmailId, to, subject, bodyHtml },
			);
			if ("error" in result) {
				if (
					typeof result.error === "string" &&
					result.error.startsWith("Failed to send")
				) {
					return {
						content: [{ type: "text", text: result.error }],
						isError: true,
					};
				}
				if (result.error === "Original email not found") {
					return {
						content: [{ type: "text", text: "Original email not found" }],
						isError: true,
					};
				}
				return mcpResult(result as Record<string, unknown>);
			}
			return mcpText(result);
		},
	},
};

const sendEmail: ToolCapability = {
	id: "send_email",
	displayName: "Send email",
	description: "Send a new email (not a reply). Only after confirmation.",
	surfaces: ["mcp"],
	permissions: { mutates: true, sendsMail: true },
	mcp: {
		inputShape: {
			mailboxId: z
				.string()
				.describe("The mailbox email address to send from"),
			to: z.string().email().describe("Recipient email address"),
			subject: z.string().describe("Subject line"),
			bodyHtml: z.string().describe("The HTML body of the email"),
		},
		execute: async (input, ctx) => {
			const { to, subject, bodyHtml } = input as {
				to: string;
				subject: string;
				bodyHtml: string;
			};
			const result = await toolSendEmail(ctx.env, ctx.mailboxId as string, {
				to,
				subject,
				bodyHtml,
			});
			if ("error" in result) {
				if (
					typeof result.error === "string" &&
					result.error.startsWith("Failed to send")
				) {
					return {
						content: [{ type: "text", text: result.error }],
						isError: true,
					};
				}
				return mcpResult(result as Record<string, unknown>);
			}
			return mcpText(result);
		},
	},
};

const markEmailRead: ToolCapability = {
	id: "mark_email_read",
	displayName: "Mark email read/unread",
	description: "Mark an email as read or unread.",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: true, sendsMail: false },
	agent: {
		inputSchema: z.object({
			emailId: z.string().describe("The email ID"),
			read: z
				.boolean()
				.describe("true to mark as read, false for unread"),
		}),
		execute: async (input, ctx) => {
			const { emailId, read } = input as {
				emailId: string;
				read: boolean;
			};
			return toolMarkEmailRead(
				ctx.env,
				ctx.mailboxId as string,
				emailId,
				read,
			);
		},
	},
	mcp: {
		inputShape: {
			...mcpMailboxIdField,
			emailId: z.string().describe("The email ID"),
			read: z.boolean().describe("true to mark as read, false for unread"),
		},
		execute: async (input, ctx) => {
			const { emailId, read } = input as {
				emailId: string;
				read: boolean;
			};
			return mcpText(
				await toolMarkEmailRead(
					ctx.env,
					ctx.mailboxId as string,
					emailId,
					read,
				),
			);
		},
	},
};

const moveEmail: ToolCapability = {
	id: "move_email",
	displayName: "Move email",
	description:
		"Move an email to a different folder (inbox, sent, draft, archive, trash).",
	surfaces: ["agent", "mcp"],
	permissions: { mutates: true, sendsMail: false },
	agent: {
		inputSchema: z.object({
			emailId: z.string().describe("The email ID"),
			folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
		}),
		execute: async (input, ctx) => {
			const { emailId, folderId } = input as {
				emailId: string;
				folderId: string;
			};
			return toolMoveEmail(
				ctx.env,
				ctx.mailboxId as string,
				emailId,
				folderId,
			);
		},
	},
	mcp: {
		inputShape: {
			...mcpMailboxIdField,
			emailId: z.string().describe("The email ID"),
			folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
		},
		execute: async (input, ctx) => {
			const { emailId, folderId } = input as {
				emailId: string;
				folderId: string;
			};
			const result = await toolMoveEmail(
				ctx.env,
				ctx.mailboxId as string,
				emailId,
				folderId,
			);
			if ("error" in result) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ error: "Failed to move email" }),
						},
					],
					isError: true,
				};
			}
			return mcpText(result);
		},
	},
};

const discardDraft: ToolCapability = {
	id: "discard_draft",
	displayName: "Discard draft",
	description: "Delete a draft email.",
	surfaces: ["agent"],
	permissions: { mutates: true, sendsMail: false },
	agent: {
		description:
			"Delete a draft email. Use this to discard drafts that are no longer needed or were rejected by the operator.",
		inputSchema: z.object({
			draftId: z.string().describe("The ID of the draft to delete"),
		}),
		execute: async (input, ctx) => {
			const { draftId } = input as { draftId: string };
			return toolDiscardDraft(ctx.env, ctx.mailboxId as string, draftId);
		},
	},
};

// ── Built-in registry ──────────────────────────────────────────────

const BUILTIN_CAPABILITIES: ToolCapability[] = [
	listMailboxes,
	listEmails,
	getEmail,
	getThread,
	searchEmails,
	draftEmail,
	draftReply,
	createDraft,
	updateDraft,
	deleteEmail,
	sendReply,
	sendEmail,
	markEmailRead,
	moveEmail,
	discardDraft,
];

const BUILTIN_BY_ID: Map<string, ToolCapability> = new Map(
	BUILTIN_CAPABILITIES.map((c) => [c.id, c]),
);

// ── Registry helpers ───────────────────────────────────────────────

/** Look up a registered capability by id. */
export function getToolCapability(id: string): ToolCapability | undefined {
	return BUILTIN_BY_ID.get(id);
}

/** Return every registered built-in capability (read-only snapshot). */
export function listBuiltinCapabilities(): ReadonlyArray<ToolCapability> {
	return BUILTIN_CAPABILITIES;
}

function capabilitySupports(
	cap: ToolCapability,
	surface: ToolSurface,
): boolean {
	if (!cap.surfaces.includes(surface)) return false;
	if (surface === "agent" && !cap.agent) return false;
	if (surface === "mcp" && !cap.mcp) return false;
	return true;
}

/**
 * Compute the effective enabled-tool allow-list for an inbox+agent pair.
 *
 * Transitional Phase 3 rule:
 *   - If both lists are empty → all built-in capabilities for the surface
 *     are allowed (preserves legacy behavior for unconfigured inboxes).
 *   - If only one list is non-empty → that list is the allow-list.
 *   - If both are non-empty → the intersection is the allow-list.
 *
 * Returns null when "no narrowing applies" (i.e. allow all built-ins).
 */
function effectiveEnabledIds(
	inboxProfile: InboxProfile | null,
	agentProfile: AgentProfile | null,
): Set<string> | null {
	const inboxIds = inboxProfile?.enabledToolIds ?? [];
	const agentIds = agentProfile?.enabledToolIds ?? [];
	if (inboxIds.length === 0 && agentIds.length === 0) return null;
	if (inboxIds.length === 0) return new Set(agentIds);
	if (agentIds.length === 0) return new Set(inboxIds);
	const inboxSet = new Set(inboxIds);
	return new Set(agentIds.filter((id) => inboxSet.has(id)));
}

/**
 * Return capabilities available for a given surface under a given context.
 * Deny-by-default: unregistered ids are silently dropped, surface mismatch
 * filters the descriptor out, and the effective allow-list narrows further.
 */
export function getAvailableToolCapabilities(
	ctx: Pick<ToolExecutionContext, "inboxProfile" | "agentProfile">,
	surface: ToolSurface,
): ToolCapability[] {
	const allow = effectiveEnabledIds(ctx.inboxProfile, ctx.agentProfile);
	return BUILTIN_CAPABILITIES.filter((cap) => {
		if (!capabilitySupports(cap, surface)) return false;
		if (allow && !allow.has(cap.id)) return false;
		return true;
	});
}

/**
 * Resolve a capability for execution. Returns the capability when it is
 * registered, supports the surface, and is enabled for the context.
 * Returns null otherwise — caller MUST treat null as "not authorized".
 */
export function resolveExecutableCapability(
	id: string,
	ctx: Pick<ToolExecutionContext, "inboxProfile" | "agentProfile">,
	surface: ToolSurface,
): ToolCapability | null {
	const cap = BUILTIN_BY_ID.get(id);
	if (!cap) return null;
	if (!capabilitySupports(cap, surface)) return null;
	const allow = effectiveEnabledIds(ctx.inboxProfile, ctx.agentProfile);
	if (allow && !allow.has(cap.id)) return null;
	return cap;
}

// ── Agent tool set construction ────────────────────────────────────

/**
 * Shape compatible with AI SDK v6 streamText/generateText `tools` option.
 * Defining as a plain record avoids `tool()` overload issues and matches
 * the previous `defineTool` helper used in EmailAgent.
 */
export interface AgentSdkToolEntry {
	description: string;
	inputSchema: z.ZodObject<ZodRawShape>;
	execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export type AgentSdkToolSet = Record<string, AgentSdkToolEntry>;

/**
 * Build the AI-SDK-compatible tool map for the chat agent. Filters by
 * the inbox/agent profile policy and the `agent` surface.
 *
 * Execution is wrapped through `resolveExecutableCapability` so that even
 * if a tool somehow gets invoked after being filtered out, it is rejected.
 */
export function createAgentToolSet(ctx: ToolExecutionContext): AgentSdkToolSet {
	const out: AgentSdkToolSet = {};
	const available = getAvailableToolCapabilities(ctx, "agent");
	for (const cap of available) {
		const adapter = cap.agent;
		if (!adapter) continue;
		const description = adapter.description ?? cap.description;
		out[cap.id] = {
			description,
			inputSchema: adapter.inputSchema,
			execute: async (input: Record<string, unknown>) => {
				const authorized = resolveExecutableCapability(cap.id, ctx, "agent");
				if (!authorized || !authorized.agent) {
					return {
						error: `Tool '${cap.id}' is not available for this inbox.`,
					};
				}
				return authorized.agent.execute(input, ctx);
			},
		};
	}
	return out;
}

// ── MCP server registration ────────────────────────────────────────

/**
 * Minimal interface the MCP server exposes for tool registration. The
 * upstream `McpServer.tool` has many overloads; we only need the
 * `(name, description, paramsShape, callback)` form. The signature is
 * intentionally widened with `unknown` parameters and an `any` callback
 * return so the structural cast at the call site does not have to fight
 * the SDK's overload resolution.
 */
export interface McpServerLike {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tool: (...args: any[]) => unknown;
}

/**
 * Hook the MCP server invokes once a request arrives so that per-request
 * inbox/agent profiles can be resolved before executing a capability.
 *
 * Returning null/undefined means "mailbox not found"; the registered
 * handler will then return a standard MCP "mailbox not found" error.
 */
export type McpProfileResolver = (mailboxId: string) => Promise<{
	inboxProfile: InboxProfile;
	agentProfile: AgentProfile;
} | null>;

/**
 * Register every MCP-surface capability against an MCP server using the
 * shared registry. Each handler resolves the inbox/agent profile per
 * request so that filtering and execution see live policy.
 */
export function registerMcpToolsFromRegistry(
	server: McpServerLike,
	env: Env,
	resolveProfiles: McpProfileResolver,
): void {
	for (const cap of BUILTIN_CAPABILITIES) {
		const adapter = cap.mcp;
		if (!adapter || !cap.surfaces.includes("mcp")) continue;

		const description = adapter.description ?? cap.description;

		server.tool(cap.id, description, adapter.inputShape, async (input) => {
			// Global capabilities (no mailboxId) — currently only list_mailboxes.
			if (cap.permissions.global) {
				const ctx: ToolExecutionContext = {
					env,
					surface: "mcp",
					mailboxId: null,
					canonicalAddress: null,
					inboxProfile: null,
					agentProfile: null,
				};
				return adapter.execute(input, ctx);
			}

			const mailboxId = (input as { mailboxId?: unknown }).mailboxId;
			if (typeof mailboxId !== "string" || mailboxId.length === 0) {
				return mcpError(
					`Mailbox id is required for tool "${cap.id}".`,
				);
			}

			const profiles = await resolveProfiles(mailboxId);
			if (!profiles) {
				return mcpError(
					`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`,
				);
			}

			const ctx: ToolExecutionContext = {
				env,
				surface: "mcp",
				mailboxId: profiles.inboxProfile.storageMailboxId,
				canonicalAddress: profiles.inboxProfile.canonicalAddress,
				inboxProfile: profiles.inboxProfile,
				agentProfile: profiles.agentProfile,
			};

			const authorized = resolveExecutableCapability(cap.id, ctx, "mcp");
			if (!authorized || !authorized.mcp) {
				return mcpError(
					`Tool "${cap.id}" is not available for mailbox "${mailboxId}".`,
				);
			}

			return authorized.mcp.execute(input, ctx);
		});
	}
}
