// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * D1-backed user repository. Native auth records (id, email, password hash,
 * role, verification timestamp). Mailbox ACL still keys off `email` so this
 * table can grow independently of the existing R2 mailbox blobs.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, type UserRow } from "../db/auth-schema";
import type { Env } from "../types";

export type UserRole = "user" | "admin";

export interface UserRecord {
	id: string;
	email: string;
	emailVerifiedAt: number | null;
	passwordHash: string | null;
	role: UserRole;
	displayName: string | null;
	createdAt: number;
	updatedAt: number;
}

function toRecord(row: UserRow): UserRecord {
	return {
		id: row.id,
		email: row.email,
		emailVerifiedAt: row.emailVerifiedAt ?? null,
		passwordHash: row.passwordHash ?? null,
		role: (row.role === "admin" ? "admin" : "user") as UserRole,
		displayName: row.displayName ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function db(env: Env) {
	return drizzle(env.DB);
}

function normalize(email: string): string {
	return email.trim().toLowerCase();
}

function bootstrapAdmins(env: Env): Set<string> {
	if (!env.ADMINS) return new Set();
	return new Set(
		env.ADMINS.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

export async function findUserByEmail(
	env: Env,
	email: string,
): Promise<UserRecord | null> {
	const rows = await db(env)
		.select()
		.from(users)
		.where(eq(users.email, normalize(email)))
		.limit(1);
	return rows[0] ? toRecord(rows[0]) : null;
}

export async function findUserById(
	env: Env,
	id: string,
): Promise<UserRecord | null> {
	const rows = await db(env).select().from(users).where(eq(users.id, id)).limit(1);
	return rows[0] ? toRecord(rows[0]) : null;
}

export interface CreateUserInput {
	email: string;
	passwordHash?: string | null;
	displayName?: string | null;
	emailVerifiedAt?: number | null;
}

export async function createUser(
	env: Env,
	input: CreateUserInput,
): Promise<UserRecord> {
	const email = normalize(input.email);
	const now = Date.now();
	const role: UserRole = bootstrapAdmins(env).has(email) ? "admin" : "user";
	const id = crypto.randomUUID();
	await db(env).insert(users).values({
		id,
		email,
		passwordHash: input.passwordHash ?? null,
		displayName: input.displayName ?? null,
		emailVerifiedAt: input.emailVerifiedAt ?? null,
		role,
		createdAt: now,
		updatedAt: now,
	});
	return {
		id,
		email,
		passwordHash: input.passwordHash ?? null,
		displayName: input.displayName ?? null,
		emailVerifiedAt: input.emailVerifiedAt ?? null,
		role,
		createdAt: now,
		updatedAt: now,
	};
}

export async function setPasswordHash(
	env: Env,
	userId: string,
	passwordHash: string,
): Promise<void> {
	await db(env)
		.update(users)
		.set({ passwordHash, updatedAt: Date.now() })
		.where(eq(users.id, userId));
}

export async function markEmailVerified(env: Env, userId: string): Promise<void> {
	const now = Date.now();
	await db(env)
		.update(users)
		.set({ emailVerifiedAt: now, updatedAt: now })
		.where(eq(users.id, userId));
}

export async function setRole(
	env: Env,
	userId: string,
	role: UserRole,
): Promise<void> {
	await db(env)
		.update(users)
		.set({ role, updatedAt: Date.now() })
		.where(eq(users.id, userId));
}

export async function listUsers(env: Env): Promise<UserRecord[]> {
	const rows = await db(env).select().from(users);
	return rows.map(toRecord);
}

/**
 * Look up an existing user or create one for the given email. Used by the
 * Cloudflare Access compatibility shim: an Access-authenticated request whose
 * email isn't in D1 yet gets a verified, password-less account.
 */
export async function ensureUser(
	env: Env,
	email: string,
	opts: { emailVerified?: boolean } = {},
): Promise<UserRecord> {
	const existing = await findUserByEmail(env, email);
	if (existing) return existing;
	return createUser(env, {
		email,
		emailVerifiedAt: opts.emailVerified ? Date.now() : null,
	});
}
