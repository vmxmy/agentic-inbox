// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import type { RequestIdentity } from "./request-identity";

function normalizeEmail(value: string): string | null {
	const email = value.trim().toLowerCase();
	if (!email || email.length > 254) return null;
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
	return email;
}

export function configuredAdminEmails(env: Env): Set<string> {
	const raw = String(env.ADMINS || "");
	return new Set(
		raw
			.split(",")
			.map((value) => normalizeEmail(value))
			.filter((value): value is string => Boolean(value)),
	);
}

export function isAdminIdentity(
	env: Env,
	identity: RequestIdentity | null | undefined,
): boolean {
	const email = identity ? normalizeEmail(identity.email) : null;
	if (!email) return false;
	return configuredAdminEmails(env).has(email);
}
