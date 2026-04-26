// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * API keys for programmatic / MCP access.
 *
 * Format: `aix_<base64url(32 random bytes)>` (≈ 47 chars). The raw key is
 * shown to the user once at creation time. We store:
 *   - prefix (first 8 chars after `aix_`) for UI display + narrow indexed scans
 *   - sha256(raw) for verification (constant-time compare via subtle digest equality)
 *
 * Verification path is hot — all `/api/*` and `/mcp/*` requests carrying a
 * Bearer token go through it. We use a single indexed lookup on key_hash.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull, desc } from "drizzle-orm";
import { apiKeys, type ApiKeyRow } from "../db/auth-schema";
import type { Env } from "../types";

const KEY_PREFIX = "aix_";
const RAW_BYTES = 32;
const PREFIX_LEN = 8;

function db(env: Env) {
	return drizzle(env.DB);
}

function bytesToB64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

async function sha256Hex(s: string): Promise<string> {
	const data = new TextEncoder().encode(s);
	const buf = await crypto.subtle.digest("SHA-256", data);
	return bytesToHex(new Uint8Array(buf));
}

export interface ApiKeyPublic {
	id: string;
	name: string;
	prefix: string;
	lastUsedAt: number | null;
	expiresAt: number | null;
	revokedAt: number | null;
	createdAt: number;
}

function toPublic(row: ApiKeyRow): ApiKeyPublic {
	return {
		id: row.id,
		name: row.name,
		prefix: row.prefix,
		lastUsedAt: row.lastUsedAt ?? null,
		expiresAt: row.expiresAt ?? null,
		revokedAt: row.revokedAt ?? null,
		createdAt: row.createdAt,
	};
}

/** Issue a new key. Returns the raw key — shown to the user once. */
export async function issueApiKey(
	env: Env,
	userId: string,
	name: string,
	opts: { expiresAt?: number | null } = {},
): Promise<{ rawKey: string; record: ApiKeyPublic }> {
	const random = crypto.getRandomValues(new Uint8Array(RAW_BYTES));
	const body = bytesToB64Url(random);
	const rawKey = `${KEY_PREFIX}${body}`;
	const prefix = body.slice(0, PREFIX_LEN);
	const keyHash = await sha256Hex(rawKey);
	const id = crypto.randomUUID();
	const now = Date.now();
	await db(env).insert(apiKeys).values({
		id,
		userId,
		name: name.trim() || "Untitled key",
		prefix,
		keyHash,
		lastUsedAt: null,
		expiresAt: opts.expiresAt ?? null,
		revokedAt: null,
		createdAt: now,
	});
	return {
		rawKey,
		record: {
			id,
			name: name.trim() || "Untitled key",
			prefix,
			lastUsedAt: null,
			expiresAt: opts.expiresAt ?? null,
			revokedAt: null,
			createdAt: now,
		},
	};
}

/**
 * Look up a raw key. Returns the owning user id if the key is valid,
 * unrevoked, and unexpired. Otherwise null. Updates `last_used_at` lazily
 * on hit (best-effort; not awaited by callers in the hot path).
 */
export async function verifyApiKey(
	env: Env,
	raw: string,
): Promise<{ id: string; userId: string } | null> {
	if (!raw.startsWith(KEY_PREFIX)) return null;
	const keyHash = await sha256Hex(raw);
	const rows = await db(env)
		.select()
		.from(apiKeys)
		.where(
			and(
				eq(apiKeys.keyHash, keyHash),
				isNull(apiKeys.revokedAt),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	if (row.expiresAt && row.expiresAt < Date.now()) return null;
	return { id: row.id, userId: row.userId };
}

/** Best-effort: bump last_used_at. Don't block the request on failure. */
export async function touchApiKey(env: Env, id: string): Promise<void> {
	try {
		await db(env)
			.update(apiKeys)
			.set({ lastUsedAt: Date.now() })
			.where(eq(apiKeys.id, id));
	} catch (e) {
		console.error("touchApiKey failed:", (e as Error).message);
	}
}

export async function listApiKeys(
	env: Env,
	userId: string,
): Promise<ApiKeyPublic[]> {
	const rows = await db(env)
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.userId, userId))
		.orderBy(desc(apiKeys.createdAt));
	return rows.map(toPublic);
}

export async function revokeApiKey(
	env: Env,
	userId: string,
	id: string,
): Promise<boolean> {
	const rows = await db(env)
		.select({ id: apiKeys.id, userId: apiKeys.userId, revokedAt: apiKeys.revokedAt })
		.from(apiKeys)
		.where(eq(apiKeys.id, id))
		.limit(1);
	const row = rows[0];
	if (!row || row.userId !== userId) return false;
	if (row.revokedAt) return true; // already revoked, idempotent
	await db(env)
		.update(apiKeys)
		.set({ revokedAt: Date.now() })
		.where(eq(apiKeys.id, id));
	return true;
}
