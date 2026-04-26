// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox authorization layer + identity types.
 *
 * Identity now comes from the native auth system (cookie session backed by
 * D1 — see workers/lib/session.ts and workers/routes/auth.ts). Cloudflare
 * Access JWTs are still honored as a fallback for backward compatibility:
 * if POLICY_AUD/TEAM_DOMAIN are set, the middleware in workers/app.ts will
 * mint a session for the JWT's email so existing Access-only users stay
 * logged in.
 *
 * Mailbox ACL still keys off `email`, so R2 blobs need no migration.
 */
import { SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import type { Env } from "../types";

export interface AuthUser {
	/** D1 users.id; "__system__" for internal worker calls. */
	id: string;
	email: string;
	role: "user" | "admin";
	/** true for internal worker-to-worker calls (e.g. inbound email → auto-draft). */
	system?: boolean;
}

/** Header used by the Hono layer to propagate the already-authenticated user
 *  email into DOs (EmailMCP) that would otherwise have to re-validate auth. */
export const INTERNAL_USER_HEADER = "x-internal-user-email";

/** Header used by receiveEmail → EmailAgent to mark the call as internal.
 *  Value must match env.INTERNAL_SECRET. */
export const INTERNAL_SYSTEM_HEADER = "x-internal-system";

/** Dev-only header: impersonate any user for local curl testing. Only honored
 *  when import.meta.env.DEV is true. */
export const DEV_USER_HEADER = "x-dev-user";

const SYSTEM_USER: AuthUser = {
	id: "__system__",
	email: "__system__",
	role: "admin",
	system: true,
};

export interface MailboxAcl {
	owner?: string;
	members: string[];
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Read the authenticated user from the Hono context. The middleware in
 * workers/app.ts is responsible for putting it there; this helper exists so
 * legacy call-sites that still call `getUserFromRequest()` keep working.
 */
export function getUserFromRequest<E extends { Bindings: Env; Variables: { user?: AuthUser } }>(
	c: Context<E>,
): AuthUser {
	const sysHeader = c.req.header(INTERNAL_SYSTEM_HEADER);
	const sysSecret = c.env.INTERNAL_SECRET;
	if (sysHeader && sysSecret && sysHeader === sysSecret) {
		return SYSTEM_USER;
	}
	const stashed = c.get("user") as AuthUser | undefined;
	if (stashed) return stashed;
	throw new AuthzError(401, "Not authenticated");
}

/** Thrown by ACL checks. Hono handlers should translate to JSON responses. */
export class AuthzError extends Error {
	constructor(
		public readonly status: 401 | 403 | 404,
		message: string,
	) {
		super(message);
		this.name = "AuthzError";
	}
}

async function readSettings(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown> | null> {
	const obj = await env.BUCKET.get(settingsKey(mailboxId));
	if (!obj) return null;
	return (await obj.json()) as Record<string, unknown>;
}

function settingsKey(mailboxId: string): string {
	return `mailboxes/${mailboxId}.json`;
}

function extractAcl(settings: Record<string, unknown>): MailboxAcl {
	const rawOwner = settings.owner;
	const rawMembers = settings.members;
	return {
		owner: typeof rawOwner === "string" && rawOwner ? normalizeEmail(rawOwner) : undefined,
		members: Array.isArray(rawMembers)
			? (rawMembers as unknown[])
					.filter((m): m is string => typeof m === "string" && m.length > 0)
					.map(normalizeEmail)
			: [],
	};
}

/** Fetch ACL for a mailbox. Returns null if the mailbox does not exist. */
export async function getMailboxAcl(
	env: Env,
	mailboxId: string,
): Promise<MailboxAcl | null> {
	const settings = await readSettings(env, mailboxId);
	if (!settings) return null;
	return extractAcl(settings);
}

/** Pure predicate: does this user have rw access given the ACL? */
export function hasMailboxAccess(acl: MailboxAcl, user: AuthUser): boolean {
	if (user.system) return true;
	if (acl.owner && acl.owner === user.email) return true;
	return acl.members.includes(user.email);
}

/**
 * Assert that the user can access this mailbox.
 * - Missing mailbox → throws 404.
 * - System callers and admins → always pass.
 * - Owner or member → passes.
 * - Ownerless mailbox (no owner field set) → 403 for normal users; an admin
 *   must explicitly assign an owner via POST /api/v1/admin/mailboxes/:id/owner.
 *   This intentionally removes the previous claim-on-first-access behavior so
 *   shared mailboxes cannot be hijacked by whoever logs in first.
 * - Otherwise → throws 403.
 */
export async function assertMailboxAccess(
	env: Env,
	mailboxId: string,
	user: AuthUser,
): Promise<void> {
	const settings = await readSettings(env, mailboxId);
	if (!settings) throw new AuthzError(404, "Mailbox not found");

	if (user.system) return;
	if (isAdmin(env, user)) return;

	const acl = extractAcl(settings);
	if (!acl.owner) {
		throw new AuthzError(
			403,
			"Mailbox has no owner; ask an admin to assign one",
		);
	}
	if (!hasMailboxAccess(acl, user)) {
		throw new AuthzError(403, "Not authorized for this mailbox");
	}
}

/** Assert that the user is the owner (required for member management, delete). */
export async function assertMailboxOwner(
	env: Env,
	mailboxId: string,
	user: AuthUser,
): Promise<void> {
	const acl = await getMailboxAcl(env, mailboxId);
	if (!acl) throw new AuthzError(404, "Mailbox not found");
	if (user.system) return;
	if (isAdmin(env, user)) return;
	if (!acl.owner) {
		throw new AuthzError(
			403,
			"Mailbox has no owner; ask an admin to assign one",
		);
	}
	if (acl.owner !== user.email) {
		throw new AuthzError(403, "Only the mailbox owner can perform this action");
	}
}

/** Atomically (read-modify-write) stamp an owner onto a mailbox that has none. */
export async function claimMailbox(
	env: Env,
	mailboxId: string,
	ownerEmail: string,
): Promise<void> {
	const key = settingsKey(mailboxId);
	const obj = await env.BUCKET.get(key);
	if (!obj) throw new AuthzError(404, "Mailbox not found");
	const settings = (await obj.json()) as Record<string, unknown>;
	if (typeof settings.owner === "string" && settings.owner) return; // lost the race
	const next = {
		...settings,
		owner: normalizeEmail(ownerEmail),
		members: Array.isArray(settings.members) ? settings.members : [],
	};
	await env.BUCKET.put(key, JSON.stringify(next));
}

/**
 * List mailboxes this user can see.
 * - Admins (and system callers) see every mailbox, including legacy ownerless
 *   ones, so they can route or repair them.
 * - Normal users see only mailboxes where they are explicitly owner or member.
 *   Legacy ownerless mailboxes are hidden — they are not claimable by browsing.
 */
export async function listUserMailboxes(
	env: Env,
	user: AuthUser,
): Promise<{ id: string; email: string }[]> {
	const list = await env.BUCKET.list({ prefix: "mailboxes/" });
	const results: { id: string; email: string }[] = [];
	const isPrivileged = user.system || isAdmin(env, user);
	await Promise.all(
		list.objects.map(async (entry) => {
			const obj = await env.BUCKET.get(entry.key);
			if (!obj) return;
			const settings = (await obj.json()) as Record<string, unknown>;
			const acl = extractAcl(settings);
			const id = entry.key.replace("mailboxes/", "").replace(".json", "");
			if (isPrivileged) {
				results.push({ id, email: id });
				return;
			}
			if (acl.owner && hasMailboxAccess(acl, user)) {
				results.push({ id, email: id });
			}
		}),
	);
	return results;
}

/**
 * Admin-only: replace the owner of a mailbox.
 * Used to assign ownership of legacy ownerless mailboxes and to transfer
 * ownership when team membership changes. The previous owner (if any and
 * different from the new owner) is preserved as a member so they keep
 * collaboration access.
 */
export async function setMailboxOwner(
	env: Env,
	mailboxId: string,
	newOwnerEmail: string,
): Promise<MailboxAcl> {
	const key = settingsKey(mailboxId);
	const obj = await env.BUCKET.get(key);
	if (!obj) throw new AuthzError(404, "Mailbox not found");
	const settings = (await obj.json()) as Record<string, unknown>;
	const acl = extractAcl(settings);
	const owner = normalizeEmail(newOwnerEmail);
	const memberSet = new Set(acl.members.filter((m) => m !== owner));
	if (acl.owner && acl.owner !== owner) memberSet.add(acl.owner);
	const members = [...memberSet];
	const next = { ...settings, owner, members };
	await env.BUCKET.put(key, JSON.stringify(next));
	return { owner, members };
}

/** Owner-only: add a member. Idempotent. */
export async function addMailboxMember(
	env: Env,
	mailboxId: string,
	memberEmail: string,
): Promise<MailboxAcl> {
	const key = settingsKey(mailboxId);
	const obj = await env.BUCKET.get(key);
	if (!obj) throw new AuthzError(404, "Mailbox not found");
	const settings = (await obj.json()) as Record<string, unknown>;
	const acl = extractAcl(settings);
	const normalized = normalizeEmail(memberEmail);
	if (acl.owner === normalized || acl.members.includes(normalized)) return acl;
	const members = [...acl.members, normalized];
	const next = { ...settings, members };
	await env.BUCKET.put(key, JSON.stringify(next));
	return { owner: acl.owner, members };
}

/** Owner-only: remove a member. Idempotent. */
export async function removeMailboxMember(
	env: Env,
	mailboxId: string,
	memberEmail: string,
): Promise<MailboxAcl> {
	const key = settingsKey(mailboxId);
	const obj = await env.BUCKET.get(key);
	if (!obj) throw new AuthzError(404, "Mailbox not found");
	const settings = (await obj.json()) as Record<string, unknown>;
	const acl = extractAcl(settings);
	const normalized = normalizeEmail(memberEmail);
	const members = acl.members.filter((m) => m !== normalized);
	if (members.length === acl.members.length) return acl;
	const next = { ...settings, members };
	await env.BUCKET.put(key, JSON.stringify(next));
	return { owner: acl.owner, members };
}

/** Bootstrap-admin email set, used to promote new accounts on creation. */
export function parseBootstrapAdmins(env: Env): Set<string> {
	if (!env.ADMINS) return new Set();
	return new Set(
		env.ADMINS.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map(normalizeEmail),
	);
}

export function isAdmin(_env: Env, user: AuthUser): boolean {
	return user.role === "admin";
}

// ── Invite tokens ──────────────────────────────────────────────────

/** Claims embedded in a signed invite token. */
export interface InviteClaims {
	/** Mailbox the invite grants member access to. */
	mbx: string;
	/** Email of the owner who issued the invite. */
	by: string;
}

const INVITE_ISSUER = "agentic-inbox";
const INVITE_AUDIENCE = "mailbox-invite";
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function inviteSigningKey(env: Env): Uint8Array {
	if (!env.INTERNAL_SECRET) {
		throw new AuthzError(
			403,
			"INTERNAL_SECRET not configured — invite links are disabled. Set via `wrangler secret put INTERNAL_SECRET`.",
		);
	}
	return new TextEncoder().encode(env.INTERNAL_SECRET);
}

/** Owner-only: issue a short-lived invite token for a mailbox. */
export async function signInviteToken(
	env: Env,
	mailboxId: string,
	invitedBy: string,
): Promise<{ token: string; expiresAt: number }> {
	const key = inviteSigningKey(env);
	const now = Math.floor(Date.now() / 1000);
	const exp = now + INVITE_TTL_SECONDS;
	const token = await new SignJWT({
		mbx: mailboxId,
		by: normalizeEmail(invitedBy),
	})
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer(INVITE_ISSUER)
		.setAudience(INVITE_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(exp)
		.sign(key);
	return { token, expiresAt: exp };
}

/** Verify an invite token. Throws AuthzError(403) on failure. */
export async function verifyInviteToken(
	env: Env,
	token: string,
): Promise<InviteClaims> {
	const key = inviteSigningKey(env);
	try {
		const { payload } = await jwtVerify(token, key, {
			issuer: INVITE_ISSUER,
			audience: INVITE_AUDIENCE,
		});
		const mbx = payload.mbx;
		const by = payload.by;
		if (typeof mbx !== "string" || typeof by !== "string") {
			throw new AuthzError(403, "Invite token missing fields");
		}
		return { mbx, by };
	} catch (e) {
		if (e instanceof AuthzError) throw e;
		throw new AuthzError(403, "Invalid or expired invite token");
	}
}
