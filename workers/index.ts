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
	listMailboxes,
	stripHtmlToText,
} from "./lib/email-helpers";
import { collectInboundRecipientAddresses } from "./lib/inbound-recipients";
import { SendEmailRequestSchema } from "./lib/schemas";
import { TeamAddressError } from "./lib/team-addresses";
import {
	activateRegisteredAddress,
	createTeam,
	createTeamUser,
	deleteTeamForProvisioningRollback,
	deleteTeamUserForProvisioningRollback,
	getTeamMailboxMeta,
	listTeams,
	listTeamUsers,
	resolveAddress,
	TeamDirectoryError,
} from "./lib/teams";
import { issueToken } from "./lib/email-tokens";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import { getAgentByName } from "agents";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import {
	addMailboxMember,
	assertMailboxAccess,
	assertMailboxOwner,
	AuthzError,
	getMailboxAcl,
	getUserFromRequest,
	INTERNAL_SYSTEM_HEADER,
	isAdmin,
	listUserMailboxes,
	normalizeEmail,
	removeMailboxMember,
	setMailboxOwner,
	signInviteToken,
	verifyInviteToken,
} from "./lib/auth";
import { findUserByEmail, findUserById, listUsers, setRole } from "./lib/users";
import {
	deleteMailboxRecord,
	getMailboxRecord,
	reconcileUserIds,
	replaceMembersRecord,
	upsertMailboxRecord,
} from "./lib/mailbox-directory";
import {
	AGENT_CONFIG_FIELDS,
	agentSettingsPatchFromRaw,
	getAgentConfig,
	mailboxSettingsRowToR2Shape,
	nonAgentSettingsFromRaw,
	readUnifiedMailboxSettings,
} from "./lib/agent-config";
import {
	issueApiKey,
	listApiKeys,
	revokeApiKey,
} from "./lib/api-keys";
import { evaluateRules, RuleConditionSchema, RuleActionSchema } from "./lib/rules";
import {
	listRules as listRulesFromStore,
	replaceRules as replaceRulesInStore,
	getRuleHistory as getRuleHistoryFromStore,
	mirrorLegacyRulesToD1,
	RuleConflictError,
	RuleValidationError,
} from "./lib/rules-store";
import { extensionOf } from "./lib/attachment-extract";
import {
	list as listCapabilities,
	invoke as invokeCapability,
	normalizeRuleAction,
	serializeZodSchema,
} from "./lib/capabilities";
import { listLlmModels } from "./lib/llm-models";
import {
	createProvider,
	deleteProvider,
	getProvider,
	listProviders,
	toPublic,
	updateProvider,
} from "./lib/llm-providers";
import { MCP_AUTH_TYPES } from "./lib/mcp-connections";
import { redactTokenFromText } from "./lib/mcp-token-crypto";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const CreateTeamBody = z.object({
	name: z.string().min(1),
	displayName: z.string().min(1).max(100),
}).strict();

const CreateTeamUserBody = z.object({
	userName: z.string().min(1),
	displayName: z.string().min(1).max(100),
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

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// LLM model catalog — populated from `${LLM_BASE_URL}/v1/models` and cached
// in-process for 5 minutes. Authenticated route so anonymous callers can't
// poll the upstream endpoint via us. ?force=1 bypasses the cache.
app.get("/api/v1/models", async (c) => {
	let user;
	try { user = c.get("user") ?? getUserFromRequest(c); }
	catch (e) { if (e instanceof AuthzError) return c.json({ error: e.message }, e.status); throw e; }
	void user;
	const force = c.req.query("force") === "1";
	const models = await listLlmModels(c.env, { force });
	return c.json({
		default: c.env.LLM_DEFAULT_MODEL ?? null,
		models,
	});
});

app.get("/api/v1/whoami", async (c) => {
	let user;
	try { user = c.get("user") ?? getUserFromRequest(c); }
	catch (e) { if (e instanceof AuthzError) return c.json({ error: e.message }, e.status); throw e; }
	const isSystem = user.system ?? false;
	let hasPassword = false;
	if (!isSystem) {
		const record = await findUserById(c.env, user.id);
		hasPassword = !!record?.passwordHash;
	}
	return c.json({
		id: user.id,
		email: user.email,
		isAdmin: isAdmin(c.env, user),
		role: user.role,
		system: isSystem,
		hasPassword,
	});
});

// -- API keys (programmatic / MCP access) --------------------------
// All endpoints below require a logged-in user; the middleware in
// workers/app.ts has already set c.var.user. We deliberately refuse to
// create / revoke keys when the caller itself authenticated via an API key,
// so a leaked key can't be used to mint more keys or hide its tracks.

function isApiKeyCaller(c: AppContext): boolean {
	const authz = c.req.header("authorization") ?? "";
	return authz.toLowerCase().startsWith("bearer ");
}

app.get("/api/v1/api-keys", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (user.system) return c.json({ error: "System callers cannot list keys" }, 403);
	const keys = await listApiKeys(c.env, user.id);
	return c.json(keys);
});

app.post("/api/v1/api-keys", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (user.system) return c.json({ error: "System callers cannot create keys" }, 403);
	if (isApiKeyCaller(c)) {
		return c.json({ error: "API keys cannot be created from a Bearer-token session" }, 403);
	}
	const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; expiresAt?: unknown };
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) return c.json({ error: "name is required" }, 400);
	const expiresAt = typeof body.expiresAt === "number" && body.expiresAt > Date.now()
		? body.expiresAt
		: null;
	const { rawKey, record } = await issueApiKey(c.env, user.id, name, { expiresAt });
	return c.json({ key: rawKey, record }, 201);
});

app.delete("/api/v1/api-keys/:id", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (user.system) return c.json({ error: "System callers cannot revoke keys" }, 403);
	if (isApiKeyCaller(c)) {
		return c.json({ error: "API keys cannot be revoked from a Bearer-token session" }, 403);
	}
	const ok = await revokeApiKey(c.env, user.id, c.req.param("id")!);
	if (!ok) return c.json({ error: "Key not found" }, 404);
	return c.body(null, 204);
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	let user;
	try { user = c.get("user") ?? getUserFromRequest(c); }
	catch (e) { if (e instanceof AuthzError) return c.json({ error: e.message }, e.status); throw e; }
	const visible = await listUserMailboxes(c.env, user);
	const payload = await Promise.all(visible.map((m) => mailboxResponse(c.env, m.id)));
	return c.json(payload);
});

async function provisionMailbox(
	c: AppContext,
	args: {
		email: string;
		name: string;
		settings?: Record<string, unknown>;
		ownerEmail: string | null;
	},
) {
	const email = normalizeEmail(args.email);
	const { name } = args;
	const settings = args.settings;
	// Strip any ACL fields the client may have supplied — ACL is owned by the
	// server and seeded from the authenticated user's identity.
	const { owner: _ignoredOwner, members: _ignoredMembers, ...cleanSettings } =
		(settings ?? {}) as Record<string, unknown>;
	const ownerNorm = args.ownerEmail ? normalizeEmail(args.ownerEmail) : null;

	// D1 mailbox-directory is the existence record. Insert before seeding the
	// DO so a half-completed mailbox cannot be discovered by ACL queries.
	await upsertMailboxRecord(c.env, email, ownerNorm, { strict: true });

	// Seed MailboxDO settings: agent fields default-empty, non-agent fields
	// seeded with the same defaults the legacy R2 blob used to carry plus
	// any client-supplied overrides (after stripping agent-config keys, which
	// route through `updateMailboxSettings` instead).
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	const defaultNonAgent: Record<string, unknown> = {
		fromName: name,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
	const seedNonAgent = { ...defaultNonAgent, ...nonAgentSettingsFromRaw(cleanSettings) };
	const seedAgent: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(cleanSettings)) {
		if ((AGENT_CONFIG_FIELDS as readonly string[]).includes(k)) seedAgent[k] = v;
	}
	const seedPatch = agentSettingsPatchFromRaw(seedAgent);
	seedPatch.nonAgentSettings = seedNonAgent;
	const doRow = await stub.updateMailboxSettings(seedPatch);

	const finalSettings: Record<string, unknown> = {
		...mailboxSettingsRowToR2Shape(doRow),
		owner: ownerNorm ?? undefined,
		members: [] as string[],
	};
	return { id: email, email, name, settings: finalSettings };
}

async function createMailboxForOwner(
	c: AppContext,
	body: unknown,
	ownerEmail: string | undefined,
) {
	const parsed = CreateMailboxBody.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "email and name are required" }, 400);
	}
	const { name, settings, email: rawEmail } = parsed.data;
	const email = normalizeEmail(rawEmail);
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	if (await getMailboxRecord(c.env, email)) {
		return c.json({ error: "Mailbox already exists" }, 409);
	}
	const mailbox = await provisionMailbox(c, {
		email,
		name,
		settings,
		ownerEmail: ownerEmail ?? null,
	});
	return c.json(mailbox, 201);
}

app.post("/api/v1/mailboxes", async (c) => {
	let user;
	try { user = c.get("user") ?? getUserFromRequest(c); }
	catch (e) { if (e instanceof AuthzError) return c.json({ error: e.message }, e.status); throw e; }

	// Team/user mode disables ordinary self-serve mailbox creation. Admins may
	// still use the legacy endpoint for fixed-mailbox migration/repair, but
	// normal provisioning is now POST /api/v1/admin/teams and /users.
	if (!user.system && !isAdmin(c.env, user)) {
		return c.json({
			error:
				"Self-serve mailbox creation is disabled. Ask an admin to create a team or team user.",
		}, 403);
	}

	return createMailboxForOwner(
		c,
		await c.req.json().catch(() => ({})),
		user.system ? undefined : user.email,
	);
});

// Helpers for routes that sit at /api/v1/mailboxes/:mailboxId (no sub-path,
// so `requireMailbox` — mounted at /api/v1/mailboxes/:mailboxId/* — does NOT
// cover them). Each handler must enforce ACL explicitly.
function resolveUser(c: AppContext) {
	return c.get("user") ?? getUserFromRequest(c);
}
function handleAuthz<T>(c: AppContext, e: unknown): Response {
	if (e instanceof AuthzError) return c.json({ error: e.message }, e.status);
	throw e;
}

function handleTeamDirectoryError(c: AppContext, e: unknown): Response {
	if (e instanceof TeamDirectoryError) return c.json({ error: e.message }, e.status);
	if (e instanceof TeamAddressError) return c.json({ error: e.message }, 400);
	throw e;
}

function publicOrigin(c: AppContext): string {
	const fromEnv = c.env.PUBLIC_BASE_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	return new URL(c.req.url).origin;
}

async function mailboxResponse(env: Env, mailboxId: string) {
	const meta = await getTeamMailboxMeta(env, mailboxId);
	const name = meta
		? meta.address.kind === "team"
			? meta.team.displayName
			: `${meta.team.displayName} / ${meta.teamUser?.slug ?? meta.address.address}`
		: mailboxId;
	return {
		id: mailboxId,
		email: mailboxId,
		name,
		...(meta ? {
			team: {
				id: meta.team.id,
				slug: meta.team.slug,
				displayName: meta.team.displayName,
				kind: meta.address.kind,
				userSlug: meta.teamUser?.slug ?? null,
			},
		} : {}),
	};
}

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	// Settings are read entirely from MailboxDO. Non-agent UI fields lazy-
	// backfill from the legacy R2 blob on first read after the cutover; the
	// helper short-circuits once the DO row is fully populated.
	const doRow = await readUnifiedMailboxSettings(c.env, mailboxId);
	const settings = doRow ? mailboxSettingsRowToR2Shape(doRow) : {};
	return c.json({ ...await mailboxResponse(c.env, mailboxId), settings });
});

// Capability registry — discovery endpoint for the Rule editor and the
// Agent skills picker. Per-mailbox path is forward-compatible with Phase-2
// per-mailbox ACL filtering; today it returns the global registry list
// unfiltered (filtered only by surface query param if supplied).
app.get("/api/v1/mailboxes/:mailboxId/capabilities", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	const surfaceParam = c.req.query("surface");
	const filter: { surface: "rule-action" | "agent-tool" | "mcp-tool" } | undefined =
		surfaceParam === "rule-action" ||
		surfaceParam === "agent-tool" ||
		surfaceParam === "mcp-tool"
			? { surface: surfaceParam }
			: undefined;
	const capabilities = listCapabilities(filter).map((cap) => ({
		id: cap.id,
		displayName: cap.displayName,
		description: cap.description,
		surfaces: cap.surfaces,
		scopes: cap.scopes,
		version: cap.version,
		inputSchema: serializeZodSchema(cap.inputSchema),
		outputSchema: cap.outputSchema ? serializeZodSchema(cap.outputSchema) : null,
	}));
	return c.json({ capabilities });
});

// ── Rules CRUD endpoints ──────────────────────────────────────────────
//
// Surface for the per-mailbox rules engine. Reads/writes route through the
// MailboxDO SQLite (version-CAS, history) — the legacy R2 settings.rules
// path is read only as a one-shot lazy backfill on first read after the
// second-wave cutover.
//
// During the bridge phase the legacy PUT /api/v1/mailboxes/:id route still
// accepts rules embedded in the settings document so old clients keep
// working until settings.tsx switches to the dedicated /rules endpoints.

const RuleInputSchema = z.object({
	id: z.string().optional(),
	name: z.string().nullable().optional(),
	enabled: z.boolean(),
	if: RuleConditionSchema,
	then: RuleActionSchema,
});

const PutRulesBody = z.object({
	rules: z.array(RuleInputSchema),
	expectedVersions: z.record(z.number().int().nonnegative()).optional(),
});

app.get("/api/v1/mailboxes/:mailboxId/rules", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	const rules = await listRulesFromStore(c.env, mailboxId);
	return c.json({ rules });
});

app.put("/api/v1/mailboxes/:mailboxId/rules", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }

	const parsed = PutRulesBody.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) {
		return c.json({ error: "invalid_body", details: parsed.error.message }, 400);
	}

	// Webhook actions are integration-level power (outbound HTTP). Adding,
	// removing, or modifying any `core:webhook` action requires the mailbox
	// owner. We compare a stable fingerprint vs. the currently-stored rules
	// so an owner who set up a webhook does not lock members out of editing
	// the rest of the rules afterwards.
	const incomingForFingerprint = parsed.data.rules.map((r) => ({
		if: r.if,
		then: r.then,
	}));
	const existing = await listRulesFromStore(c.env, mailboxId);
	const existingForFingerprint = existing.map((r) => ({
		if: r.if,
		then: r.then,
	}));
	if (
		webhookActionsFingerprint(incomingForFingerprint) !==
		webhookActionsFingerprint(existingForFingerprint)
	) {
		try { await assertMailboxOwner(c.env, mailboxId, user); }
		catch (e) { return handleAuthz(c, e); }
	}

	try {
		const rules = await replaceRulesInStore(c.env, mailboxId, {
			rules: parsed.data.rules.map((r) => ({
				id: r.id,
				name: r.name ?? null,
				enabled: r.enabled,
				if: r.if,
				then: r.then,
			})),
			expectedVersions: parsed.data.expectedVersions ?? {},
			actor: user.system ? "system" : (user.email ?? "unknown"),
		});
		return c.json({ rules });
	} catch (e) {
		if (e instanceof RuleConflictError) {
			return c.json(
				{ error: "version_mismatch", conflictedIds: e.conflicts },
				409,
			);
		}
		if (e instanceof RuleValidationError) {
			return c.json(
				{ error: "invalid_rule", index: e.index ?? null, details: e.message },
				422,
			);
		}
		throw e;
	}
});

app.get("/api/v1/mailboxes/:mailboxId/rules/:ruleId/history", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const ruleId = c.req.param("ruleId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	const limitParam = c.req.query("limit");
	const limit = limitParam ? Math.min(Math.max(Number(limitParam) || 20, 1), 100) : 20;
	const history = await getRuleHistoryFromStore(c.env, mailboxId, ruleId, limit);
	return c.json({ history });
});

/**
 * Stable fingerprint of every `core:webhook` action embedded in a `rules`
 * array. Used to detect whether a settings PATCH is trying to add, remove, or
 * modify a webhook integration — those changes require mailbox-owner authority,
 * everything else stays member-writable.
 */
function webhookActionsFingerprint(rules: unknown): string {
	if (!Array.isArray(rules)) return "[]";
	const projected = rules.map((rule) => {
		if (!rule || typeof rule !== "object") return [];
		const then = (rule as Record<string, unknown>).then;
		if (!then || typeof then !== "object") return [];
		const actions = (then as Record<string, unknown>).actions;
		if (!Array.isArray(actions)) return [];
		return actions
			.filter(
				(a): a is { capabilityId: string; params?: unknown } =>
					!!a &&
					typeof a === "object" &&
					(a as Record<string, unknown>).capabilityId === "core:webhook",
			)
			.map((a) => ({ capabilityId: a.capabilityId, params: a.params ?? null }));
	});
	return JSON.stringify(projected);
}

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	// Strip ACL fields from client input — ACL is managed via dedicated
	// endpoints; owner/members come from the D1 mailbox-directory.
	const { owner: _o, members: _m, ...clientClean } = settings;

	// Pull existing settings (with lazy non-agent backfill from R2) so the
	// webhook fingerprint comparison and the rule mirror have prior context
	// without touching the R2 blob themselves.
	const prevRow = await readUnifiedMailboxSettings(c.env, mailboxId);
	const prevShape = prevRow ? mailboxSettingsRowToR2Shape(prevRow) : {};

	// Webhook actions are integration-level power (outbound HTTP). Adding,
	// removing, or modifying any `core:webhook` action requires the mailbox
	// owner — ordinary members can still edit other rules. We compare a
	// stable fingerprint so an owner who set up a webhook does not lock
	// members out of editing the rest of the rules afterwards.
	const incomingWebhooks = webhookActionsFingerprint(clientClean.rules);
	const existingWebhooks = webhookActionsFingerprint(prevShape.rules);
	if (incomingWebhooks !== existingWebhooks) {
		try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	}

	// Split agent-config fields, non-agent fields, and rules. Everything
	// settles in the MailboxDO `mailbox_settings` row; the legacy R2 blob is
	// no longer written.
	const agentPatch: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(clientClean)) {
		if ((AGENT_CONFIG_FIELDS as readonly string[]).includes(k)) {
			agentPatch[k] = v;
		}
	}
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	const patch = agentSettingsPatchFromRaw(agentPatch);
	patch.nonAgentSettings = nonAgentSettingsFromRaw(clientClean);
	const doRow = await stub.updateMailboxSettings(patch);

	// Transitional bridge: mirror the legacy rules payload into the DO so the
	// inbound-email pipeline stays in sync with the settings UI (which still
	// saves through this legacy endpoint). Remove once settings.tsx switches
	// to /rules.
	if ("rules" in clientClean) {
		await mirrorLegacyRulesToD1(c.env, mailboxId, clientClean.rules, user.email);
	}

	const acl = await getMailboxAcl(c.env, mailboxId);
	const unified: Record<string, unknown> = {
		...mailboxSettingsRowToR2Shape(doRow),
		owner: acl?.owner,
		members: acl?.members ?? [],
	};
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: unified });
});


app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	// `assertMailboxOwner` already 404s when the D1 record is missing, so by
	// the time we get here the mailbox exists.
	await deleteMailboxRecord(c.env, mailboxId);
	// Best-effort cleanup of the legacy R2 omnibus blob. Idempotent: BUCKET.delete
	// silently no-ops when the key is absent (mailboxes created after the
	// non-agent-settings cutover never had one). TODO: also delete DO data and
	// R2 attachment blobs.
	try {
		await c.env.BUCKET.delete(`mailboxes/${mailboxId}.json`);
	} catch (e) {
		console.warn(`[mailbox] orphan R2 blob delete failed for "${mailboxId}":`, e);
	}
	return c.body(null, 204);
});

// -- Mailbox membership (owner-only writes) -------------------------

app.get("/api/v1/mailboxes/:mailboxId/members", async (c) => {
	// This path goes through requireMailbox (access-level check). Current user
	// is any owner or member — both may read the roster.
	const mailboxId = c.req.param("mailboxId")!;
	const acl = await getMailboxAcl(c.env, mailboxId);
	if (!acl) return c.json({ error: "Not found" }, 404);
	const meta = await getTeamMailboxMeta(c.env, mailboxId);
	return c.json({
		owner: acl.owner ?? null,
		members: acl.members,
		teamManaged: !!meta,
		team: meta ? {
			id: meta.team.id,
			slug: meta.team.slug,
			displayName: meta.team.displayName,
			kind: meta.address.kind,
			userSlug: meta.teamUser?.slug ?? null,
		} : null,
	});
});

app.post("/api/v1/mailboxes/:mailboxId/members", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	const body = (await c.req.json()) as { email?: unknown };
	if (typeof body.email !== "string" || !body.email.includes("@")) {
		return c.json({ error: "email required" }, 400);
	}
	const acl = await addMailboxMember(c.env, mailboxId, normalizeEmail(body.email));
	return c.json({ owner: acl.owner ?? null, members: acl.members });
});

app.delete("/api/v1/mailboxes/:mailboxId/members/:email", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const email = decodeURIComponent(c.req.param("email")!);
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	const acl = await removeMailboxMember(c.env, mailboxId, email);
	return c.json({ owner: acl.owner ?? null, members: acl.members });
});

// -- Invite links (owner issues short-lived token; anyone Access-authed accepts) --

app.post("/api/v1/mailboxes/:mailboxId/invites", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }
	let token: string; let expiresAt: number;
	try {
		({ token, expiresAt } = await signInviteToken(c.env, mailboxId, user.email));
	} catch (e) { return handleAuthz(c, e); }
	const origin = new URL(c.req.url).origin;
	return c.json({ token, url: `${origin}/invite/${token}`, expiresAt });
});

app.post("/api/v1/invites/accept", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
	if (typeof body.token !== "string" || !body.token) {
		return c.json({ error: "token required" }, 400);
	}
	let claims;
	try { claims = await verifyInviteToken(c.env, body.token); } catch (e) { return handleAuthz(c, e); }
	// Mailbox must still exist; invite issuer must still be owner (re-check).
	const acl = await getMailboxAcl(c.env, claims.mbx);
	if (!acl) return c.json({ error: "Mailbox no longer exists" }, 404);
	if (acl.owner !== claims.by) {
		return c.json({ error: "Invite issuer is no longer the mailbox owner" }, 403);
	}
	// If accepter is already the owner, nothing to do; return success.
	if (acl.owner === user.email) {
		return c.json({ mailboxId: claims.mbx, already: "owner", owner: acl.owner, members: acl.members });
	}
	const next = await addMailboxMember(c.env, claims.mbx, user.email);
	return c.json({ mailboxId: claims.mbx, owner: next.owner ?? null, members: next.members });
});

// -- Admin (role stored in D1 users.role) ----------------------------

app.get("/api/v1/admin/users", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	const all = await listUsers(c.env);
	return c.json(all.map((u) => ({
		id: u.id,
		email: u.email,
		role: u.role,
		displayName: u.displayName,
		emailVerifiedAt: u.emailVerifiedAt,
		createdAt: u.createdAt,
	})));
});

app.post("/api/v1/admin/users/:id/role", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	const targetId = c.req.param("id")!;
	const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
	if (body.role !== "user" && body.role !== "admin") {
		return c.json({ error: "role must be 'user' or 'admin'" }, 400);
	}
	const target = await findUserById(c.env, targetId);
	if (!target) return c.json({ error: "User not found" }, 404);
	if (target.id === user.id && body.role === "user") {
		return c.json({ error: "Refusing to demote yourself" }, 400);
	}
	await setRole(c.env, targetId, body.role);
	return c.json({ ok: true });
});

app.get("/api/v1/admin/teams", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const teams = await listTeams(c.env);
	return c.json(teams);
});

app.post("/api/v1/admin/teams", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	if ("email" in body || "address" in body || "mailboxAddress" in body) {
		return c.json({ error: "Team address is derived by the server" }, 400);
	}
	const parsed = CreateTeamBody.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "name and displayName are required" }, 400);
	}
	try {
		const team = await createTeam(c.env, {
			name: parsed.data.name,
			displayName: parsed.data.displayName,
			createdByUserId: guard.user.system ? null : guard.user.id,
		});
		let mailbox;
		try {
			mailbox = await provisionMailbox(c, {
				email: team.primaryAddress,
				name: team.displayName,
				ownerEmail: null,
			});
			await activateRegisteredAddress(c.env, team.primaryAddress);
		} catch (e) {
			await deleteMailboxRecord(c.env, team.primaryAddress);
			await deleteTeamForProvisioningRollback(c.env, team.id);
			throw e;
		}
		return c.json({ ...team, mailbox }, 201);
	} catch (e) {
		return handleTeamDirectoryError(c, e);
	}
});

app.get("/api/v1/admin/teams/:teamId/users", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	try {
		const rows = await listTeamUsers(c.env, c.req.param("teamId")!);
		const payload = await Promise.all(rows.map(async (row) => {
			const user = await findUserById(c.env, row.userId);
			return {
				...row,
				email: user?.email ?? row.mailboxAddress,
				displayName: user?.displayName ?? row.slug,
			};
		}));
		return c.json(payload);
	} catch (e) {
		return handleTeamDirectoryError(c, e);
	}
});

app.post("/api/v1/admin/teams/:teamId/users", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	if ("email" in body || "address" in body || "mailboxAddress" in body) {
		return c.json({ error: "Team-user address is derived by the server" }, 400);
	}
	const parsed = CreateTeamUserBody.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "userName and displayName are required" }, 400);
	}
	try {
		const created = await createTeamUser(c.env, {
			teamId: c.req.param("teamId")!,
			userName: parsed.data.userName,
			displayName: parsed.data.displayName,
			createdByUserId: guard.user.system ? null : guard.user.id,
		});
		let mailbox;
		let setupToken: Awaited<ReturnType<typeof issueToken>> | null = null;
		try {
			mailbox = await provisionMailbox(c, {
				email: created.teamUser.mailboxAddress,
				name: created.user.displayName ?? created.teamUser.slug,
				ownerEmail: null,
			});
			setupToken = await issueToken(c.env, created.user.id, "reset");
			await activateRegisteredAddress(c.env, created.teamUser.mailboxAddress);
		} catch (e) {
			await deleteMailboxRecord(c.env, created.teamUser.mailboxAddress);
			await deleteTeamUserForProvisioningRollback(c.env, created.teamUser.id);
			throw e;
		}
		if (!setupToken) throw new Error("Setup token was not issued");
		const setupUrl = `${publicOrigin(c)}/reset-password?token=${setupToken.rawToken}`;
		const publicUser = {
			id: created.user.id,
			email: created.user.email,
			role: created.user.role,
			displayName: created.user.displayName,
			emailVerifiedAt: created.user.emailVerifiedAt,
			createdAt: created.user.createdAt,
		};
		return c.json({
			...created.teamUser,
			user: publicUser,
			team: created.team,
			mailbox,
			setupUrl,
			setupExpiresAt: setupToken.expiresAt,
		}, 201);
	} catch (e) {
		return handleTeamDirectoryError(c, e);
	}
});

app.post("/api/v1/admin/users/:id/mailboxes", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	const target = await findUserById(c.env, c.req.param("id")!);
	if (!target) return c.json({ error: "User not found" }, 404);
	return createMailboxForOwner(
		c,
		await c.req.json().catch(() => ({})),
		target.email,
	);
});

app.post("/api/v1/admin/mailboxes/:mailboxId/owner", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	const mailboxId = c.req.param("mailboxId")!;
	const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
	if (typeof body.email !== "string" || !body.email.includes("@")) {
		return c.json({ error: "email required" }, 400);
	}
	const targetEmail = normalizeEmail(body.email);
	const target = await findUserByEmail(c.env, targetEmail);
	if (!target) {
		return c.json({ error: "Target user not found — they must register first" }, 404);
	}
	try {
		const acl = await setMailboxOwner(c.env, mailboxId, targetEmail);
		return c.json({ id: mailboxId, owner: acl.owner ?? null, members: acl.members });
	} catch (e) { return handleAuthz(c, e); }
});

// Reconcile the D1 mailbox directory + membership index against the
// authoritative R2 ACL blobs. Use case during the dual-write phase (PR 3):
// - new mailbox/member writes occasionally fail to shadow into D1 if the
//   D1 binding is briefly unavailable; this endpoint walks every R2
//   `mailboxes/<id>.json` and re-writes the matching D1 rows.
// - any prior mailbox created before PR 3 has no D1 row at all; this
//   endpoint is the one-shot bootstrap.
app.post("/api/v1/admin/mailbox-directory/backfill", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	const entries = await listMailboxes(c.env.BUCKET);
	let mailboxesUpserted = 0;
	let membersWritten = 0;
	const errors: { mailboxId: string; message: string }[] = [];
	for (const { id } of entries) {
		try {
			const acl = await getMailboxAcl(c.env, id);
			if (!acl) continue;
			// Strict mode so D1 errors propagate to the outer try/catch and
			// land in `errors` instead of silently inflating the counters.
			await upsertMailboxRecord(c.env, id, acl.owner ?? null, { strict: true });
			mailboxesUpserted += 1;
			await replaceMembersRecord(
				c.env,
				id,
				acl.members.map((email) => ({ email })),
				user.system ? null : user.id,
				{ strict: true },
			);
			membersWritten += acl.members.length;
		} catch (e) {
			errors.push({
				mailboxId: id,
				message: e instanceof Error ? e.message : String(e),
			});
		}
	}
	const reconciled = await reconcileUserIds(c.env);
	return c.json({
		mailboxesUpserted,
		membersWritten,
		userIdsReconciled: reconciled.updated,
		errors,
	});
});

app.get("/api/v1/admin/mailboxes", async (c) => {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	// D1-backed enumeration via the same helper user-facing list uses, so
	// admin visibility stays aligned with the D1 source of truth and any
	// R2-only legacy mailbox surfaces consistently.
	const entries = await listUserMailboxes(c.env, user);
	const detailed = await Promise.all(entries.map(async ({ id }) => {
		const acl = await getMailboxAcl(c.env, id);
		const meta = await getTeamMailboxMeta(c.env, id);
		let inboxCount: number | null = null;
		try {
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(id));
			inboxCount = await stub.countEmails({ folder: Folders.INBOX });
		} catch { /* leave null if DO never booted or method errors */ }
		return {
			id,
			email: id,
			owner: acl?.owner ?? null,
			memberCount: acl?.members.length ?? 0,
			inboxCount,
			team: meta ? {
				id: meta.team.id,
				slug: meta.team.slug,
				displayName: meta.team.displayName,
				kind: meta.address.kind,
				userSlug: meta.teamUser?.slug ?? null,
			} : null,
		};
	}));
	return c.json(detailed);
});

// -- Rules backfill (admin, one-shot) -------------------------------
//
// Walks every mailbox and re-saves its rules through the canonicalising
// `replaceRules` path. Idempotent — already-canonical rules pass through
// unchanged. Used to migrate R2 / D1 documents that still carry legacy
// boolean fields (`then.skipDraft: true`, etc.) into the `actions[]`
// shape so the legacy translation block in `legacy-shim.ts` and the
// matching schema fields can be safely removed in the next release.

app.post("/api/v1/admin/rules/backfill", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const entries = await listMailboxes(c.env.BUCKET);
	const report: Array<{ mailboxId: string; rules: number; rewritten: boolean; error?: string }> = [];
	for (const { id: mailboxId } of entries) {
		try {
			const before = await listRulesFromStore(c.env, mailboxId);
			if (before.length === 0) {
				report.push({ mailboxId, rules: 0, rewritten: false });
				continue;
			}
			await replaceRulesInStore(c.env, mailboxId, {
				rules: before.map((r) => ({
					id: r.id.startsWith("r2-") ? undefined : r.id,
					name: r.name ?? null,
					enabled: r.enabled,
					if: r.if,
					then: r.then,
				})),
				expectedVersions: Object.fromEntries(
					before
						.filter((r) => !r.id.startsWith("r2-"))
						.map((r) => [r.id, r.version]),
				),
				actor: `admin-backfill:${guard.user.email}`,
			});
			report.push({ mailboxId, rules: before.length, rewritten: true });
		} catch (e) {
			report.push({
				mailboxId,
				rules: 0,
				rewritten: false,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return c.json({
		mailboxes: report.length,
		rewritten: report.filter((r) => r.rewritten).length,
		errors: report.filter((r) => r.error).length,
		report,
	});
});

// -- LLM providers (admin) ------------------------------------------
//
// Manage the OpenAI-compatible endpoints EmailAgent / InvoiceAgent stream
// against. Backed by D1 (`llm_providers` table). At most one row may carry
// `isDefault=1` and that's the provider in effect for inference. When the
// table is empty the worker falls back to env-var configuration
// (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_DEFAULT_MODEL`).

function requireAdmin(c: AppContext): { ok: true; user: ReturnType<typeof resolveUser> } | Response {
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	if (!isAdmin(c.env, user)) return c.json({ error: "Admin access required" }, 403);
	return { ok: true, user };
}

app.get("/api/v1/admin/llm-providers", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const all = await listProviders(c.env);
	return c.json(all.map(toPublic));
});

app.post("/api/v1/admin/llm-providers", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
	const defaultModel = typeof body.defaultModel === "string" ? body.defaultModel.trim() : "";
	if (!name || !baseUrl || !apiKey || !defaultModel) {
		return c.json({ error: "name, baseUrl, apiKey, defaultModel are required" }, 400);
	}
	const created = await createProvider(c.env, {
		name,
		baseUrl,
		apiKey,
		defaultModel,
		enabled: body.enabled !== false,
		makeDefault: body.makeDefault === true,
	});
	return c.json(toPublic(created), 201);
});

app.put("/api/v1/admin/llm-providers/:id", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const id = c.req.param("id")!;
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const patch: Parameters<typeof updateProvider>[2] = {};
	if (typeof body.name === "string") patch.name = body.name.trim();
	if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.trim();
	// `apiKey: ""` is treated as "no change"; non-empty string rotates the key.
	if (typeof body.apiKey === "string" && body.apiKey) patch.apiKey = body.apiKey;
	if (typeof body.defaultModel === "string") patch.defaultModel = body.defaultModel.trim();
	if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
	if (typeof body.makeDefault === "boolean") patch.makeDefault = body.makeDefault;
	const updated = await updateProvider(c.env, id, patch);
	if (!updated) return c.json({ error: "Provider not found" }, 404);
	return c.json(toPublic(updated));
});

app.delete("/api/v1/admin/llm-providers/:id", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const ok = await deleteProvider(c.env, c.req.param("id")!);
	if (!ok) return c.json({ error: "Provider not found" }, 404);
	return c.body(null, 204);
});

// "Test connection" — calls the provider's /v1/models with the stored creds
// and returns whether it succeeded + how many models were visible. Used by
// the System tab UI to validate a config without saving it.
app.post("/api/v1/admin/llm-providers/:id/test", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const provider = await getProvider(c.env, c.req.param("id")!);
	if (!provider) return c.json({ error: "Provider not found" }, 404);
	const models = await listLlmModels(c.env, {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		force: true,
	});
	return c.json({ ok: models.length > 0, modelCount: models.length, modelIds: models.slice(0, 50).map((m) => m.id) });
});

// "Discover models" — same as /test but for a not-yet-saved provider. Lets
// the System tab UI populate the Default model dropdown from the actual
// `/v1/models` of whatever endpoint the admin just typed in, before they
// commit the row.
app.post("/api/v1/admin/llm-providers/discover", async (c) => {
	const guard = requireAdmin(c);
	if (guard instanceof Response) return guard;
	const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: unknown; apiKey?: unknown };
	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
	if (!baseUrl) return c.json({ error: "baseUrl is required" }, 400);
	const models = await listLlmModels(c.env, { baseUrl, apiKey, force: true });
	return c.json({ ok: models.length > 0, modelCount: models.length, models });
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

// -- Invoices -------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/invoices", async (c: AppContext) => {
	const filters = {
		dateFrom: c.req.query("dateFrom") || undefined,
		dateTo: c.req.query("dateTo") || undefined,
		sellerContains: c.req.query("sellerContains") || undefined,
		buyerContains: c.req.query("buyerContains") || undefined,
		invoiceNumber: c.req.query("invoiceNumber") || undefined,
		minAmount: c.req.query("minAmount") ? Number(c.req.query("minAmount")) : undefined,
		maxAmount: c.req.query("maxAmount") ? Number(c.req.query("maxAmount")) : undefined,
		itemContains: c.req.query("itemContains") || undefined,
		page: intQuery(c, "page"),
		limit: intQuery(c, "limit"),
	};
	const result = await c.var.mailboxStub.listInvoices(filters);
	return c.json(result);
});

// CSV export — same filter surface as the JSON list, but streams all pages
// (up to INVOICE_CSV_ROW_LIMIT) so "export what I see" covers the entire
// filtered set, not just the current UI page. Excel-friendly (UTF-8 BOM).
app.get("/api/v1/mailboxes/:mailboxId/invoices.csv", async (c: AppContext) => {
	const { INVOICE_CSV_HEADER, INVOICE_CSV_ROW_LIMIT, CSV_BOM, invoicesRowsToCsvBody, invoiceCsvFilename } =
		await import("./lib/invoice-csv");

	const baseFilters = {
		dateFrom: c.req.query("dateFrom") || undefined,
		dateTo: c.req.query("dateTo") || undefined,
		sellerContains: c.req.query("sellerContains") || undefined,
		buyerContains: c.req.query("buyerContains") || undefined,
		invoiceNumber: c.req.query("invoiceNumber") || undefined,
		minAmount: c.req.query("minAmount") ? Number(c.req.query("minAmount")) : undefined,
		maxAmount: c.req.query("maxAmount") ? Number(c.req.query("maxAmount")) : undefined,
		itemContains: c.req.query("itemContains") || undefined,
	};

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	// Drive the page loop off to the background so we can return the response
	// head (status + content-disposition) immediately and stream rows.
	(async () => {
		try {
			await writer.write(encoder.encode(CSV_BOM + INVOICE_CSV_HEADER));
			const pageSize = 200; // DO cap
			let page = 1;
			let emitted = 0;
			while (emitted < INVOICE_CSV_ROW_LIMIT) {
				const result = await c.var.mailboxStub.listInvoices({
					...baseFilters,
					page,
					limit: pageSize,
				});
				const rows = result?.invoices ?? [];
				if (rows.length === 0) break;
				const remaining = INVOICE_CSV_ROW_LIMIT - emitted;
				const batch = rows.length > remaining ? rows.slice(0, remaining) : rows;
				await writer.write(encoder.encode(invoicesRowsToCsvBody(batch)));
				emitted += batch.length;
				if (rows.length < pageSize) break;
				page += 1;
			}
		} catch (e) {
			// Surface the error inline as a CSV comment-style trailing row so
			// the downloaded file still opens but the user sees the failure.
			await writer
				.write(encoder.encode(`\r\n# export failed: ${(e as Error).message}\r\n`))
				.catch(() => {});
		} finally {
			await writer.close().catch(() => {});
		}
	})();

	return new Response(readable, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${invoiceCsvFilename()}"`,
			"Cache-Control": "no-store",
		},
	});
});

app.get("/api/v1/mailboxes/:mailboxId/invoices/:id", async (c: AppContext) => {
	const invoiceId = c.req.param("id")!;
	const result = await c.var.mailboxStub.getInvoice(invoiceId);
	if (!result) return c.json({ error: "Invoice not found" }, 404);
	const relatedAttachments = await c.var.mailboxStub.listEmailAttachments(result.invoice.email_id);
	return c.json({
		invoice: result.invoice,
		items: result.items,
		related_attachments: relatedAttachments,
	});
});

app.delete("/api/v1/mailboxes/:mailboxId/invoices/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteInvoice(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Invoice not found" }, 404);
});

app.post(
	"/api/v1/mailboxes/:mailboxId/emails/:emailId/invoice-file",
	async (c: AppContext) => {
		const mailboxId = c.req.param("mailboxId")!;
		const emailId = c.req.param("emailId")!;
		const body = (await c.req.json().catch(() => null)) as
			| { filename?: string; mimetype?: string; content_base64?: string }
			| null;
		if (!body || !body.filename || !body.content_base64) {
			return c.json({ error: "Body must include filename + content_base64" }, 400);
		}
		// Reuse the MCP-layer helper (dedupes, enforces size cap, runs pipeline).
		const { toolUploadInvoiceFile } = await import("./lib/tools");
		const result = await toolUploadInvoiceFile(c.env, mailboxId, emailId, {
			filename: body.filename,
			mimetype: body.mimetype,
			content_base64: body.content_base64,
		});
		if (!result.attachmentId) {
			return c.json(result, 400);
		}
		return c.json(result, 201);
	},
);

// -- Bundles --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/bundles", async (c: AppContext) => {
	const stub = c.var.mailboxStub as unknown as {
		listBundles: () => Promise<unknown>;
	};
	return c.json(await stub.listBundles());
});

app.post("/api/v1/mailboxes/:mailboxId/bundles", async (c: AppContext) => {
	const body = (await c.req.json().catch(() => null)) as
		| { name?: unknown; note?: unknown }
		| null;
	if (!body || typeof body.name !== "string" || !body.name.trim()) {
		return c.json({ error: "name is required" }, 400);
	}
	const note = typeof body.note === "string" ? body.note : null;
	const stub = c.var.mailboxStub as unknown as {
		createBundle: (a: { name: string; note?: string | null }) => Promise<unknown>;
	};
	const bundle = await stub.createBundle({ name: body.name.trim(), note });
	return c.json(bundle, 201);
});

app.get(
	"/api/v1/mailboxes/:mailboxId/bundles/:bundleId",
	async (c: AppContext) => {
		const bundleId = c.req.param("bundleId")!;
		const stub = c.var.mailboxStub as unknown as {
			getBundle: (id: string) => Promise<{ bundle: unknown; invoices: unknown } | null>;
		};
		const result = await stub.getBundle(bundleId);
		if (!result) return c.json({ error: "Bundle not found" }, 404);
		return c.json(result);
	},
);

app.put(
	"/api/v1/mailboxes/:mailboxId/bundles/:bundleId",
	async (c: AppContext) => {
		const bundleId = c.req.param("bundleId")!;
		const body = (await c.req.json().catch(() => null)) as
			| { name?: unknown; note?: unknown; status?: unknown }
			| null;
		if (!body) return c.json({ error: "body required" }, 400);
		const patch: { name?: string; note?: string | null; status?: string } = {};
		if (typeof body.name === "string") patch.name = body.name.trim();
		if (body.note === null || typeof body.note === "string") {
			patch.note = body.note as string | null;
		}
		if (typeof body.status === "string") patch.status = body.status;
		const stub = c.var.mailboxStub as unknown as {
			updateBundle: (
				id: string,
				p: typeof patch,
			) => Promise<unknown | null>;
		};
		const updated = await stub.updateBundle(bundleId, patch);
		if (!updated) return c.json({ error: "Bundle not found" }, 404);
		return c.json(updated);
	},
);

app.delete(
	"/api/v1/mailboxes/:mailboxId/bundles/:bundleId",
	async (c: AppContext) => {
		const bundleId = c.req.param("bundleId")!;
		const stub = c.var.mailboxStub as unknown as {
			deleteBundle: (id: string) => Promise<boolean>;
		};
		const ok = await stub.deleteBundle(bundleId);
		return ok ? c.body(null, 204) : c.json({ error: "Bundle not found" }, 404);
	},
);

app.post(
	"/api/v1/mailboxes/:mailboxId/bundles/:bundleId/invoices/:invoiceId",
	async (c: AppContext) => {
		const bundleId = c.req.param("bundleId")!;
		const invoiceId = c.req.param("invoiceId")!;
		const stub = c.var.mailboxStub as unknown as {
			addInvoiceToBundle: (
				b: string,
				i: string,
			) => Promise<{ ok: boolean; error?: string }>;
		};
		const result = await stub.addInvoiceToBundle(bundleId, invoiceId);
		if (!result.ok) {
			const status = result.error === "bundle not found" || result.error === "invoice not found" ? 404 : 400;
			return c.json({ error: result.error ?? "failed to add invoice" }, status);
		}
		return c.json({ ok: true });
	},
);

app.delete(
	"/api/v1/mailboxes/:mailboxId/bundles/:bundleId/invoices/:invoiceId",
	async (c: AppContext) => {
		const bundleId = c.req.param("bundleId")!;
		const invoiceId = c.req.param("invoiceId")!;
		const stub = c.var.mailboxStub as unknown as {
			removeInvoiceFromBundle: (b: string, i: string) => Promise<boolean>;
		};
		const ok = await stub.removeInvoiceFromBundle(bundleId, invoiceId);
		return ok
			? c.body(null, 204)
			: c.json({ error: "Invoice not in bundle" }, 404);
	},
);

app.get(
	"/api/v1/mailboxes/:mailboxId/bundles/:bundleId.zip",
	async (c: AppContext) => {
		const mailboxId = c.req.param("mailboxId")!;
		const bundleId = c.req.param("bundleId")!;
		const stub = c.var.mailboxStub as unknown as {
			getBundle: (id: string) => Promise<
				| {
						bundle: import("./lib/invoice-bundle-zip").BundleHeaderForZip;
						invoices: import("./lib/invoice-bundle-zip").InvoiceForZip[];
				  }
				| null
			>;
		};
		const result = await stub.getBundle(bundleId);
		if (!result) return c.json({ error: "Bundle not found" }, 404);
		const { streamBundleZip, bundleZipFilename } = await import(
			"./lib/invoice-bundle-zip"
		);
		const bytes = await streamBundleZip({
			env: c.env,
			mailboxId,
			bundle: result.bundle,
			invoices: result.invoices,
		});
		const filename = bundleZipFilename(result.bundle);
		// Copy into a fresh ArrayBuffer so BodyInit picks the unambiguous
		// `ArrayBuffer` overload — Workers types reject `Uint8Array<ArrayBufferLike>`
		// directly because of the generic widening fflate's typings introduce.
		const ab = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(ab).set(bytes);
		return new Response(ab, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Cache-Control": "no-store",
			},
		});
	},
);

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

// -- L4 (MCP Client) external connection management -----------------
//
// Owner-only POST/DELETE, member-readable GET. Each handler forwards
// to the EmailAgent DO via its RPC stub; the EmailAgent enforces the
// `L4_MCP_ENABLED` feature flag before doing any SDK or storage work.
// The DO RPC has no inbound HTTP request, so we derive `callbackHost`
// from the route's request URL and pass it explicitly — Cloudflare's
// SDK uses this to construct the OAuth callback URL the user's
// browser will hit.
//
// OAuth callback (`/agents/email-agent/:mailboxId/callback`) is
// handled in `workers/app.ts` because it sits under the agent
// forwarding boundary, not the API surface.

const McpConnectionBaseBody = {
	url: z.string().url(),
	name: z.string().min(1).max(64),
	displayName: z.string().min(1).max(128).optional(),
};

const PostMcpConnectionBody = z.preprocess((value) => {
	if (
		value !== null &&
		typeof value === "object" &&
		!("authType" in value)
	) {
		return { ...value, authType: "oauth" };
	}
	return value;
}, z.discriminatedUnion("authType", [
	z.object({
		...McpConnectionBaseBody,
		authType: z.literal(MCP_AUTH_TYPES[0]),
	}),
	z.object({
		...McpConnectionBaseBody,
		authType: z.literal(MCP_AUTH_TYPES[1]),
		bearerToken: z.string().min(1).max(8192),
	}),
]));

app.post("/api/v1/mailboxes/:mailboxId/mcp-connections", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }

	const parsed = PostMcpConnectionBody.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) {
		return c.json({ error: "invalid_body", details: parsed.error.message }, 400);
	}

	const reqUrl = new URL(c.req.url);
	const callbackHost = `${reqUrl.protocol}//${reqUrl.host}`;
	const stub = await getAgentByName(c.env.EMAIL_AGENT, mailboxId);
	try {
		const result = await stub.addExternalMcpServer(
			parsed.data.authType === "bearer"
				? {
						authType: "bearer",
						serverName: parsed.data.name,
						url: parsed.data.url,
						displayName: parsed.data.displayName,
						addedByUserId: user.id,
						bearerToken: parsed.data.bearerToken,
					}
				: {
						authType: "oauth",
						serverName: parsed.data.name,
						url: parsed.data.url,
						displayName: parsed.data.displayName,
						addedByUserId: user.id,
						callbackHost,
					},
		);
		return c.json(result);
	} catch (e) {
		const rawMsg = (e as Error).message;
		const msg =
			parsed.data.authType === "bearer"
				? redactTokenFromText(rawMsg, parsed.data.bearerToken)
				: rawMsg;
		if (msg === "L4 MCP feature disabled") {
			return c.json({ error: "feature_disabled" }, 503);
		}
		if (msg === "L4 MCP Bearer feature disabled") {
			return c.json({ error: "bearer_feature_disabled" }, 503);
		}
		return c.json({ error: "add_failed", message: msg }, 500);
	}
});

app.delete("/api/v1/mailboxes/:mailboxId/mcp-connections/:connId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const connId = c.req.param("connId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxOwner(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }

	const stub = await getAgentByName(c.env.EMAIL_AGENT, mailboxId);
	try {
		await stub.removeExternalMcpServer(connId);
		return c.json({ ok: true });
	} catch (e) {
		const msg = (e as Error).message;
		if (msg === "L4 MCP feature disabled") {
			return c.json({ error: "feature_disabled" }, 503);
		}
		return c.json({ error: "remove_failed", message: msg }, 500);
	}
});

app.get("/api/v1/mailboxes/:mailboxId/mcp-connections", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	let user;
	try { user = resolveUser(c); } catch (e) { return handleAuthz(c, e); }
	try { await assertMailboxAccess(c.env, mailboxId, user); } catch (e) { return handleAuthz(c, e); }

	const stub = await getAgentByName(c.env.EMAIL_AGENT, mailboxId);
	try {
		const connections = await stub.listExternalMcpServers();
		return c.json({ connections });
	} catch (e) {
		const msg = (e as Error).message;
		if (msg === "L4 MCP feature disabled") {
			// Read path is forgiving so the UI can render the empty state
			// without surfacing a 503 — the absence of features is itself
			// the kill-switch user signal.
			return c.json({ connections: [] });
		}
		return c.json({ error: "list_failed", message: msg }, 500);
	}
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

async function receiveEmail(event: { raw: ReadableStream; rawSize: number; to?: string }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const allRecipients = collectInboundRecipientAddresses(event.to, parsedEmail.to);
	if (allRecipients.length === 0) throw new Error("received email with empty to");

	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let resolvedRecipient: Awaited<ReturnType<typeof resolveAddress>> = null;
	for (const recipient of allRecipients) {
		resolvedRecipient = await resolveAddress(env, recipient);
		if (resolvedRecipient) break;
	}
	if (!resolvedRecipient) {
		console.log(`Ignoring email: no recipient matches an active team or legacy mailbox.`);
		return;
	}
	const mailboxId = resolvedRecipient.mailboxId;

	const messageId = crypto.randomUUID();

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

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

	// Processing rules + auto-draft decision ----------------------------
	const config = await getAgentConfig(env, mailboxId);
	const facts = {
		from: (parsedEmail.from?.address || "").toLowerCase(),
		to: allRecipients,
		subject: parsedEmail.subject || "",
		body: parsedEmail.text || (parsedEmail.html ? stripHtmlToText(parsedEmail.html) : ""),
		attachmentExts: (parsedEmail.attachments ?? [])
			.map((a) => extensionOf(a.filename || ""))
			.filter(Boolean),
	};
	const { action, matchedName } = evaluateRules(config.rules, facts);
	if (matchedName || Object.keys(action).length > 0) {
		console.log(`Rule matched for ${messageId}: ${matchedName ?? "(unnamed)"} → ${JSON.stringify(action)}`);
	}

	// Translate the (possibly-legacy) RuleAction blob into a canonical
	// `{ actions, flow }` shape. Legacy fields are converted into Capability
	// invocations on read; the flow envelope still drives auto-draft / move
	// suppression. Sequential execution (downgrade from previous parallel
	// `Promise.allSettled`) — predictable order is worth the ~2ms regression.
	//
	// Capabilities that need to feed the auto-draft prompt return a
	// `CapabilityPromptContribution` shape (see capabilities/types.ts); we
	// harvest those into `promptContributions` / `deferredPdfs` here and merge
	// them into `promptOverride` after the shouldDraft decision below.
	const normalized = normalizeRuleAction(action);
	const promptContributions: string[] = [];
	const deferredPdfs: string[] = [];
	for (const a of normalized.actions) {
		const result = await invokeCapability(
			{
				env,
				mailboxId,
				emailId: messageId,
				triggeredBy: "rule",
				// Forward the request-scoped ExecutionContext.waitUntil so
				// capabilities that schedule fire-and-forget work (today:
				// `core:extract-invoice` dispatching INVOICE_AGENT) keep
				// the worker alive until their async dispatch resolves.
				waitUntil: (p) => ctx.waitUntil(p),
			},
			a.capabilityId,
			a.params,
		);
		if (!result.ok) {
			console.error(`Rule capability ${a.capabilityId} failed: ${result.error}`);
			continue;
		}
		const contrib = result.value as { promptText?: unknown; deferredPdfs?: unknown };
		if (typeof contrib?.promptText === "string" && contrib.promptText.length > 0) {
			promptContributions.push(contrib.promptText);
		}
		if (Array.isArray(contrib?.deferredPdfs)) {
			for (const f of contrib.deferredPdfs) {
				if (typeof f === "string") deferredPdfs.push(f);
			}
		}
	}

	const movedOutOfInbox = !!(normalized.flow.moveTo && normalized.flow.moveTo !== Folders.INBOX);
	const shouldDraft = config.autoDraft && !normalized.flow.skipDraft && !movedOutOfInbox;
	if (!shouldDraft) return;

	const extractedBlock = promptContributions.join("\n\n");
	if (deferredPdfs.length) {
		console.log(
			`Deferred PDF OCR for ${mailboxId}/${messageId}: ${deferredPdfs.join(", ")} (Phase 2 not yet wired)`,
		);
	}

	const promptOverrideMerged = [
		normalized.flow.promptOverride?.trim(),
		extractedBlock
			? `## Extracted attachments\n${extractedBlock}\n\nUse these fields when drafting the reply (e.g. confirm invoice number, amount, date).`
			: "",
		deferredPdfs.length
			? `(Note: ${deferredPdfs.length} PDF attachment(s) — OCR not yet available in this draft. Do not make up PDF contents.)`
			: "",
	].filter(Boolean).join("\n\n");

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	// Tag this worker-to-worker call as internal so any ACL-aware handler
	// downstream recognises it as system-originated and bypasses user checks.
	const agentHeaders: Record<string, string> = { "Content-Type": "application/json" };
	if (env.INTERNAL_SECRET) agentHeaders[INTERNAL_SYSTEM_HEADER] = env.INTERNAL_SECRET;
	const agentBody = {
		mailboxId,
		emailId: messageId,
		sender: facts.from,
		subject: facts.subject,
		threadId,
		...(promptOverrideMerged ? { promptOverride: promptOverrideMerged } : {}),
	};
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: agentHeaders,
		body: JSON.stringify(agentBody),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

export { app, receiveEmail };
