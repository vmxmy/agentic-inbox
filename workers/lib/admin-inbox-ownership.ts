// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import {
	ensureSettingsInboxProfile,
	mailboxSettingsKey,
	normalizeInboxAddress,
} from "./inbox-profile";
import {
	USER_METADATA_VERSION,
	readUserOwnedInboxMetadata,
	type UserOwnedInboxMetadata,
} from "./user-owned-inbox";

export interface AdminInboxOwnershipSummary {
	id: string;
	email: string;
	displayName: string;
	etag: string;
	isOwned: boolean;
	userOwnedInbox: UserOwnedInboxMetadata | null;
}

export interface AssignInboxOwnerInput {
	settings: Record<string, unknown>;
	address: string;
	ownerEmail: string;
	username: string;
	subname: string;
	rootDomain: string;
}

export interface AssignInboxOwnerResult {
	settings: Record<string, unknown>;
	previousOwner: UserOwnedInboxMetadata | null;
	nextOwner: UserOwnedInboxMetadata;
	action: "assign" | "replace";
}

export interface InboxOwnershipAuditEntry {
	version: 1;
	type: "inbox_owner_assignment";
	action: "assign" | "replace";
	timestamp: string;
	adminEmail: string;
	inboxAddress: string;
	previousOwnerEmail: string | null;
	nextOwnerEmail: string;
	nextUsername: string;
	nextSubname: string;
	rootDomain: string;
}

const AUDIT_PREFIX = "audit/inbox-ownership/";

export function isLegacyInboxSettings(settings: Record<string, unknown>): boolean {
	return readUserOwnedInboxMetadata(settings) === null;
}

export function assignInboxOwnerMetadata(
	input: AssignInboxOwnerInput,
): AssignInboxOwnerResult {
	const address = normalizeInboxAddress(input.address);
	const previousOwner = readUserOwnedInboxMetadata(input.settings);
	const nextOwner: UserOwnedInboxMetadata = {
		version: USER_METADATA_VERSION,
		ownerEmail: input.ownerEmail.trim().toLowerCase(),
		username: input.username,
		subname: input.subname,
		rootDomain: input.rootDomain.trim().toLowerCase(),
		address,
	};
	const next: Record<string, unknown> = {
		...input.settings,
		owner: nextOwner.ownerEmail,
		userOwnedInbox: nextOwner,
	};
	const settings = next.inboxProfile
		? next
		: ensureSettingsInboxProfile(address, next);
	return {
		settings,
		previousOwner,
		nextOwner,
		action: previousOwner ? "replace" : "assign",
	};
}

export async function listAdminInboxOwnershipSummaries(
	env: Env,
	includeOwned: boolean,
): Promise<AdminInboxOwnershipSummary[]> {
	const list = await env.BUCKET.list({ prefix: "mailboxes/" });
	const summaries: AdminInboxOwnershipSummary[] = [];
	for (const listed of list.objects) {
		const id = listed.key.replace("mailboxes/", "").replace(/\.json$/, "");
		if (!id) continue;
		const obj = await env.BUCKET.get(mailboxSettingsKey(id));
		if (!obj) continue;
		const parsed = (await obj.json()) as unknown;
		const settings = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
		const userOwnedInbox = readUserOwnedInboxMetadata(settings);
		if (userOwnedInbox && !includeOwned) continue;
		const displayName = typeof settings.fromName === "string" && settings.fromName.length > 0
			? settings.fromName
			: normalizeInboxAddress(id);
		summaries.push({
			id: normalizeInboxAddress(id),
			email: normalizeInboxAddress(id),
			displayName,
			etag: obj.etag,
			isOwned: Boolean(userOwnedInbox),
			userOwnedInbox,
		});
	}
	return summaries.sort((a, b) => a.email.localeCompare(b.email));
}

export async function appendInboxOwnershipAudit(input: {
	env: Env;
	adminEmail: string;
	inboxAddress: string;
	previousOwner: UserOwnedInboxMetadata | null;
	nextOwner: UserOwnedInboxMetadata;
	action: "assign" | "replace";
}): Promise<void> {
	const entry: InboxOwnershipAuditEntry = {
		version: 1,
		type: "inbox_owner_assignment",
		action: input.action,
		timestamp: new Date().toISOString(),
		adminEmail: input.adminEmail.trim().toLowerCase(),
		inboxAddress: normalizeInboxAddress(input.inboxAddress),
		previousOwnerEmail: input.previousOwner?.ownerEmail ?? null,
		nextOwnerEmail: input.nextOwner.ownerEmail,
		nextUsername: input.nextOwner.username,
		nextSubname: input.nextOwner.subname,
		rootDomain: input.nextOwner.rootDomain,
	};
	const safeAddress = encodeURIComponent(entry.inboxAddress);
	const id = crypto.randomUUID().slice(0, 8);
	const key = `${AUDIT_PREFIX}${safeAddress}/${entry.timestamp}-${id}.json`;
	try {
		await input.env.BUCKET.put(key, JSON.stringify(entry));
	} catch (e) {
		console.warn("Failed to append inbox ownership audit:", (e as Error).message);
	}
}
