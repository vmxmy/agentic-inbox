// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { resolveAgentProfile } from "./lib/agent-profile";
import {
	buildUserOwnedInboxSettings,
	defaultRootDomain,
	deriveUserOwnedInboxAddress,
	ensureUserMetadata,
	readUserOwnedInboxMetadata,
	userOwnedInboxExists,
	validateInboxSubname,
} from "./lib/user-owned-inbox";
import {
	ensureSettingsInboxProfile,
	getMailboxStubForInbox,
	listInboxProfiles,
	loadInboxProfile,
	loadMailboxSettings,
	mailboxSettingsKey,
	mergeSettingsPreservingInboxProfile,
	normalizeInboxAddress,
	resolveInboundInboxProfile,
} from "./lib/inbox-profile";
import {
	appendInboxAgentConfigAudit,
	applyInboxAgentConfigUpdate,
	buildInboxAgentConfigOptions,
	buildInboxAgentConfigResponse,
	checkStructuredConfigEligibility,
	validateInboxAgentConfigPatch,
} from "./lib/inbox-agent-config";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const CreateInboxBody = z.object({
	displayName: z.string().trim().min(1).max(120),
	subname: z.string().trim().min(1).max(128),
}).strict();

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

function configuredEmailAddresses(env: Env): string[] {
	const value = env.EMAIL_ADDRESSES as unknown;
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === "string") {
		return value.split(",").map((address) => address.trim()).filter(Boolean);
	}
	return [];
}

function mailboxResponse(profile: Awaited<ReturnType<typeof listInboxProfiles>>[number]) {
	const userOwnedInbox = readUserOwnedInboxMetadata(profile.settings);
	const displayName = profile.displayName || profile.canonicalAddress;
	return {
		id: profile.canonicalAddress,
		email: profile.canonicalAddress,
		name: displayName,
		displayName,
		settings: profile.settings,
		userOwnedInbox,
		...(userOwnedInbox
			? {
				username: userOwnedInbox.username,
				subname: userOwnedInbox.subname,
				rootDomain: userOwnedInbox.rootDomain,
			}
			: {}),
	};
}

function userCanSeeProfile(c: AppContext, profile: Awaited<ReturnType<typeof listInboxProfiles>>[number]) {
	const userOwnedInbox = readUserOwnedInboxMetadata(profile.settings);
	if (!userOwnedInbox) return true;
	return c.var.requestIdentity?.email === userOwnedInbox.ownerEmail;
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Inbox agent configuration handlers (Phase 2 control plane) ----
// Defined before route registration so the same handlers can be mounted
// under both /mailboxes and /inboxes (the design-preferred path).

async function handleAgentConfigGet(c: AppContext) {
	const mailboxId = c.req.param("mailboxId")!;
	const profile = await loadInboxProfile(c.env, mailboxId);
	if (!profile) return c.json({ error: "Not found" }, 404);
	const eligibility = checkStructuredConfigEligibility(
		profile.settings,
		c.var.requestIdentity?.email ?? null,
	);
	if (!eligibility.ok) {
		const status = eligibility.code === "not_owner" ? 404 : 409;
		return c.json({ error: eligibility.message, code: eligibility.code }, status);
	}
	const config = await buildInboxAgentConfigResponse(c.env, profile);
	return c.json(config);
}

async function handleAgentConfigPatch(c: AppContext) {
	const mailboxId = c.req.param("mailboxId")!;
	const profile = await loadInboxProfile(c.env, mailboxId);
	if (!profile) return c.json({ error: "Not found" }, 404);
	const eligibility = checkStructuredConfigEligibility(
		profile.settings,
		c.var.requestIdentity?.email ?? null,
	);
	if (!eligibility.ok) {
		const status = eligibility.code === "not_owner" ? 404 : 409;
		return c.json({ error: eligibility.message, code: eligibility.code }, status);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	const validation = validateInboxAgentConfigPatch(body, c.env);
	if (!validation.ok) {
		return c.json({ error: "Invalid configuration", errors: validation.errors }, 400);
	}

	const currentConfig = await buildInboxAgentConfigResponse(c.env, profile);
	if (currentConfig.revision !== validation.patch.expectedRevision) {
		return c.json(
			{
				error: "Configuration was changed by another session. Reload and try again.",
				code: "revision_conflict",
				currentRevision: currentConfig.revision,
			},
			409,
		);
	}

	const previousSettings = profile.settings;
	const previousRevision = currentConfig.revision;
	const updateResult = await applyInboxAgentConfigUpdate(
		profile.storageMailboxId,
		previousSettings,
		validation.patch,
	);

	if (updateResult.changedFields.length === 0) {
		const refreshed = await buildInboxAgentConfigResponse(c.env, profile);
		return c.json(refreshed);
	}

	await c.env.BUCKET.put(
		mailboxSettingsKey(mailboxId),
		JSON.stringify(updateResult.settings),
	);

	c.executionCtx.waitUntil(
		appendInboxAgentConfigAudit({
			env: c.env,
			mailboxId,
			canonicalAddress: profile.canonicalAddress,
			storageMailboxId: profile.storageMailboxId,
			actorEmail: c.var.requestIdentity?.email ?? null,
			previousSettings,
			nextSettings: updateResult.settings,
			previousRevision,
			nextRevision: updateResult.revision,
			changedFields: updateResult.changedFields,
		}),
	);

	const refreshedProfile = await loadInboxProfile(c.env, mailboxId);
	const refreshed = await buildInboxAgentConfigResponse(
		c.env,
		refreshedProfile ?? profile,
	);
	return c.json(refreshed);
}

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = configuredEmailAddresses(c.env);
	return c.json({ domains, emailAddresses });
});

// -- Inbox agent configuration (Phase 2 control plane) --------------

app.get("/api/v1/inbox-config/options", (c) => {
	return c.json(buildInboxAgentConfigOptions(c.env));
});

// -- AI Inboxes -----------------------------------------------------

app.get("/api/v1/inboxes/me", async (c) => {
	const identity = c.var.requestIdentity;
	if (!identity) return c.json({ error: "Verified user identity required" }, 403);
	const rootDomain = defaultRootDomain(c.env);
	if (!rootDomain) return c.json({ error: "No root domain configured" }, 500);
	const user = await ensureUserMetadata(c.env, identity.email);
	return c.json({
		email: identity.email,
		username: user.username,
		rootDomain,
	});
});

app.post("/api/v1/inboxes", async (c) => {
	const identity = c.var.requestIdentity;
	if (!identity) return c.json({ error: "Verified user identity required" }, 403);

	const rawBody = (await c.req.json()) as unknown;
	if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
		return c.json({ error: "Request body must be an object" }, 400);
	}
	const rawRecord = rawBody as Record<string, unknown>;
	for (const forbidden of ["email", "address", "username"]) {
		if (forbidden in rawRecord) {
			return c.json({
				error: "AI inbox address is derived by the server; submit displayName and subname only",
			}, 400);
		}
	}

	const parsed = CreateInboxBody.safeParse(rawBody);
	if (!parsed.success) {
		return c.json({
			error: parsed.error.issues[0]?.message ?? "Invalid AI inbox payload",
		}, 400);
	}

	const rootDomain = defaultRootDomain(c.env);
	if (!rootDomain) return c.json({ error: "No root domain configured" }, 500);

	const subnameResult = validateInboxSubname(parsed.data.subname);
	if (!subnameResult.ok || !subnameResult.subname) {
		return c.json({
			error: subnameResult.message ?? "Invalid inbox address name",
			code: subnameResult.code,
		}, 400);
	}

	const user = await ensureUserMetadata(c.env, identity.email);
	const email = deriveUserOwnedInboxAddress(user.username, subnameResult.subname, rootDomain);
	if (await userOwnedInboxExists(c.env, email)) {
		return c.json({ error: "AI inbox address already exists", code: "duplicate_subname" }, 409);
	}

	const settings = buildUserOwnedInboxSettings({
		address: email,
		displayName: parsed.data.displayName,
		ownerEmail: identity.email,
		username: user.username,
		subname: subnameResult.subname,
		rootDomain,
	});
	await c.env.BUCKET.put(mailboxSettingsKey(email), JSON.stringify(settings));

	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();

	return c.json({
		id: email,
		email,
		name: parsed.data.displayName,
		displayName: parsed.data.displayName,
		username: user.username,
		subname: subnameResult.subname,
		rootDomain,
		userOwnedInbox: readUserOwnedInboxMetadata(settings),
		settings,
	}, 201);
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const profiles = await listInboxProfiles(c.env);
	return c.json(profiles.filter((p) => userCanSeeProfile(c, p)).map(mailboxResponse));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = normalizeInboxAddress(rawEmail);
	const allowedAddresses = configuredEmailAddresses(c.env);
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = mailboxSettingsKey(email);
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const mergedSettings = { ...defaultSettings, ...settings };
	const finalSettings = ensureSettingsInboxProfile(email, mergedSettings);
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const settings = await loadMailboxSettings(c.env, mailboxId);
	if (settings === null) return c.json({ error: "Not found" }, 404);
	const userOwnedInbox = readUserOwnedInboxMetadata(settings);
	if (userOwnedInbox && c.var.requestIdentity?.email !== userOwnedInbox.ownerEmail) {
		return c.json({ error: "Not found" }, 404);
	}
	const displayName = typeof settings.fromName === "string" && settings.fromName
		? settings.fromName
		: mailboxId;
	return c.json({
		id: mailboxId,
		name: displayName,
		displayName,
		email: mailboxId,
		settings,
		userOwnedInbox,
		...(userOwnedInbox
			? {
				username: userOwnedInbox.username,
				subname: userOwnedInbox.subname,
				rootDomain: userOwnedInbox.rootDomain,
			}
			: {}),
	});
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = mailboxSettingsKey(mailboxId);
	const existingSettings = await loadMailboxSettings(c.env, mailboxId);
	if (existingSettings === null) return c.json({ error: "Not found" }, 404);
	const userOwnedInbox = readUserOwnedInboxMetadata(existingSettings);
	if (userOwnedInbox && c.var.requestIdentity?.email !== userOwnedInbox.ownerEmail) {
		return c.json({ error: "Not found" }, 404);
	}
	const finalSettings = mergeSettingsPreservingInboxProfile(existingSettings, settings, mailboxId);
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: finalSettings });
});

app.get("/api/v1/mailboxes/:mailboxId/agent-config", handleAgentConfigGet);
app.patch("/api/v1/mailboxes/:mailboxId/agent-config", handleAgentConfigPatch);

// Design-preferred /inboxes/:mailboxId/agent-config aliases. Both paths
// hit the same handlers, so existing UIs keep working while new clients
// use the inbox-scoped path.
app.get("/api/v1/inboxes/:mailboxId/agent-config", handleAgentConfigGet);
app.patch("/api/v1/inboxes/:mailboxId/agent-config", handleAgentConfigPatch);

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = mailboxSettingsKey(mailboxId);
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	const inboundResolution = await resolveInboundInboxProfile(env, allRecipients);
	if (!inboundResolution.profile) {
		console.log(
			`Ignoring email: inbound recipient resolution failed (${inboundResolution.status})`,
			inboundResolution.matchedAddress ? `for ${inboundResolution.matchedAddress}` : "",
		);
		return;
	}

	const messageId = crypto.randomUUID();
	const inboxProfile = inboundResolution.profile;
	const agentProfile = resolveAgentProfile(env, inboxProfile);

	const stub = getMailboxStubForInbox(env, inboxProfile);

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	const agentHeaders = new Headers({ "Content-Type": "application/json" });
	if (env.INTERNAL_SECRET) {
		agentHeaders.set("x-internal-system", env.INTERNAL_SECRET);
	}
	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(inboxProfile.storageMailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: agentHeaders,
		body: JSON.stringify({
			mailboxId: inboxProfile.storageMailboxId,
			emailId: messageId,
			sender: (parsedEmail.from?.address || "").toLowerCase(),
			subject: parsedEmail.subject || "",
			threadId,
			inboxProfile,
			agentProfile,
		}),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

export { app, receiveEmail };
