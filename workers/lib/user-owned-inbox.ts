// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import {
	ensureSettingsInboxProfile,
	mailboxSettingsKey,
	normalizeInboxAddress,
} from "./inbox-profile";

export const USER_METADATA_VERSION = 1;
export const USER_METADATA_PREFIX = "users/";
export const USERNAME_INDEX_PREFIX = "usernames/";

export interface UserMetadata {
	version: 1;
	email: string;
	username: string;
	createdAt: string;
	updatedAt: string;
}

export interface UserOwnedInboxMetadata {
	version: 1;
	ownerEmail: string;
	username: string;
	subname: string;
	rootDomain: string;
	address: string;
}

export interface UserOwnedInboxSettingsInput {
	address: string;
	displayName: string;
	ownerEmail: string;
	username: string;
	subname: string;
	rootDomain: string;
}

export interface SubnameValidationResult {
	ok: boolean;
	subname?: string;
	code?: string;
	message?: string;
}

const RESERVED_USERNAME_WORDS = new Set([
	"admin",
	"api",
	"auth",
	"billing",
	"help",
	"inbox",
	"mail",
	"mcp",
	"postmaster",
	"root",
	"security",
	"support",
	"system",
	"www",
]);

export const RESERVED_INBOX_SUBNAMES = new Set([
	"admin",
	"api",
	"auth",
	"billing",
	"help",
	"mcp",
	"postmaster",
	"root",
	"security",
	"support",
	"system",
	"www",
]);

function encodeKeyPart(value: string): string {
	return encodeURIComponent(value.trim().toLowerCase());
}

export function userMetadataKey(email: string): string {
	return `${USER_METADATA_PREFIX}${encodeKeyPart(email)}.json`;
}

export function usernameIndexKey(username: string): string {
	return `${USERNAME_INDEX_PREFIX}${username}.json`;
}

function normalizeToken(value: string, fallback: string): string {
	const token = value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return token || fallback;
}

export function deriveUsernameBaseFromEmail(email: string): string {
	const localPart = email.trim().toLowerCase().split("@")[0] ?? "";
	const withoutPlusTag = localPart.split("+")[0] ?? localPart;
	const base = normalizeToken(withoutPlusTag, "user");
	return RESERVED_USERNAME_WORDS.has(base) ? `user-${base}`.slice(0, 32) : base;
}

function usernameWithSuffix(base: string, suffix: number): string {
	const suffixText = `-${suffix}`;
	const maxBaseLength = Math.max(1, 32 - suffixText.length);
	return `${base.slice(0, maxBaseLength).replace(/-+$/g, "")}${suffixText}`;
}

async function usernameOwner(env: Env, username: string): Promise<string | null> {
	const obj = await env.BUCKET.get(usernameIndexKey(username));
	if (!obj) return null;
	const parsed = (await obj.json()) as unknown;
	if (!parsed || typeof parsed !== "object") return null;
	const ownerEmail = (parsed as Record<string, unknown>).email;
	return typeof ownerEmail === "string" ? ownerEmail.toLowerCase() : null;
}

async function reserveUsername(env: Env, username: string, email: string): Promise<void> {
	await env.BUCKET.put(
		usernameIndexKey(username),
		JSON.stringify({ version: USER_METADATA_VERSION, username, email }),
	);
}

export async function loadUserMetadata(
	env: Env,
	email: string,
): Promise<UserMetadata | null> {
	const normalizedEmail = email.trim().toLowerCase();
	const obj = await env.BUCKET.get(userMetadataKey(normalizedEmail));
	if (!obj) return null;
	const parsed = (await obj.json()) as unknown;
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (
		record.version !== USER_METADATA_VERSION ||
		typeof record.email !== "string" ||
		typeof record.username !== "string"
	) {
		return null;
	}
	return {
		version: USER_METADATA_VERSION,
		email: record.email.toLowerCase(),
		username: record.username,
		createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
	};
}

export async function ensureUserMetadata(
	env: Env,
	email: string,
): Promise<UserMetadata> {
	const normalizedEmail = email.trim().toLowerCase();
	const existing = await loadUserMetadata(env, normalizedEmail);
	if (existing) return existing;

	const base = deriveUsernameBaseFromEmail(normalizedEmail);
	let username: string | null = null;
	for (let suffix = 1; suffix < 10000; suffix += 1) {
		const candidate = suffix === 1 ? base : usernameWithSuffix(base, suffix);
		const owner = await usernameOwner(env, candidate);
		if (!owner || owner === normalizedEmail) {
			username = candidate;
			break;
		}
	}
	if (!username) {
		throw new Error("Unable to assign a unique username");
	}

	const now = new Date().toISOString();
	const metadata: UserMetadata = {
		version: USER_METADATA_VERSION,
		email: normalizedEmail,
		username,
		createdAt: now,
		updatedAt: now,
	};
	await env.BUCKET.put(userMetadataKey(normalizedEmail), JSON.stringify(metadata));
	await reserveUsername(env, username, normalizedEmail);
	return metadata;
}

export function validateInboxSubname(value: string): SubnameValidationResult {
	const subname = value.trim().toLowerCase();
	if (subname.length < 2 || subname.length > 32) {
		return {
			ok: false,
			code: "invalid_length",
			message: "Inbox address name must be 2-32 characters.",
		};
	}
	if (RESERVED_INBOX_SUBNAMES.has(subname)) {
		return {
			ok: false,
			code: "reserved",
			message: "This inbox address name is reserved. Please choose another name.",
		};
	}
	if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(subname)) {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Inbox address name must start and end with a letter or number and use only letters, numbers, and hyphens.",
		};
	}
	if (subname.includes("--")) {
		return {
			ok: false,
			code: "repeated_hyphen",
			message: "Inbox address name cannot contain repeated hyphens.",
		};
	}
	return { ok: true, subname };
}

export function configuredRootDomains(env: Env): string[] {
	return String(env.DOMAINS || "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
}

export function defaultRootDomain(env: Env): string | null {
	return configuredRootDomains(env)[0] ?? null;
}

export function isConfiguredRootDomain(env: Env, domain: string): boolean {
	const domains = configuredRootDomains(env);
	if (domains.length === 0) return true;
	return domains.includes(domain.trim().toLowerCase());
}

export function deriveUserOwnedInboxAddress(
	username: string,
	subname: string,
	rootDomain: string,
): string {
	return normalizeInboxAddress(`${username}.${subname}@${rootDomain}`);
}

export function buildUserOwnedInboxSettings(
	input: UserOwnedInboxSettingsInput,
): Record<string, unknown> {
	const address = normalizeInboxAddress(input.address);
	const userOwnedInbox: UserOwnedInboxMetadata = {
		version: USER_METADATA_VERSION,
		ownerEmail: input.ownerEmail.trim().toLowerCase(),
		username: input.username,
		subname: input.subname,
		rootDomain: input.rootDomain.trim().toLowerCase(),
		address,
	};
	return ensureSettingsInboxProfile(address, {
		fromName: input.displayName,
		owner: userOwnedInbox.ownerEmail,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
		userOwnedInbox,
	});
}

export function readUserOwnedInboxMetadata(
	settings: Record<string, unknown>,
): UserOwnedInboxMetadata | null {
	const value = settings.userOwnedInbox;
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		record.version !== USER_METADATA_VERSION ||
		typeof record.ownerEmail !== "string" ||
		typeof record.username !== "string" ||
		typeof record.subname !== "string" ||
		typeof record.rootDomain !== "string" ||
		typeof record.address !== "string"
	) {
		return null;
	}
	return {
		version: USER_METADATA_VERSION,
		ownerEmail: record.ownerEmail.toLowerCase(),
		username: record.username,
		subname: record.subname,
		rootDomain: record.rootDomain.toLowerCase(),
		address: normalizeInboxAddress(record.address),
	};
}

export async function userOwnedInboxExists(env: Env, address: string): Promise<boolean> {
	return Boolean(await env.BUCKET.head(mailboxSettingsKey(address)));
}
