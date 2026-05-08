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
	assertMailboxAccess,
	assertMailboxOwner,
	AuthzError,
	getMailboxAcl,
	isAdmin,
	listUserMailboxes,
	normalizeEmail,
	readInternalAuthContextHeader,
	removeMailboxMember,
	signInviteToken,
	verifyInviteToken,
	type AuthUser,
} from "../lib/auth";
import {
	getAgentConfig,
	updateAgentConfig,
} from "../lib/agent-config";
import { replaceRules } from "../lib/rules-store";
import { parseRulesLoose } from "../lib/rules";
import { listLlmModels } from "../lib/llm-models";
import {
	AGENT_CONFIG_FIELDS,
	agentSettingsPatchFromRaw,
	mailboxSettingsRowToR2Shape,
	nonAgentSettingsFromRaw,
	readUnifiedMailboxSettings,
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
	 * Per-request authenticated user, decoded from the signed internal
	 * auth-context JWT injected by the Hono layer (`workers/app.ts`). DOs
	 * serialise requests on the fetch boundary, so this field is safe to
	 * read inside tool handlers for the current request.
	 *
	 * Carries id/email/role/system end-to-end so the MCP DO does not need to
	 * round-trip D1 to recover role for admin-only paths.
	 */
	private currentUser: AuthUser | null = null;

	override async fetch(request: Request): Promise<Response> {
		this.currentUser = await readInternalAuthContextHeader(request, this.env);
		return super.fetch(request);
	}

	async init() {
		const env = this.env;

		const currentUser = (): AuthUser | null => this.currentUser;

		/**
		 * Verify a mailbox exists AND the current MCP caller has access to it.
		 * Returns an MCP error response on failure, or null if authorised.
		 */
		const verifyMailbox = async (mailboxId: string) => {
			const user = currentUser();
			if (!user) {
				return mcpError("MCP request missing authenticated user context.");
			}
			try {
				await assertMailboxAccess(env, mailboxId, user);
			} catch (e) {
				if (e instanceof AuthzError) {
					return mcpError(
						e.status === 404
							? `Mailbox "${mailboxId}" not found. Use list_mailboxes to see available mailboxes.`
							: e.message,
					);
				}
				throw e;
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
				const doRow = await readUnifiedMailboxSettings(env, mailboxId);
				if (!doRow) return mcpError("Mailbox not found");
				return mcpText({
					id: mailboxId,
					email: mailboxId,
					settings: mailboxSettingsRowToR2Shape(doRow),
				});
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
				if (!(await getMailboxAcl(env, mailboxId))) {
					return mcpError("Mailbox not found");
				}
				const { owner: _o, members: _m, ...clientClean } = settings;
				const agentPatch: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(clientClean)) {
					if ((AGENT_CONFIG_FIELDS as readonly string[]).includes(k)) {
						agentPatch[k] = v;
					}
				}
				const patch = agentSettingsPatchFromRaw(agentPatch);
				patch.nonAgentSettings = nonAgentSettingsFromRaw(clientClean);
				const doRow = await mailboxStub(mailboxId).updateMailboxSettings(patch);
				const acl = await getMailboxAcl(env, mailboxId);
				const unified: Record<string, unknown> = {
					...mailboxSettingsRowToR2Shape(doRow),
					owner: acl?.owner,
					members: acl?.members ?? [],
				};
				return mcpText({ id: mailboxId, email: mailboxId, settings: unified });
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
				const catalog = await listLlmModels(env);
				return mcpText({
					autoDraft: config.autoDraft,
					model: config.model,
					emailReplyModel: config.emailReplyModel,
					customSystemPrompt: config.customSystemPrompt,
					rules: config.rules,
					availableModels: catalog.map((m) => m.id),
				});
			},
		);

		// ── update_agent_config ────────────────────────────────────
		this.server.tool(
			"update_agent_config",
			`Patch the per-mailbox agent config. Omitted fields stay unchanged. Pass customSystemPrompt as null to clear it. Pass null on emailReplyModel to clear it (it then falls back to the legacy shared agentModel, then env default). Model ids must exist on the configured LLM endpoint's /v1/models list (call get_agent_config to see availableModels).`,
			{
				mailboxId: z.string().describe("The mailbox email address"),
				autoDraft: z.boolean().optional().describe("Whether inbound email triggers an automatic draft"),
				agentModel: z.string().optional().describe("Legacy shared model — kept for back-compat. Prefer emailReplyModel."),
				emailReplyModel: z.string().nullable().optional().describe("Model id used by the EmailAgent. Null clears the per-agent override."),
				agentSystemPrompt: z.string().nullable().optional().describe("Custom system prompt for the email agent. Null clears it."),
			},
			async ({ mailboxId, autoDraft, agentModel, emailReplyModel, agentSystemPrompt }) => {
				const denied = await verifyMailbox(mailboxId);
				if (denied) return denied;
				try {
					const config = await updateAgentConfig(env, mailboxId, {
						autoDraft,
						agentModel,
						emailReplyModel,
						agentSystemPrompt,
					});
					return mcpText({
						autoDraft: config.autoDraft,
						model: config.model,
						emailReplyModel: config.emailReplyModel,
						customSystemPrompt: config.customSystemPrompt,
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
					const parsed = parseRulesLoose({ rules } as Record<string, unknown>);
					const saved = await replaceRules(env, mailboxId, {
						rules: parsed.map((r) => ({
							name: r.name ?? null,
							enabled: r.enabled,
							if: r.if,
							then: r.then,
						})),
						expectedVersions: {},
						actor: currentUser()?.email ?? "mcp",
					});
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
