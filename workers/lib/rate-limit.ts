// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Fixed-window rate limiter backed by D1.
 *
 * Each `(key, windowStart)` row counts requests landing in `[windowStart,
 * windowStart + windowMs)`. Multiple rules can share a key with different
 * window sizes (e.g. "1 per minute AND 5 per hour"). On exceed we return
 * the seconds remaining until the most-restrictive window resets.
 *
 * D1 storage is fine for low-volume auth endpoints (magic-link, password
 * reset). For high-throughput rate limiting (request path, public API), use
 * the Cloudflare `unsafe.ratelimit` binding instead.
 */
import type { Env } from "../types";

export interface RateLimitRule {
	/** Stable identity, e.g. `magic:email:foo@bar.com:1m`. */
	key: string;
	/** Window size in milliseconds. */
	windowMs: number;
	/** Max requests allowed in the window. */
	limit: number;
}

export class RateLimitError extends Error {
	constructor(public readonly retryAfterSeconds: number) {
		super(`Too many requests, try again in ${retryAfterSeconds}s`);
		this.name = "RateLimitError";
	}
}

/**
 * Check & increment counters for each rule. Throws RateLimitError on the
 * first rule that overflows. Best-effort cleanup of expired rows runs ~1%
 * of the time so the table stays bounded without a cron.
 */
export async function enforceRateLimits(
	env: Env,
	rules: RateLimitRule[],
): Promise<void> {
	const now = Date.now();
	for (const rule of rules) {
		const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
		const expiresAt = windowStart + rule.windowMs;
		const row = await env.DB
			.prepare(
				`INSERT INTO auth_rate_limits (key, window_start, count, expires_at)
				 VALUES (?1, ?2, 1, ?3)
				 ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
				 RETURNING count`,
			)
			.bind(rule.key, windowStart, expiresAt)
			.first<{ count: number }>();
		const count = row?.count ?? 1;
		if (count > rule.limit) {
			const retryMs = expiresAt - now;
			throw new RateLimitError(Math.max(1, Math.ceil(retryMs / 1000)));
		}
	}
	if (Math.random() < 0.01) {
		await env.DB
			.prepare(`DELETE FROM auth_rate_limits WHERE expires_at < ?1`)
			.bind(now)
			.run()
			.catch(() => {});
	}
}
