// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox authorization layer.
 *
 * Cloudflare Access gates the whole Worker; this module adds a second layer so
 * that each mailbox has one owner + optional members, and only those Access
 * identities can read/write it. Ownership lives inside the existing R2 mailbox
 * settings blob to avoid adding a second storage backend.
 */
import { decodeJwt, SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import type { Env } from "../types";

export interface AuthUser {
	email: string;
	/** true for internal worker-to-worker calls (e.g. inbound email → auto-draft). */
	system?: boolean;
}

/** Header used by the Hono layer to propagate the already-authenticated user
 *  email into DOs (EmailMCP) that would otherwise have to re-validate the JWT. */
export const INTERNAL_USER_HEADER = "x-internal-user-email";

/** Header used by receiveEmail → EmailAgent to mark the call as internal.
 *  Value must match env.INTERNAL_SECRET. */
export const INTERNAL_SYSTEM_HEADER = "x-internal-system";

/** Dev-only header: impersonate any user for local curl testing. Only honored
 *  when import.meta.env.DEV is true. */
export const DEV_USER_HEADER = "x-dev-user";

const DEFAULT_DEV_USER: AuthUser = { email: "dev@local.test" };

export interface MailboxAcl {
	owner?: string;
	members: string[];
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Extract the authenticated user from a Hono request. The outer middleware is
 * expected to have already verified the Access JWT (signature + iss + aud);
 * here we cheaply decode the payload to read the `email` claim.
 */
export function getUserFromRequest<E extends { Bindings: Env }>(
	c: Context<E>,
): AuthUser {
	const sysHeader = c.req.header(INTERNAL_SYSTEM_HEADER);
	const sysSecret = c.env.INTERNAL_SECRET;
	if (sysHeader && sysSecret && sysHeader === sysSecret) {
		return { email: "__system__", system: true };
	}

	if (import.meta.env.DEV) {
		const devOverride = c.req.header(DEV_USER_HEADER);
		if (devOverride) return { email: normalizeEmail(devOverride) };
		return DEFAULT_DEV_USER;
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		throw new AuthzError(403, "Missing Access token");
	}

	let claims: { email?: unknown; common_name?: unknown; sub?: unknown };
	try {
		claims = decodeJwt(token) as {
			email?: unknown;
			common_name?: unknown;
			sub?: unknown;
		};
	} catch {
		throw new AuthzError(403, "Malformed Access token");
	}

	// Normal user JWTs carry the `email` claim.
	if (typeof claims.email === "string" && claims.email) {
		return { email: normalizeEmail(claims.email) };
	}

	// Cloudflare Access service tokens do NOT carry `email`; they carry
	// `common_name` (the token's display name, e.g. "my-token.access") and
	// `sub` (the token UUID). Synthesize a stable pseudo-email so per-mailbox
	// ACL treats the token as a distinct identity. Owners grant the token
	// access by calling `add_member` with this pseudo-email.
	const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
	const sub = typeof claims.sub === "string" ? claims.sub : "";
	if (commonName || sub) {
		const localPart = commonName
			? commonName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "")
			: `st-${sub}`;
		if (localPart) {
			return { email: `${localPart}@service.cloudflareaccess.local` };
		}
	}

	throw new AuthzError(403, "Access token has no email or common_name claim");
}

/** Thrown by ACL checks. Hono handlers should translate to JSON responses. */
export class AuthzError extends Error {
	constructor(
		public readonly status: 403 | 404,
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
 * - Legacy mailbox with no owner → claim-on-first-access: the user becomes
 *   the owner. (This keeps backward compat with R2 blobs created before ACL.)
 * - Owner or member → passes.
 * - Otherwise → throws 403.
 */
export async function assertMailboxAccess(
	env: Env,
	mailboxId: string,
	user: AuthUser,
): Promise<void> {
	const settings = await readSettings(env, mailboxId);
	if (!settings) throw new AuthzError(404, "Mailbox not found");

	const acl = extractAcl(settings);

	if (!acl.owner && !user.system) {
		await claimMailbox(env, mailboxId, user.email);
		return;
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
	if (!acl.owner) {
		// Legacy: claim ownership before proceeding.
		await claimMailbox(env, mailboxId, user.email);
		return;
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

/** List mailboxes this user can see (owner, member, or legacy-no-owner). */
export async function listUserMailboxes(
	env: Env,
	user: AuthUser,
): Promise<{ id: string; email: string }[]> {
	const list = await env.BUCKET.list({ prefix: "mailboxes/" });
	const results: { id: string; email: string }[] = [];
	await Promise.all(
		list.objects.map(async (entry) => {
			const obj = await env.BUCKET.get(entry.key);
			if (!obj) return;
			const settings = (await obj.json()) as Record<string, unknown>;
			const acl = extractAcl(settings);
			const id = entry.key.replace("mailboxes/", "").replace(".json", "");
			// Legacy blobs (no owner) remain visible so any user can claim them.
			if (!acl.owner || hasMailboxAccess(acl, user)) {
				results.push({ id, email: id });
			}
		}),
	);
	return results;
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

/** Parse the comma-separated ADMINS env var into a normalised set. */
export function parseAdmins(env: Env): Set<string> {
	if (!env.ADMINS) return new Set();
	return new Set(
		env.ADMINS.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.map(normalizeEmail),
	);
}

export function isAdmin(env: Env, user: AuthUser): boolean {
	return parseAdmins(env).has(user.email);
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
