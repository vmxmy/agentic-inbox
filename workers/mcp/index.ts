// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	toolDraftEmail,
	toolUpdateDraft,
	toolDeleteEmail,
	toolSendReply,
	toolForwardEmail,
	toolListInvoices,
	toolGetInvoice,
	toolDeleteInvoice,
	toolReprocessInvoicesForEmail,
	toolExtractInvoiceFromPdf,
	toolUploadInvoiceFile,
	toolCreateBundle,
	toolListBundles,
	toolAddToBundle,
	toolDownloadBundle,
} from "../lib/tools";
// list_emails, get_email, get_thread, search_emails, draft_reply, send_email,
// mark_email_read, move_email — all served by the capability-driven loop at
// the end of init(). Folders / FOLDER_TOOL_DESCRIPTION / MOVE_FOLDER_TOOL_DESCRIPTION
// are no longer referenced here either.
import {
	list as listCapabilities,
	invoke as invokeCapability,
} from "../lib/capabilities";
import {
	addMailboxMember,
	assertMailboxOwner,
	AuthzError,
	getMailboxAcl,
	hasMailboxAccess,
	INTERNAL_USER_HEADER,
	isAdmin,
	listUserMailboxes,
	normalizeEmail,
	removeMailboxMember,
	signInviteToken,
	verifyInviteToken,
	type AuthUser,
} from "../lib/auth";
import {
	ALLOWED_AGENT_MODELS,
	getAgentConfig,
	setRules,
	updateAgentConfig,
} from "../lib/agent-config";
import type { Env } from "../types";

/** Wrap a plain result object into MCP content format. */
function mcpText(result: unknown) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(result, null, 2) },
		],
	};
}

/** Wrap an error string into MCP error format. */
function mcpError(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true as const,
	};
}

/**
 * Wrap a result that may contain an `error` field into MCP format,
 * automatically setting isError when appropriate.
 */
function mcpResult(result: Record<string, unknown>) {
	if ("error" in result) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
			isError: true as const,
		};
	}
	return mcpText(result);
}

/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Clients (ProtoAgent, Claude Code, Cursor, etc.) connect to the
 * `/mcp` endpoint and can list mailboxes, read/search emails,
 * draft replies, send messages, and manage folders.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "agentic-inbox",
		version: "1.0.0",
	});

	/**
	 * Per-request authenticated user email. Populated by {@link fetch} from the
	 * internal header set by the Hono layer (`workers/app.ts`). DOs serialise
	 * requests on the fetch boundary, so this field is safe to read inside
	 * tool handlers for the current request.
	 */
	private currentUserEmail: string | null = null;

	override async fetch(request: Request): Promise<Response> {
		const hdr = request.headers.get(INTERNAL_USER_HEADER);
		this.currentUserEmail = hdr ? normalizeEmail(hdr) : null;
		return super.fetch(request);
	}

	async init() {
		const env = this.env;

		const currentUser = (): AuthUser | null =>
			this.currentUserEmail
				? {
						// MCP only sees the email forwarded by the Hono layer; the ACL
						// checks below only key off `email`/`role`/`system`, so a
						// synthetic id is fine here.
						id: `mcp:${this.currentUserEmail}`,
						email: this.currentUserEmail,
						role: "user",
					}
				: null;

		/**
		 * Verify a mailbox exists AND the current MCP caller has access to it.
		 * Returns an MCP error response on failure, or null if authorised.
		 */
		const verifyMailbox = async (mailboxId: string) => {
			const user = currentUser();
			if (!user) {
				return mcpError("MCP request missing authenticated user context.");
			}
			const acl = await getMailboxAcl(env, mailboxId);
			if (!acl) {
				return mcpError(`Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`);
			}
			// Legacy mailbox with no owner → treat as not-yet-claimed; surface a
			// targeted error instead of silently auto-claiming through MCP.
			if (!acl.owner) {
				return mcpError(`Mailbox "${mailboxId}" has no owner yet — open it in the web UI once to claim it.`);
			}
			if (!hasMailboxAccess(acl, user)) {
				return mcpError(`Not authorized for mailbox "${mailboxId}".`);
			}
			return null;
		};

		/**
		 * Owner-only gate for member/invite management. Does NOT auto-claim
		 * legacy mailboxes via MCP — same stance as {@link verifyMailbox}.
		 */
		const verifyOwner = async (mailboxId: string) => {
			const user = currentUser();
			if (!user) {
				return mcpError("MCP request missing authenticated user context.");
			}
			try {
				await assertMailboxOwner(env, mailboxId, user);
				return null;
			} catch (e) {
				if (e instanceof AuthzError) return mcpError(e.message);
				throw e;
			}
		};

		/** Resolve a MailboxDO stub for a mailbox email address. */
		const mailboxStub = (mailboxId: string) =>
			env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

		// ── list_mailboxes ─────────────────────────────────────────
		this.server.tool(
			"list_mailboxes",
			"List all available mailboxes visible to the authenticated user",
			{},
			async () => {
				const user = currentUser();
				if (!user) return mcpError("MCP request missing authenticated user context.");
				const result = await listUserMailboxes(env, user);
				return mcpText(result);
			},
		);

		// list_emails / get_email / get_thread / search_emails / draft_reply
		// are registered by the capability-driven loop at the end of init().

		// ── create_draft ───────────────────────────────────────────
		this.server.tool(
			"create_draft",
			"Create a new draft email. Can be a new email or a reply draft.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
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
			async ({ mailboxId, to, subject, bodyHtml, in_reply_to, thread_id }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDraftEmail(env, mailboxId, {
					to: to || "",
					subject,
					body: bodyHtml,
					isPlainText: false,
					runVerifyDraft: true,
					in_reply_to,
					thread_id,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				// Map the response to match the original create_draft output shape
				return mcpText({
					status: "draft_created",
					draftId: result.draftId,
					threadId: result.threadId,
					message: "Draft created in Drafts folder.",
				});
			},
		);

		// ── update_draft ───────────────────────────────────────────
		this.server.tool(
			"update_draft",
			"Update an existing draft email's content.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				draftId: z.string().describe("The ID of the draft to update"),
				to: z
					.string()
					.optional()
					.describe("Updated recipient email address"),
				subject: z.string().optional().describe("Updated subject line"),
				bodyHtml: z.string().optional().describe("Updated HTML body"),
			},
			async ({ mailboxId, draftId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUpdateDraft(env, mailboxId, {
					draftId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					if (result.error === "Draft not found") {
						return {
							content: [{ type: "text" as const, text: "Draft not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── delete_email ───────────────────────────────────────────
		this.server.tool(
			"delete_email",
			"Permanently delete an email by ID.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email ID to delete"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDeleteEmail(env, mailboxId, emailId);
				return mcpResult(result);
			},
		);

		// ── send_reply ─────────────────────────────────────────────
		this.server.tool(
			"send_reply",
			"Send a reply to an email. Only call after drafting and getting confirmation.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				originalEmailId: z
					.string()
					.describe("The ID of the email being replied to"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().describe("Subject line"),
				bodyHtml: z.string().describe("The HTML body of the reply"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolSendReply(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					// Preserve the original MCP error format for send failures
					if (typeof result.error === "string" && result.error.startsWith("Failed to send")) {
						return {
							content: [{ type: "text" as const, text: result.error }],
							isError: true,
						};
					}
					if (result.error === "Original email not found") {
						return {
							content: [{ type: "text" as const, text: "Original email not found" }],
							isError: true,
						};
					}
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// send_email / mark_email_read / move_email
		// are registered by the capability-driven loop at the end of init().

		// ── whoami ─────────────────────────────────────────────────
		this.server.tool(
			"whoami",
			"Return the authenticated user's email and admin flag.",
			{},
			async () => {
				const user = currentUser();
				if (!user) return mcpError("MCP request missing authenticated user context.");
				return mcpText({
					email: user.email,
					isAdmin: isAdmin(env, user),
					system: user.system ?? false,
				});
			},
		);

		// ── list_members ───────────────────────────────────────────
		this.server.tool(
			"list_members",
			"List the owner and members of a mailbox. Any member can read this.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const acl = await getMailboxAcl(env, mailboxId);
				if (!acl) return mcpError("Mailbox not found");
				return mcpText({ owner: acl.owner ?? null, members: acl.members });
			},
		);

		// ── add_member ─────────────────────────────────────────────
		this.server.tool(
			"add_member",
			"Add a member to a mailbox. Only the mailbox owner may call this.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				email: z.string().email().describe("Member email to grant access"),
			},
			async ({ mailboxId, email }) => {
				const denied = await verifyOwner(mailboxId);
				if (denied) return denied;
				try {
					const acl = await addMailboxMember(env, mailboxId, normalizeEmail(email));
					return mcpText({ owner: acl.owner ?? null, members: acl.members });
				} catch (e) {
					return mcpError((e as Error).message);
				}
			},
		);

		// ── remove_member ──────────────────────────────────────────
		this.server.tool(
			"remove_member",
			"Remove a member from a mailbox. Only the mailbox owner may call this.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				email: z.string().email().describe("Member email to revoke"),
			},
			async ({ mailboxId, email }) => {
				const denied = await verifyOwner(mailboxId);
				if (denied) return denied;
				try {
					const acl = await removeMailboxMember(env, mailboxId, normalizeEmail(email));
					return mcpText({ owner: acl.owner ?? null, members: acl.members });
				} catch (e) {
					return mcpError((e as Error).message);
				}
			},
		);

		// ── create_invite ──────────────────────────────────────────
		this.server.tool(
			"create_invite",
			"Issue a short-lived (7 day) invite token for a mailbox. Only the mailbox owner may call this. Share the token with the invitee who then calls accept_invite.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyOwner(mailboxId);
				if (denied) return denied;
				const user = currentUser();
				if (!user) return mcpError("MCP request missing authenticated user context.");
				try {
					const { token, expiresAt } = await signInviteToken(env, mailboxId, user.email);
					return mcpText({ mailboxId, token, expiresAt });
				} catch (e) {
					if (e instanceof AuthzError) return mcpError(e.message);
					return mcpError((e as Error).message);
				}
			},
		);

		// ── accept_invite ──────────────────────────────────────────
		this.server.tool(
			"accept_invite",
			"Accept a mailbox invite token. Grants the current user member access to the mailbox named in the token.",
			{
				token: z.string().describe("Invite token issued by create_invite"),
			},
			async ({ token }) => {
				const user = currentUser();
				if (!user) return mcpError("MCP request missing authenticated user context.");
				let claims;
				try {
					claims = await verifyInviteToken(env, token);
				} catch (e) {
					if (e instanceof AuthzError) return mcpError(e.message);
					return mcpError((e as Error).message);
				}
				const acl = await getMailboxAcl(env, claims.mbx);
				if (!acl) return mcpError("Mailbox no longer exists");
				if (acl.owner !== claims.by) {
					return mcpError("Invite issuer is no longer the mailbox owner");
				}
				if (acl.owner === user.email) {
					return mcpText({
						mailboxId: claims.mbx,
						already: "owner",
						owner: acl.owner,
						members: acl.members,
					});
				}
				const next = await addMailboxMember(env, claims.mbx, user.email);
				return mcpText({
					mailboxId: claims.mbx,
					owner: next.owner ?? null,
					members: next.members,
				});
			},
		);

		// ── get_mailbox_settings ───────────────────────────────────
		this.server.tool(
			"get_mailbox_settings",
			"Read a mailbox's full settings blob (signature, auto-reply, agent config, rules, ACL).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
				if (!obj) return mcpError("Mailbox not found");
				const settings = (await obj.json()) as Record<string, unknown>;
				return mcpText({ id: mailboxId, email: mailboxId, settings });
			},
		);

		// ── update_mailbox_settings ────────────────────────────────
		this.server.tool(
			"update_mailbox_settings",
			"Replace a mailbox's settings blob. ACL fields (owner, members) are server-managed and will be stripped from the input — use add_member/remove_member for those. Recognised keys include: autoDraft (bool), agentModel (string), agentSystemPrompt (string|null), rules (array), invoiceSourceDomains (array of hostnames or leading-dot suffixes, e.g. ['.new-tax-platform.cn'] — appended to the built-in invoice-source whitelist; malformed entries are silently dropped).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				settings: z.record(z.unknown()).describe("New settings object. owner/members are ignored."),
			},
			async ({ mailboxId, settings }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const key = `mailboxes/${mailboxId}.json`;
				const existing = await env.BUCKET.get(key);
				if (!existing) return mcpError("Mailbox not found");
				const prev = (await existing.json()) as Record<string, unknown>;
				const { owner: _o, members: _m, ...clientClean } = settings;
				const merged: Record<string, unknown> = {
					...clientClean,
					owner: prev.owner,
					members: Array.isArray(prev.members) ? prev.members : [],
				};
				await env.BUCKET.put(key, JSON.stringify(merged));
				return mcpText({ id: mailboxId, email: mailboxId, settings: merged });
			},
		);

		// ── get_agent_config ───────────────────────────────────────
		this.server.tool(
			"get_agent_config",
			"Read the per-mailbox AI agent configuration: auto-draft flag, model, system prompt override, inbound-email processing rules, allowed model list.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const config = await getAgentConfig(env, mailboxId);
				return mcpText({
					autoDraft: config.autoDraft,
					model: config.model,
					customSystemPrompt: config.customSystemPrompt,
					invoiceAgentSystemPrompt: config.invoiceAgentSystemPrompt,
					rules: config.rules,
					allowedModels: ALLOWED_AGENT_MODELS,
				});
			},
		);

		// ── update_agent_config ────────────────────────────────────
		this.server.tool(
			"update_agent_config",
			`Patch the per-mailbox agent config. Omitted fields stay unchanged. Pass customSystemPrompt / invoiceAgentSystemPrompt as null to clear them. Allowed models: ${ALLOWED_AGENT_MODELS.join(", ")}.`,
			{
				mailboxId: z.string().describe("The mailbox email address"),
				autoDraft: z.boolean().optional().describe("Whether inbound email triggers an automatic draft"),
				agentModel: z.string().optional().describe("Model id — must be one of the allowed models"),
				agentSystemPrompt: z.string().nullable().optional().describe("Custom system prompt for the email agent. Null clears it."),
				invoiceAgentSystemPrompt: z.string().nullable().optional().describe("Custom system prompt for the invoice agent chat. Null clears it."),
			},
			async ({ mailboxId, autoDraft, agentModel, agentSystemPrompt, invoiceAgentSystemPrompt }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				try {
					const config = await updateAgentConfig(env, mailboxId, {
						autoDraft,
						agentModel,
						agentSystemPrompt,
						invoiceAgentSystemPrompt,
					});
					return mcpText({
						autoDraft: config.autoDraft,
						model: config.model,
						customSystemPrompt: config.customSystemPrompt,
						invoiceAgentSystemPrompt: config.invoiceAgentSystemPrompt,
					});
				} catch (e) {
					return mcpError((e as Error).message);
				}
			},
		);

		// ── list_rules ─────────────────────────────────────────────
		this.server.tool(
			"list_rules",
			"List the inbound-email processing rules for a mailbox (evaluated top-down when a new email arrives).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const config = await getAgentConfig(env, mailboxId);
				return mcpText({ rules: config.rules });
			},
		);

		// ── set_rules ──────────────────────────────────────────────
		this.server.tool(
			"set_rules",
			"Atomically replace the mailbox's rule array. Each rule: { name?, enabled?, if: {from?, fromDomain?, to?, subjectContains?[], bodyContains?[], hasAttachmentExt?[]}, then: {skipDraft?, moveTo?, markRead?, promptOverride?, extractAttachmentText?} }. Malformed rules are rejected.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				rules: z.array(z.record(z.unknown())).describe("Full replacement array of rules"),
			},
			async ({ mailboxId, rules }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				try {
					const saved = await setRules(env, mailboxId, rules);
					return mcpText({ rules: saved });
				} catch (e) {
					return mcpError((e as Error).message);
				}
			},
		);

		// ── list_folders ───────────────────────────────────────────
		this.server.tool(
			"list_folders",
			"List folders (system + custom) with unread counts.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const folders = await mailboxStub(mailboxId).getFolders();
				return mcpText({ folders });
			},
		);

		// ── create_folder ──────────────────────────────────────────
		this.server.tool(
			"create_folder",
			"Create a custom folder. The id is derived by slugifying the name (lowercase, alphanumerics + hyphens).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				name: z.string().min(1).describe("Folder display name"),
			},
			async ({ mailboxId, name }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const slug = name
					.toString()
					.toLowerCase()
					.replace(/\s+/g, "-")
					.replace(/[^\w-]+/g, "")
					.replace(/--+/g, "-")
					.replace(/^-+/, "")
					.replace(/-+$/, "");
				if (!slug) return mcpError("Folder name must contain alphanumeric characters");
				const folder = await mailboxStub(mailboxId).createFolder(slug, name);
				if (!folder) return mcpError("Folder with this name already exists");
				return mcpText({ folder });
			},
		);

		// ── rename_folder ──────────────────────────────────────────
		this.server.tool(
			"rename_folder",
			"Rename a folder. System folders (inbox, sent, draft, archive, trash) keep their id but can be renamed.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				folderId: z.string().describe("The folder id"),
				name: z.string().min(1).describe("New display name"),
			},
			async ({ mailboxId, folderId, name }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const folder = await mailboxStub(mailboxId).updateFolder(folderId, name);
				if (!folder) return mcpError("Folder not found");
				return mcpText({ folder });
			},
		);

		// ── delete_folder ──────────────────────────────────────────
		this.server.tool(
			"delete_folder",
			"Delete a custom folder. System folders cannot be deleted.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				folderId: z.string().describe("The folder id to delete"),
			},
			async ({ mailboxId, folderId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const ok = await mailboxStub(mailboxId).deleteFolder(folderId);
				if (!ok) return mcpError("Folder not found or cannot be deleted");
				return mcpText({ status: "deleted", folderId });
			},
		);

		// ── mark_thread_read ───────────────────────────────────────
		this.server.tool(
			"mark_thread_read",
			"Mark every email in a thread as read.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				threadId: z.string().describe("The thread id"),
			},
			async ({ mailboxId, threadId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				await mailboxStub(mailboxId).markThreadRead(threadId);
				return mcpText({ status: "marked_read", threadId });
			},
		);

		// ── star_email ─────────────────────────────────────────────
		this.server.tool(
			"star_email",
			"Star or unstar an email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email id"),
				starred: z.boolean().describe("true to star, false to unstar"),
			},
			async ({ mailboxId, emailId, starred }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const email = await mailboxStub(mailboxId).updateEmail(emailId, { starred });
				if (!email) return mcpError("Email not found");
				return mcpText({ status: "updated", emailId, starred });
			},
		);

		// ── forward_email ──────────────────────────────────────────
		this.server.tool(
			"forward_email",
			"Forward an existing email to a new recipient. Starts a new thread. bodyHtml is prepended to the quoted original; if omitted, only the quoted original is sent. Subject defaults to 'Fwd: <original>'.",
			{
				mailboxId: z.string().describe("The mailbox email address to send from"),
				originalEmailId: z.string().describe("The id of the email to forward"),
				to: z.string().email().describe("Recipient email address"),
				subject: z.string().optional().describe("Override subject"),
				bodyHtml: z.string().optional().describe("Optional HTML body prepended to the forwarded original"),
			},
			async ({ mailboxId, originalEmailId, to, subject, bodyHtml }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolForwardEmail(env, mailboxId, {
					originalEmailId,
					to,
					subject,
					bodyHtml,
				});
				if ("error" in result) {
					return mcpResult(result);
				}
				return mcpText(result);
			},
		);

		// ── list_invoices ──────────────────────────────────────────
		this.server.tool(
			"list_invoices",
			"List structured invoice records persisted from inbound XML 全电/增值税发票 attachments. Filters are AND-combined; sorted by issue_date DESC.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				dateFrom: z.string().optional().describe("Issue date lower bound, ISO YYYY-MM-DD inclusive"),
				dateTo: z.string().optional().describe("Issue date upper bound, ISO YYYY-MM-DD inclusive"),
				sellerContains: z.string().optional().describe("Substring match on seller_name (case-insensitive in SQLite by default)"),
				buyerContains: z.string().optional().describe("Substring match on buyer_name"),
				invoiceNumber: z.string().optional().describe("Exact invoice_number match"),
				minAmount: z.number().optional().describe("Lower bound on amount_incl_tax"),
				maxAmount: z.number().optional().describe("Upper bound on amount_incl_tax"),
				page: z.number().int().positive().optional().describe("1-indexed page number (default 1)"),
				limit: z.number().int().positive().max(200).optional().describe("Page size (default 50, max 200)"),
				itemContains: z.string().optional().describe("Filter by invoice line-item name (LIKE %X%) — finds invoices containing items whose name matches."),
			},
			async ({ mailboxId, ...filters }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolListInvoices(env, mailboxId, filters);
				return mcpText(result);
			},
		);

		// ── get_invoice ────────────────────────────────────────────
		this.server.tool(
			"get_invoice",
			"Read one invoice by id. Returns the full header (including raw_xml) plus all line items ordered by their original sequence.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				invoiceId: z.string().describe("The invoice id from list_invoices"),
			},
			async ({ mailboxId, invoiceId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolGetInvoice(env, mailboxId, invoiceId);
				if ("error" in result) return mcpError(result.error);
				return mcpText(result);
			},
		);

		// ── delete_invoice ─────────────────────────────────────────
		this.server.tool(
			"delete_invoice",
			"Delete one invoice and all its line items. Cascade only on the invoice tables — does NOT delete the source email or attachment.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				invoiceId: z.string().describe("The invoice id"),
			},
			async ({ mailboxId, invoiceId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDeleteInvoice(env, mailboxId, invoiceId);
				return mcpResult(result);
			},
		);

		// ── reprocess_invoices_for_email ────────────────────────────
		this.server.tool(
			"reprocess_invoices_for_email",
			"Re-read XML attachments of an existing email from R2, re-run the invoice parser, and persist the results. Idempotent — replaces any prior invoice rows tied to the same attachment. Use after a parser fix to avoid asking the sender to re-forward the email.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email id whose XML attachments should be re-parsed"),
			},
			async ({ mailboxId, emailId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolReprocessInvoicesForEmail(env, mailboxId, emailId);
				return mcpText(result);
			},
		);

		// ── extract_invoice_from_pdf ────────────────────────────────
		this.server.tool(
			"extract_invoice_from_pdf",
			"Run PDF OCR (DeepRead) on a specific attachment to extract invoice fields. Use as a fallback when an email only contains a PDF — no XML/OFD source. Synchronously submits + polls (up to 90s). Requires DEEPREAD_API_KEY configured on the Worker. Flags `needs_review=true` when any field requires human verification (e.g. ambiguous dates, unreadable numbers).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				attachmentId: z.string().describe("The attachment id of a PDF invoice"),
			},
			async ({ mailboxId, attachmentId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolExtractInvoiceFromPdf(env, mailboxId, attachmentId);
				return mcpResult(result as unknown as Record<string, unknown>);
			},
		);

		// ── create_bundle ──────────────────────────────────────────
		this.server.tool(
			"create_bundle",
			"Create a new reimbursement bundle (报销单). A bundle is a named collection of invoices intended for accounting submission. Returns the new bundle id.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				name: z.string().min(1).describe("Display name (e.g. '2026-04 出差报销')"),
				note: z.string().optional().describe("Optional free-text note"),
			},
			async ({ mailboxId, name, note }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolCreateBundle(env, mailboxId, {
					name,
					note: note ?? null,
				});
				return mcpText(result);
			},
		);

		// ── list_bundles ───────────────────────────────────────────
		this.server.tool(
			"list_bundles",
			"List all reimbursement bundles for a mailbox, with invoice count and total amount per bundle. Sorted by created_at DESC.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
			},
			async ({ mailboxId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolListBundles(env, mailboxId);
				return mcpText(result);
			},
		);

		// ── add_to_bundle ──────────────────────────────────────────
		this.server.tool(
			"add_to_bundle",
			"Add an invoice to a reimbursement bundle. Refuses voided invoices and red-credit (negative-correction) invoices — those have no place in a reimbursement packet. Idempotent: re-adding an already-present invoice is a no-op.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				bundleId: z.string().describe("The bundle id"),
				invoiceId: z.string().describe("The invoice id"),
			},
			async ({ mailboxId, bundleId, invoiceId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolAddToBundle(env, mailboxId, {
					bundleId,
					invoiceId,
				});
				return mcpResult(result);
			},
		);

		// ── download_bundle ────────────────────────────────────────
		this.server.tool(
			"download_bundle",
			"Pack a bundle into a ZIP (manifest.csv + every invoice's authoritative original file from R2) and return the bytes inline as base64. For browser downloads use the HTTP endpoint instead — this tool exists so chat clients can hand the packet to the user without a separate fetch.",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				bundleId: z.string().describe("The bundle id"),
			},
			async ({ mailboxId, bundleId }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolDownloadBundle(env, mailboxId, bundleId);
				if ("error" in result) return mcpError(result.error);
				return mcpText(result);
			},
		);

		// ── upload_invoice_file ────────────────────────────────────
		this.server.tool(
			"upload_invoice_file",
			"Attach an invoice file (XML / OFD / PDF / ZIP) to an existing email and run the extraction pipeline on it. Use for emails whose body only contains a short-link to a SPA preview page (e.g. 百望 u.baiwang.com short links) with no downloadable attachment — the user downloads the real invoice file themselves in a browser, then pipes the bytes here as base64. The uploaded file is persisted to R2 with origin='manual-upload'; any invoice fields found are saved via the normal pipeline (ZIP/OFD are unpacked recursively; XML inside is treated as the authoritative source).",
			{
				mailboxId: z.string().describe("The mailbox email address"),
				emailId: z.string().describe("The email id to attach the file to"),
				filename: z.string().describe("The file name including extension (e.g. 26949...xml)"),
				mimetype: z.string().optional().describe("Optional MIME type; inferred from filename when omitted"),
				content_base64: z.string().describe("File bytes encoded as base64. data: URL prefix is accepted but optional."),
			},
			async ({ mailboxId, emailId, filename, mimetype, content_base64 }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				const result = await toolUploadInvoiceFile(env, mailboxId, emailId, {
					filename,
					mimetype,
					content_base64,
				});
				return mcpText(result);
			},
		);

		// ── Capability-registry driven tools ───────────────────────
		//
		// Iterate every Capability flagged with the `mcp-tool` surface and
		// expose it via the same `this.server.tool()` shape used by the
		// hand-written blocks above. Tool names are derived from capability
		// id (`core:list-emails` → `list_emails`); the ACL gate (verifyMailbox)
		// is preserved exactly. Capabilities whose inputSchema is not a
		// `z.object` are skipped (the MCP shape needs flat field destructuring).
		for (const cap of listCapabilities({ surface: "mcp-tool" })) {
			const localId = cap.id.includes(":") ? cap.id.slice(cap.id.indexOf(":") + 1) : cap.id;
			const toolName = localId.replaceAll("-", "_");
			if (!(cap.inputSchema instanceof z.ZodObject)) {
				console.warn(
					`[mcp] skipping capability ${cap.id}: inputSchema is not a z.object`,
				);
				continue;
			}
			const shape = (cap.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
			this.server.tool(
				toolName,
				cap.description,
				{
					mailboxId: z.string().describe("The mailbox email address"),
					...shape,
				},
				async (args: Record<string, unknown>) => {
					const { mailboxId, ...input } = args as { mailboxId: string } & Record<string, unknown>;
					const denied = await verifyMailbox(mailboxId);
					if (denied) return denied;
					const result = await invokeCapability(
						{
							env,
							mailboxId,
							user: currentUser(),
							triggeredBy: "mcp",
						},
						cap.id,
						input,
					);
					if (!result.ok) return mcpResult({ error: result.error });
					return mcpText(result.value);
				},
			);
		}
	}
}
