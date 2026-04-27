// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * D1-backed mailbox directory + membership index.
 *
 * Shadow of the legacy R2 ACL blobs in `mailboxes/<id>.json`. During the
 * dual-write phase (PR 3) the R2 helpers in `workers/lib/auth.ts` call into
 * here after each successful R2 write so D1 stays in sync. The per-mailbox
 * ACL gate (`assertMailboxAccess`) and `listUserMailboxes` still read from
 * R2 — PR 4 will cut those reads over.
 *
 * Failures here are logged but do NOT throw, so an unrelated D1 hiccup
 * cannot break a working R2-side ACL operation. Drift is reconciled by
 * `POST /api/v1/admin/mailbox-directory/backfill`.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull, or } from "drizzle-orm";
import { mailboxes, mailboxMembers, type MailboxRow, type MailboxMemberRow } from "../db/mailbox-schema";
import { findUserByEmail } from "./users";
import type { Env } from "../types";

function db(env: Env) {
	return drizzle(env.DB);
}

function normalize(email: string): string {
	return email.trim().toLowerCase();
}

function now(): number {
	return Date.now();
}

/** Structured log helper — keeps D1 dual-write failures legible without
 *  spamming with stack traces in the success path. */
function logFailure(op: string, mailboxId: string, e: unknown): void {
	const message = e instanceof Error ? e.message : String(e);
	console.error(
		`[mailbox-directory] ${op} failed for "${mailboxId}": ${message}`,
	);
}

export interface MailboxDirectoryRecord {
	id: string;
	ownerUserId: string | null;
	ownerEmail: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface MailboxMemberRecord {
	mailboxId: string;
	email: string;
	userId: string | null;
	addedAt: number;
	addedByUserId: string | null;
}

function rowToMailbox(row: MailboxRow): MailboxDirectoryRecord {
	return {
		id: row.id,
		ownerUserId: row.ownerUserId ?? null,
		ownerEmail: row.ownerEmail ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function rowToMember(row: MailboxMemberRow): MailboxMemberRecord {
	return {
		mailboxId: row.mailboxId,
		email: row.email,
		userId: row.userId ?? null,
		addedAt: row.addedAt,
		addedByUserId: row.addedByUserId ?? null,
	};
}

// ── Reads ──────────────────────────────────────────────────────────

export async function getMailboxRecord(
	env: Env,
	mailboxId: string,
): Promise<MailboxDirectoryRecord | null> {
	const id = normalize(mailboxId);
	const rows = await db(env)
		.select()
		.from(mailboxes)
		.where(eq(mailboxes.id, id))
		.limit(1);
	return rows[0] ? rowToMailbox(rows[0]) : null;
}

export async function listMailboxMembers(
	env: Env,
	mailboxId: string,
): Promise<MailboxMemberRecord[]> {
	const id = normalize(mailboxId);
	const rows = await db(env)
		.select()
		.from(mailboxMembers)
		.where(eq(mailboxMembers.mailboxId, id));
	return rows.map(rowToMember);
}

/** All mailbox ids visible to a user via D1 (owner OR member). Not yet
 *  consulted by `listUserMailboxes` — exposed for diagnostics + the PR 4
 *  cutover. */
export async function listMailboxIdsForUser(
	env: Env,
	user: { id: string; email: string },
): Promise<string[]> {
	const email = normalize(user.email);
	const ownedRows = await db(env)
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(or(eq(mailboxes.ownerUserId, user.id), eq(mailboxes.ownerEmail, email)));
	const memberRows = await db(env)
		.select({ id: mailboxMembers.mailboxId })
		.from(mailboxMembers)
		.where(or(eq(mailboxMembers.userId, user.id), eq(mailboxMembers.email, email)));
	const set = new Set<string>();
	for (const r of ownedRows) set.add(r.id);
	for (const r of memberRows) set.add(r.id);
	return [...set];
}

export async function listAllMailboxRecords(
	env: Env,
): Promise<MailboxDirectoryRecord[]> {
	const rows = await db(env).select().from(mailboxes);
	return rows.map(rowToMailbox);
}

// ── Writes (best-effort dual-write companions to R2 ACL ops) ──────

/** Upsert a mailboxes row. Used by the create / claim / set-owner paths. */
export async function upsertMailboxRecord(
	env: Env,
	mailboxId: string,
	ownerEmail: string | null,
): Promise<void> {
	const id = normalize(mailboxId);
	const ownerEmailNorm = ownerEmail ? normalize(ownerEmail) : null;
	const ownerUserId = ownerEmailNorm
		? (await findUserByEmail(env, ownerEmailNorm))?.id ?? null
		: null;
	const ts = now();
	try {
		await db(env)
			.insert(mailboxes)
			.values({
				id,
				ownerUserId,
				ownerEmail: ownerEmailNorm,
				createdAt: ts,
				updatedAt: ts,
			})
			.onConflictDoUpdate({
				target: mailboxes.id,
				set: { ownerUserId, ownerEmail: ownerEmailNorm, updatedAt: ts },
			});
	} catch (e) {
		logFailure("upsertMailboxRecord", id, e);
	}
}

/** Delete the directory + membership rows for a mailbox. Called from the
 *  R2-side delete handler so D1 does not retain orphan ACL records. */
export async function deleteMailboxRecord(
	env: Env,
	mailboxId: string,
): Promise<void> {
	const id = normalize(mailboxId);
	try {
		// Members cascade via FK, but explicit delete keeps the audit trail
		// readable even if a future migration loosens the FK.
		await db(env).delete(mailboxMembers).where(eq(mailboxMembers.mailboxId, id));
		await db(env).delete(mailboxes).where(eq(mailboxes.id, id));
	} catch (e) {
		logFailure("deleteMailboxRecord", id, e);
	}
}

/** Add or refresh a mailbox_members row. Idempotent on (mailbox_id, email). */
export async function addMemberRecord(
	env: Env,
	mailboxId: string,
	memberEmail: string,
	addedByUserId: string | null,
): Promise<void> {
	const id = normalize(mailboxId);
	const email = normalize(memberEmail);
	const userId = (await findUserByEmail(env, email))?.id ?? null;
	const ts = now();
	try {
		await db(env)
			.insert(mailboxMembers)
			.values({
				mailboxId: id,
				email,
				userId,
				addedAt: ts,
				addedByUserId,
			})
			.onConflictDoUpdate({
				target: [mailboxMembers.mailboxId, mailboxMembers.email],
				set: { userId, addedByUserId, addedAt: ts },
			});
	} catch (e) {
		logFailure("addMemberRecord", `${id}:${email}`, e);
	}
}

export async function removeMemberRecord(
	env: Env,
	mailboxId: string,
	memberEmail: string,
): Promise<void> {
	const id = normalize(mailboxId);
	const email = normalize(memberEmail);
	try {
		await db(env)
			.delete(mailboxMembers)
			.where(and(eq(mailboxMembers.mailboxId, id), eq(mailboxMembers.email, email)));
	} catch (e) {
		logFailure("removeMemberRecord", `${id}:${email}`, e);
	}
}

/**
 * Replace the full member roster for a mailbox in one shot. Used by the
 * backfill endpoint where the R2 blob is the source of truth — anything in
 * D1 that isn't in R2 should disappear.
 */
export async function replaceMembersRecord(
	env: Env,
	mailboxId: string,
	members: { email: string; userId?: string | null }[],
	addedByUserId: string | null,
): Promise<void> {
	const id = normalize(mailboxId);
	const ts = now();
	try {
		await db(env).delete(mailboxMembers).where(eq(mailboxMembers.mailboxId, id));
		if (members.length === 0) return;
		const values = await Promise.all(
			members.map(async (m) => {
				const email = normalize(m.email);
				const userId =
					m.userId !== undefined
						? m.userId
						: (await findUserByEmail(env, email))?.id ?? null;
				return {
					mailboxId: id,
					email,
					userId,
					addedAt: ts,
					addedByUserId,
				};
			}),
		);
		await db(env).insert(mailboxMembers).values(values);
	} catch (e) {
		logFailure("replaceMembersRecord", id, e);
	}
}

// ── Maintenance ────────────────────────────────────────────────────

/**
 * Backfill stale `user_id` columns when a previously invited email gets
 * registered. Cheap enough to run on a schedule or from an admin endpoint.
 */
export async function reconcileUserIds(env: Env): Promise<{ updated: number }> {
	const orphanMembers = await db(env)
		.select({ email: mailboxMembers.email, mailboxId: mailboxMembers.mailboxId })
		.from(mailboxMembers)
		.where(isNull(mailboxMembers.userId));
	let updated = 0;
	for (const row of orphanMembers) {
		const userRow = await findUserByEmail(env, row.email);
		if (!userRow) continue;
		await db(env)
			.update(mailboxMembers)
			.set({ userId: userRow.id })
			.where(
				and(
					eq(mailboxMembers.mailboxId, row.mailboxId),
					eq(mailboxMembers.email, row.email),
				),
			);
		updated += 1;
	}
	const orphanOwners = await db(env)
		.select({ id: mailboxes.id, ownerEmail: mailboxes.ownerEmail })
		.from(mailboxes)
		.where(isNull(mailboxes.ownerUserId));
	for (const row of orphanOwners) {
		if (!row.ownerEmail) continue;
		const userRow = await findUserByEmail(env, row.ownerEmail);
		if (!userRow) continue;
		await db(env)
			.update(mailboxes)
			.set({ ownerUserId: userRow.id, updatedAt: now() })
			.where(eq(mailboxes.id, row.id));
		updated += 1;
	}
	return { updated };
}

