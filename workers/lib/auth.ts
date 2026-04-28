// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox authorization layer + identity types.
 *
 * Identity comes from the native auth system (cookie session backed by D1 —
 * see workers/lib/session.ts and workers/routes/auth.ts). Cloudflare Access
 * JWTs are still honored as a fallback for backward compatibility: if
 * POLICY_AUD/TEAM_DOMAIN are set, the middleware in workers/app.ts will mint
 * a session for the JWT's email so existing Access-only users stay logged in.
 *
 * Mailbox ACL is sourced from the D1 mailbox-directory tables. R2 is no
 * longer consulted — second-wave PR 9 retired the legacy self-heal fallback.
 */
import { SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import {
	addMemberRecord,
	getMailboxRecord,
	listAllMailboxRecords,
	listMailboxIdsForUser,
	listMailboxMembers,
	removeMemberRecord,
	upsertMailboxRecord,
} from "./mailbox-directory";
import type { Env } from "../types";

export interface AuthUser {
	/** D1 users.id; "__system__" for internal worker calls. */
	id: string;
	email: string;
	role: "user" | "admin";
	/** true for internal worker-to-worker calls (e.g. inbound email → auto-draft). */
	system?: boolean;
}

/**
 * @deprecated Superseded by {@link INTERNAL_AUTH_CONTEXT_HEADER}. This header
 * carried only the caller's email, forcing every Durable Object to re-resolve
 * role from D1. Removed once no consumer reads it; the Hono layer still strips
 * any inbound value to defang spoofing during the rollout.
 */
export const INTERNAL_USER_HEADER = "x-internal-user-email";

/**
 * Header carrying a signed internal auth-context JWT from the Hono layer to
 * Durable Objects. Payload is an {@link InternalAuthClaims}: full
 * `id`/`email`/`role`/`system` so the DO does not have to round-trip D1.
 * Hono strips any inbound value before re-injecting one signed with
 * {@link Env.INTERNAL_SECRET}.
 */
export const INTERNAL_AUTH_CONTEXT_HEADER = "x-internal-auth-context";

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

/**
 * Fetch ACL for a mailbox. Returns null if the mailbox does not exist.
 *
 * D1 mailbox-directory is the sole source of truth (PR 9 retired the R2
 * self-heal fallback). Any mailbox that still exists only as a legacy
 * `mailboxes/<id>.json` blob in R2 must be backfilled into D1 via
 * `POST /api/v1/admin/mailbox-directory/backfill` — the auth layer no longer
 * resurrects them on-the-fly.
 */
export async function getMailboxAcl(
	env: Env,
	mailboxId: string,
): Promise<MailboxAcl | null> {
	const record = await getMailboxRecord(env, mailboxId);
	if (!record) return null;
	const memberRows = await listMailboxMembers(env, mailboxId);
	return {
		owner: record.ownerEmail ?? undefined,
		members: memberRows.map((r) => r.email),
	};
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
	// D1-first existence + ACL check. `getMailboxAcl` self-heals from R2 if a
	// legacy un-backfilled mailbox is encountered.
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

/** Stamp an owner onto a mailbox that has none. D1 row is the sole authority;
 *  if the row is missing the mailbox does not exist. Idempotent: if another
 *  caller wrote an owner first, this is a no-op rather than an overwrite. */
export async function claimMailbox(
	env: Env,
	mailboxId: string,
	ownerEmail: string,
): Promise<void> {
	const record = await getMailboxRecord(env, mailboxId);
	if (!record) throw new AuthzError(404, "Mailbox not found");
	if (record.ownerEmail) return; // lost the race
	await upsertMailboxRecord(env, mailboxId, normalizeEmail(ownerEmail), {
		strict: true,
	});
}

/**
 * List mailboxes this user can see.
 *
 * Answered entirely from the D1 mailbox-directory:
 * - Privileged callers (admin / system) get every mailbox row, including
 *   ownerless ones, so they can route or repair them.
 * - Normal users see only mailboxes where they are owner or explicit
 *   member. Ownerless legacy mailboxes are hidden — they are not
 *   claimable by browsing.
 *
 * R2 is no longer consulted. Any mailbox missing from D1 must be backfilled
 * via `POST /api/v1/admin/mailbox-directory/backfill`.
 */
export async function listUserMailboxes(
	env: Env,
	user: AuthUser,
): Promise<{ id: string; email: string }[]> {
	const isPrivileged = user.system || isAdmin(env, user);
	if (isPrivileged) {
		const records = await listAllMailboxRecords(env);
		return records.map((r) => ({ id: r.id, email: r.id }));
	}
	const ids = await listMailboxIdsForUser(env, user);
	// Hide ownerless mailboxes for normal users.
	const results: { id: string; email: string }[] = [];
	for (const id of ids) {
		const record = await getMailboxRecord(env, id);
		if (!record?.ownerEmail) continue;
		results.push({ id, email: id });
	}
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
	const record = await getMailboxRecord(env, mailboxId);
	if (!record) throw new AuthzError(404, "Mailbox not found");
	const memberRows = await listMailboxMembers(env, mailboxId);
	const owner = normalizeEmail(newOwnerEmail);
	const previousOwner = record.ownerEmail ?? undefined;
	const memberSet = new Set(memberRows.map((r) => r.email).filter((m) => m !== owner));
	if (previousOwner && previousOwner !== owner) memberSet.add(previousOwner);
	// 1. Promote the new owner.
	// 2. Drop the new owner from `mailbox_members` if they had been a member —
	//    otherwise the joined "owner OR member" view double-counts.
	// 3. Demote the previous owner into `mailbox_members`.
	await upsertMailboxRecord(env, mailboxId, owner, { strict: true });
	await removeMemberRecord(env, mailboxId, owner);
	if (previousOwner && previousOwner !== owner) {
		await addMemberRecord(env, mailboxId, previousOwner, null);
	}
	return { owner, members: [...memberSet] };
}

/** Owner-only: add a member. Idempotent. addedByUserId is left null because
 *  the auth-layer helpers do not yet carry caller identity context; the
 *  mailbox-directory backfill ties the row to a user when the email later
 *  registers in `users`. */
export async function addMailboxMember(
	env: Env,
	mailboxId: string,
	memberEmail: string,
): Promise<MailboxAcl> {
	const record = await getMailboxRecord(env, mailboxId);
	if (!record) throw new AuthzError(404, "Mailbox not found");
	const normalized = normalizeEmail(memberEmail);
	const owner = record.ownerEmail ?? undefined;
	if (owner === normalized) {
		const memberRows = await listMailboxMembers(env, mailboxId);
		return { owner, members: memberRows.map((r) => r.email) };
	}
	await addMemberRecord(env, mailboxId, normalized, null);
	const memberRows = await listMailboxMembers(env, mailboxId);
	return { owner, members: memberRows.map((r) => r.email) };
}

/** Owner-only: remove a member. Idempotent. */
export async function removeMailboxMember(
	env: Env,
	mailboxId: string,
	memberEmail: string,
): Promise<MailboxAcl> {
	const record = await getMailboxRecord(env, mailboxId);
	if (!record) throw new AuthzError(404, "Mailbox not found");
	await removeMemberRecord(env, mailboxId, normalizeEmail(memberEmail));
	const memberRows = await listMailboxMembers(env, mailboxId);
	return {
		owner: record.ownerEmail ?? undefined,
		members: memberRows.map((r) => r.email),
	};
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

// ── Internal auth context ──────────────────────────────────────────
//
// Signed envelope used by the Hono layer to forward an already-authenticated
// user identity to Durable Objects (EmailMCP, EmailAgent, InvoiceAgent).
// Carries the full {id, email, role, system?} so DOs do not need to re-query
// D1 to recover role. Signed with `INTERNAL_SECRET` (HS256, audience-bound,
// short TTL) so a leaked or replayed token from outside the trust boundary
// cannot be used.

const INTERNAL_AUTH_ISSUER = "agentic-inbox";
const INTERNAL_AUTH_AUDIENCE = "internal-do-auth";
const INTERNAL_AUTH_TTL_SECONDS = 60;

/** Decoded payload of {@link INTERNAL_AUTH_CONTEXT_HEADER}. */
export interface InternalAuthClaims {
	sub: string;
	email: string;
	role: "user" | "admin";
	system?: boolean;
	iss: string;
	aud: string;
	iat: number;
	exp: number;
}

function internalAuthSigningKey(env: Env): Uint8Array {
	if (!env.INTERNAL_SECRET) {
		// Misconfiguration, not a per-request auth failure: a plain Error
		// surfaces as 500 to the client which is the correct semantic. Hit
		// from the Hono → DO hop on every /mcp and /agents/* request, so this
		// will fire on the first chat or MCP call after a deploy without the
		// secret. The fix is in README.md → Configuration.
		throw new Error(
			"INTERNAL_SECRET is required but not configured. /mcp and /agents/* cannot mint internal auth context. Set it via `wrangler secret put INTERNAL_SECRET` (or in `.dev.vars` for local dev).",
		);
	}
	return new TextEncoder().encode(env.INTERNAL_SECRET);
}

/**
 * Mint a signed internal auth-context JWT for the given user.
 *
 * Used only by the Worker layer (Hono → DO hop). Throws if INTERNAL_SECRET is
 * missing — that is a deployment misconfiguration, not a per-request error.
 */
export async function serializeInternalAuthContext(
	user: AuthUser,
	env: Env,
): Promise<string> {
	const key = internalAuthSigningKey(env);
	const now = Math.floor(Date.now() / 1000);
	const exp = now + INTERNAL_AUTH_TTL_SECONDS;
	const payload: Record<string, unknown> = {
		email: normalizeEmail(user.email),
		role: user.role,
	};
	if (user.system) payload.system = true;
	return await new SignJWT(payload)
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(user.id)
		.setIssuer(INTERNAL_AUTH_ISSUER)
		.setAudience(INTERNAL_AUTH_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(exp)
		.sign(key);
}

/**
 * Verify a signed internal auth-context JWT and return the decoded user.
 * Throws AuthzError(401) if the token is malformed, unverifiable, or missing
 * required claims.
 */
export async function parseInternalAuthContext(
	token: string,
	env: Env,
): Promise<AuthUser> {
	const key = internalAuthSigningKey(env);
	let payload: Record<string, unknown>;
	try {
		const result = await jwtVerify(token, key, {
			issuer: INTERNAL_AUTH_ISSUER,
			audience: INTERNAL_AUTH_AUDIENCE,
		});
		payload = result.payload as Record<string, unknown>;
	} catch {
		throw new AuthzError(401, "Invalid internal auth context");
	}
	const sub = payload.sub;
	const email = payload.email;
	const role = payload.role;
	if (typeof sub !== "string" || !sub) {
		throw new AuthzError(401, "Internal auth context missing sub");
	}
	if (typeof email !== "string" || !email) {
		throw new AuthzError(401, "Internal auth context missing email");
	}
	if (role !== "user" && role !== "admin") {
		throw new AuthzError(401, "Internal auth context has invalid role");
	}
	const user: AuthUser = { id: sub, email, role };
	if (payload.system === true) user.system = true;
	return user;
}

/**
 * Read and verify {@link INTERNAL_AUTH_CONTEXT_HEADER} from a DO-side request.
 * Returns null when the header is absent (e.g. system-triggered email path).
 * Returns null when the token is present but invalid — DOs should treat that
 * as "no user context" and let downstream ACL checks deny, rather than crash.
 */
export async function readInternalAuthContextHeader(
	request: Request,
	env: Env,
): Promise<AuthUser | null> {
	const token = request.headers.get(INTERNAL_AUTH_CONTEXT_HEADER);
	if (!token) return null;
	try {
		return await parseInternalAuthContext(token, env);
	} catch {
		return null;
	}
}
