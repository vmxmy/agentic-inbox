// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One-time email tokens used for verify-email, magic-link login, and password
 * reset. The raw token only ever lives in the recipient's inbox; D1 stores
 * the SHA-256 hash so a database leak does not yield usable tokens.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
import { emailTokens } from "../db/auth-schema";
import type { Env } from "../types";

export type TokenPurpose = "verify" | "magic" | "reset";

const TTL: Record<TokenPurpose, number> = {
	verify: 24 * 60 * 60 * 1000, // 24h
	magic: 15 * 60 * 1000, //         15min
	reset: 60 * 60 * 1000, //         1h
};

const RAW_BYTES = 32;

function db(env: Env) {
	return drizzle(env.DB);
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

export async function issueToken(
	env: Env,
	userId: string,
	purpose: TokenPurpose,
): Promise<{ rawToken: string; expiresAt: number }> {
	const raw = bytesToHex(crypto.getRandomValues(new Uint8Array(RAW_BYTES)));
	const tokenHash = await sha256Hex(raw);
	const now = Date.now();
	const expiresAt = now + TTL[purpose];
	await db(env).insert(emailTokens).values({
		id: crypto.randomUUID(),
		userId,
		purpose,
		tokenHash,
		expiresAt,
		consumedAt: null,
		createdAt: now,
	});
	return { rawToken: raw, expiresAt };
}

export interface ConsumedToken {
	userId: string;
	purpose: TokenPurpose;
}

/**
 * Look up a token by its raw value, mark it consumed, and return its userId.
 * Throws on missing / expired / already-consumed.
 */
export async function consumeToken(
	env: Env,
	raw: string,
	expectedPurpose: TokenPurpose,
): Promise<ConsumedToken> {
	const tokenHash = await sha256Hex(raw);
	const rows = await db(env)
		.select()
		.from(emailTokens)
		.where(
			and(
				eq(emailTokens.tokenHash, tokenHash),
				eq(emailTokens.purpose, expectedPurpose),
				isNull(emailTokens.consumedAt),
			),
		)
		.limit(1);
	const row = rows[0];
	if (!row) throw new TokenError("Invalid or already used token");
	if (row.expiresAt < Date.now()) throw new TokenError("Token has expired");
	await db(env)
		.update(emailTokens)
		.set({ consumedAt: Date.now() })
		.where(eq(emailTokens.id, row.id));
	return {
		userId: row.userId,
		purpose: row.purpose as TokenPurpose,
	};
}

export class TokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TokenError";
	}
}
