// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Compile-only verification for admin legacy inbox ownership helpers. */
import type { Env } from "../types";
import { isAdminIdentity } from "./admin-auth";
import {
	assignInboxOwnerMetadata,
	isLegacyInboxSettings,
} from "./admin-inbox-ownership";

const ADMIN_ENV = { ADMINS: "Admin@Example.com, ops@example.com" } as unknown as Env;

export function verifyAdminIdentityMatching(): true {
	if (!isAdminIdentity(ADMIN_ENV, { email: "admin@example.com", source: "dev-header" })) {
		throw new Error("admin match should be case-insensitive");
	}
	if (isAdminIdentity(ADMIN_ENV, undefined)) {
		throw new Error("missing identity must not be admin");
	}
	if (isAdminIdentity(ADMIN_ENV, { email: "user@example.com", source: "dev-header" })) {
		throw new Error("non-admin identity must not be admin");
	}
	return true;
}

export function verifyAssignOwnerPreservesSettings(): true {
	const existing = {
		fromName: "Legacy Support",
		agentProfiles: { "default-email-agent": { systemPrompt: "Keep me" } },
		agentSafety: { version: 1, level: "strict" },
		forwarding: { enabled: false, email: "" },
	};
	if (!isLegacyInboxSettings(existing)) {
		throw new Error("fixture should start as legacy settings");
	}
	const result = assignInboxOwnerMetadata({
		settings: existing,
		address: "Legacy@Example.com",
		ownerEmail: "Owner@Example.com",
		username: "owner",
		subname: "legacy-support",
		rootDomain: "example.com",
	});
	if (result.action !== "assign") throw new Error("legacy fixture should assign");
	if (result.nextOwner.ownerEmail !== "owner@example.com") {
		throw new Error("owner email should be normalized");
	}
	if (result.settings.agentProfiles !== existing.agentProfiles) {
		throw new Error("agent profile config should be preserved");
	}
	if (result.settings.agentSafety !== existing.agentSafety) {
		throw new Error("agent safety config should be preserved");
	}
	if (!result.settings.inboxProfile) {
		throw new Error("assignment should ensure inbox profile exists");
	}
	return true;
}

export function verifyReplaceOwnerPreservesConfig(): true {
	const first = assignInboxOwnerMetadata({
		settings: { fromName: "Owned", agentSafety: { version: 1, level: "standard" } },
		address: "owned@example.com",
		ownerEmail: "first@example.com",
		username: "first",
		subname: "owned",
		rootDomain: "example.com",
	});
	const second = assignInboxOwnerMetadata({
		settings: first.settings,
		address: "owned@example.com",
		ownerEmail: "second@example.com",
		username: "second",
		subname: "owned",
		rootDomain: "example.com",
	});
	if (second.action !== "replace") throw new Error("owned fixture should replace");
	if (second.previousOwner?.ownerEmail !== "first@example.com") {
		throw new Error("previous owner must be preserved for audit");
	}
	if (second.settings.agentSafety !== first.settings.agentSafety) {
		throw new Error("replacement must preserve agent safety config");
	}
	return true;
}
