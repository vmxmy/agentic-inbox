// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Helpers for the admin-managed team/user mailbox address model.
 *
 * Team primary addresses are `team@root-domain`; team-user addresses are
 * `team.user@root-domain`. The full email remains the transitional MailboxDO
 * identity for this slice.
 */

const RESERVED_SLUGS = new Set([
	"admin",
	"api",
	"auth",
	"mcp",
	"root",
	"security",
	"support",
	"system",
	"www",
]);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_SLUG_LENGTH = 2;
const MAX_SLUG_LENGTH = 40;

export class TeamAddressError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TeamAddressError";
	}
}

export interface SlugValidationResult {
	ok: boolean;
	value?: string;
	error?: string;
}

export function normalizeAddressSlug(input: string): string {
	return input.trim().toLowerCase();
}

export function validateAddressSlug(input: string): SlugValidationResult {
	const value = normalizeAddressSlug(input);
	if (value.length < MIN_SLUG_LENGTH || value.length > MAX_SLUG_LENGTH) {
		return {
			ok: false,
			error: `Name must be ${MIN_SLUG_LENGTH}-${MAX_SLUG_LENGTH} characters.`,
		};
	}
	if (!SLUG_RE.test(value)) {
		return {
			ok: false,
			error: "Name may contain only lowercase letters, numbers, and single hyphens.",
		};
	}
	if (RESERVED_SLUGS.has(value)) {
		return { ok: false, error: `"${value}" is reserved.` };
	}
	return { ok: true, value };
}

export function requireAddressSlug(input: string, label = "name"): string {
	const result = validateAddressSlug(input);
	if (!result.ok || !result.value) {
		throw new TeamAddressError(result.error ?? `Invalid ${label}.`);
	}
	return result.value;
}

export function parseRootDomains(env: { DOMAINS?: string | null }): string[] {
	return (env.DOMAINS ?? "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
}

export function getRootDomain(env: { DOMAINS?: string | null }): string {
	const [domain] = parseRootDomains(env);
	if (!domain) {
		throw new TeamAddressError("DOMAINS must contain at least one root domain.");
	}
	return domain;
}

export function deriveTeamAddress(
	teamName: string,
	env: { DOMAINS?: string | null },
): string {
	return `${requireAddressSlug(teamName, "team name")}@${getRootDomain(env)}`;
}

export function deriveTeamUserAddress(
	teamName: string,
	userName: string,
	env: { DOMAINS?: string | null },
): string {
	return `${requireAddressSlug(teamName, "team name")}.${requireAddressSlug(userName, "user name")}@${getRootDomain(env)}`;
}

export function isConfiguredRootDomain(
	address: string,
	env: { DOMAINS?: string | null },
): boolean {
	const domain = address.trim().toLowerCase().split("@")[1] ?? "";
	return parseRootDomains(env).includes(domain);
}
