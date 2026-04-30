// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { JWTPayload } from "jose";

export const DEV_USER_HEADER = "X-Dev-User";

export interface RequestIdentity {
	email: string;
	source: "cloudflare-access" | "dev-header";
}

function normalizeEmail(value: string): string | null {
	const email = value.trim().toLowerCase();
	if (!email || email.length > 254) return null;
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
	return email;
}

function pickString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nestedEmailClaim(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	return pickString(record.email) ?? pickString(record.user_email);
}

export function extractVerifiedEmailFromAccessClaims(
	payload: JWTPayload & Record<string, unknown>,
): string | null {
	const candidates = [
		pickString(payload.email),
		pickString(payload.user_email),
		pickString(payload.preferred_username),
		nestedEmailClaim(payload.identity),
		nestedEmailClaim(payload.user),
	];

	for (const candidate of candidates) {
		if (!candidate) continue;
		const email = normalizeEmail(candidate);
		if (email) return email;
	}
	return null;
}

export function requestIdentityFromAccessClaims(
	payload: JWTPayload & Record<string, unknown>,
): RequestIdentity | null {
	const email = extractVerifiedEmailFromAccessClaims(payload);
	return email ? { email, source: "cloudflare-access" } : null;
}

export function requestIdentityFromDevUserHeader(
	value: string | null | undefined,
): RequestIdentity | null {
	if (!value) return null;
	const email = normalizeEmail(value);
	return email ? { email, source: "dev-header" } : null;
}
