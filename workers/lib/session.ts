// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cookie-backed sessions stored in D1. The cookie carries an opaque random id
 * (no claims). Server-side lookup means revoking a session is instant.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { sessions } from "../db/auth-schema";
import type { Env } from "../types";

export const SESSION_COOKIE = "aix_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ID_BYTES = 32;

function db(env: Env) {
	return drizzle(env.DB);
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

function newSessionId(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

export interface CreateSessionInput {
	userId: string;
	userAgent?: string | null;
	ip?: string | null;
}

export async function createSession(
	env: Env,
	input: CreateSessionInput,
): Promise<{ id: string; expiresAt: number }> {
	const id = newSessionId();
	const now = Date.now();
	const expiresAt = now + SESSION_TTL_MS;
	await db(env).insert(sessions).values({
		id,
		userId: input.userId,
		expiresAt,
		createdAt: now,
		userAgent: input.userAgent ?? null,
		ip: input.ip ?? null,
	});
	return { id, expiresAt };
}

export async function findSession(
	env: Env,
	id: string,
): Promise<{ id: string; userId: string; expiresAt: number } | null> {
	const rows = await db(env)
		.select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt })
		.from(sessions)
		.where(eq(sessions.id, id))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	if (row.expiresAt < Date.now()) {
		await deleteSession(env, id).catch(() => {});
		return null;
	}
	return row;
}

export async function deleteSession(env: Env, id: string): Promise<void> {
	await db(env).delete(sessions).where(eq(sessions.id, id));
}

export async function deleteSessionsForUser(
	env: Env,
	userId: string,
): Promise<void> {
	await db(env).delete(sessions).where(eq(sessions.userId, userId));
}

export async function purgeExpiredSessions(env: Env): Promise<void> {
	await db(env).delete(sessions).where(lt(sessions.expiresAt, Date.now()));
}

// ── Cookie helpers ─────────────────────────────────────────────────

export function buildSessionCookie(id: string, expiresAt: number): string {
	const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
	const parts = [
		`${SESSION_COOKIE}=${id}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAge}`,
	];
	if (!import.meta.env.DEV) parts.push("Secure");
	return parts.join("; ");
}

export function buildClearSessionCookie(): string {
	const parts = [
		`${SESSION_COOKIE}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
	];
	if (!import.meta.env.DEV) parts.push("Secure");
	return parts.join("; ");
}

export function readSessionCookie<E extends { Bindings: Env }>(
	c: Context<E>,
): string | null {
	const header = c.req.header("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === SESSION_COOKIE) return rest.join("=") || null;
	}
	return null;
}
