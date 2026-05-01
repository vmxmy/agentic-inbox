// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * InboxProfile adapter — resolves R2-backed mailbox settings into a
 * structured inbox profile object. Phase 1 of the inbox-agent-tool
 * framework: existing mailboxes continue to work without an
 * inboxProfile in their settings, while new mailboxes write one.
 */
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";

export type InboxLifecycleStatus = "active" | "disabled";

export const DEFAULT_AGENT_PROFILE_ID = "default-email-agent";

export interface InboxProfileSettings {
	version: 1;
	canonicalAddress: string;
	displayName: string;
	lifecycleStatus: InboxLifecycleStatus;
	storageMailboxId: string;
	agentProfileId: string;
	enabledToolIds: string[];
}

export interface InboxProfile {
	id: string;
	canonicalAddress: string;
	displayName: string;
	lifecycleStatus: InboxLifecycleStatus;
	storageMailboxId: string;
	agentProfileId: string;
	enabledToolIds: string[];
	settings: Record<string, unknown>;
}

export type InboundInboxResolutionStatus =
	| "resolved"
	| "empty_recipients"
	| "not_allowed"
	| "unknown"
	| "disabled";

export interface InboundInboxResolution {
	status: InboundInboxResolutionStatus;
	matchedAddress: string | null;
	profile: InboxProfile | null;
}

/** Lower-case + trim an inbox address for canonical use. */
export function normalizeInboxAddress(address: string): string {
	return address.trim().toLowerCase();
}

/** R2 key for a mailbox's settings document. */
export function mailboxSettingsKey(address: string): string {
	return `mailboxes/${normalizeInboxAddress(address)}.json`;
}

function isInboxProfileSettings(
	value: unknown,
): value is InboxProfileSettings {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.version === 1 &&
		typeof v.canonicalAddress === "string" &&
		typeof v.displayName === "string" &&
		(v.lifecycleStatus === "active" || v.lifecycleStatus === "disabled") &&
		typeof v.storageMailboxId === "string" &&
		typeof v.agentProfileId === "string" &&
		Array.isArray(v.enabledToolIds)
	);
}

/**
 * Build a default InboxProfile from a mailbox id and its raw settings.
 * Used when an existing mailbox has no `inboxProfile` field, so it can
 * still be resolved as a profile without rewriting R2.
 */
export function createDefaultInboxProfile(
	mailboxId: string,
	settings: Record<string, unknown> = {},
): InboxProfile {
	const canonicalAddress = normalizeInboxAddress(mailboxId);
	const displayNameRaw = typeof settings.fromName === "string" ? settings.fromName : "";
	const displayName = displayNameRaw || canonicalAddress;
	return {
		id: canonicalAddress,
		canonicalAddress,
		displayName,
		lifecycleStatus: "active",
		storageMailboxId: canonicalAddress,
		agentProfileId: DEFAULT_AGENT_PROFILE_ID,
		enabledToolIds: [],
		settings,
	};
}

/**
 * Coerce raw settings into an InboxProfile. Falls back to defaults for
 * any missing fields so legacy mailbox docs remain resolvable.
 */
export function profileFromSettings(
	mailboxId: string,
	settings: Record<string, unknown>,
): InboxProfile {
	const canonicalAddress = normalizeInboxAddress(mailboxId);
	const fallback = createDefaultInboxProfile(mailboxId, settings);
	const raw = settings.inboxProfile;
	if (!raw || typeof raw !== "object") return fallback;
	const r = raw as Record<string, unknown>;

	const lifecycleStatus: InboxLifecycleStatus =
		r.lifecycleStatus === "disabled" ? "disabled" : "active";

	return {
		id: canonicalAddress,
		canonicalAddress:
			typeof r.canonicalAddress === "string"
				? normalizeInboxAddress(r.canonicalAddress)
				: fallback.canonicalAddress,
		displayName:
			typeof r.displayName === "string" && r.displayName.length > 0
				? r.displayName
				: fallback.displayName,
		lifecycleStatus,
		storageMailboxId:
			typeof r.storageMailboxId === "string" && r.storageMailboxId.length > 0
				? r.storageMailboxId
				: fallback.storageMailboxId,
		agentProfileId:
			typeof r.agentProfileId === "string" && r.agentProfileId.length > 0
				? r.agentProfileId
				: DEFAULT_AGENT_PROFILE_ID,
		enabledToolIds: Array.isArray(r.enabledToolIds)
			? (r.enabledToolIds.filter((t) => typeof t === "string") as string[])
			: [],
		settings,
	};
}

/** Load and parse mailbox settings from R2. Returns null if missing. */
export async function loadMailboxSettings(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown> | null> {
	const obj = await env.BUCKET.get(mailboxSettingsKey(mailboxId));
	if (!obj) return null;
	const parsed = (await obj.json()) as unknown;
	if (!parsed || typeof parsed !== "object") return {};
	return parsed as Record<string, unknown>;
}

/** Resolve an InboxProfile for a mailbox id. Returns null if mailbox not found. */
export async function loadInboxProfile(
	env: Env,
	mailboxId: string,
): Promise<InboxProfile | null> {
	const settings = await loadMailboxSettings(env, mailboxId);
	if (settings === null) return null;
	return profileFromSettings(mailboxId, settings);
}

export function pickInboundRecipient(
	recipients: string[],
	allowedAddresses: string[],
): string | null {
	const normalizedRecipients = recipients
		.map(normalizeInboxAddress)
		.filter(Boolean);
	if (normalizedRecipients.length === 0) return null;

	const allowed = allowedAddresses.map(normalizeInboxAddress).filter(Boolean);
	if (allowed.length === 0) return normalizedRecipients[0];

	const allowedSet = new Set(allowed);
	return normalizedRecipients.find((addr) => allowedSet.has(addr)) ?? null;
}

function configuredDomains(env: Env): string[] {
	return String(env.DOMAINS || "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
}

function configuredEmailAddresses(env: Env): string[] {
	const value = env.EMAIL_ADDRESSES as unknown;
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === "string") {
		return value.split(",").map((address) => address.trim()).filter(Boolean);
	}
	return [];
}

function domainOf(address: string): string | null {
	const at = address.lastIndexOf("@");
	if (at < 0) return null;
	return address.slice(at + 1).toLowerCase();
}

function pickRegisteredNamespaceRecipient(env: Env, recipients: string[]): string | null {
	const normalizedRecipients = recipients
		.map(normalizeInboxAddress)
		.filter(Boolean);
	const domains = configuredDomains(env);
	if (domains.length === 0) return normalizedRecipients[0] ?? null;
	const domainSet = new Set(domains);
	return (
		normalizedRecipients.find((address) => {
			const domain = domainOf(address);
			return domain ? domainSet.has(domain) : false;
		}) ?? null
	);
}

/**
 * Resolve an inbound recipient to an existing active InboxProfile before
 * storage or automation. Unknown recipients are deliberately not created.
 */
export async function resolveInboundInboxProfile(
	env: Env,
	recipients: string[],
): Promise<InboundInboxResolution> {
	const allowedAddresses = configuredEmailAddresses(env);
	const matchedAddress = allowedAddresses.length > 0
		? pickInboundRecipient(recipients, allowedAddresses)
		: pickRegisteredNamespaceRecipient(env, recipients);
	if (!matchedAddress) {
		return {
			status: recipients.length === 0 ? "empty_recipients" : "not_allowed",
			matchedAddress: null,
			profile: null,
		};
	}

	const profile = await loadInboxProfile(env, matchedAddress);
	if (!profile) {
		return { status: "unknown", matchedAddress, profile: null };
	}
	if (profile.lifecycleStatus === "disabled") {
		return { status: "disabled", matchedAddress, profile: null };
	}

	return { status: "resolved", matchedAddress, profile };
}

/** List InboxProfiles for every mailbox doc in R2. */
export async function listInboxProfiles(env: Env): Promise<InboxProfile[]> {
	const list = await env.BUCKET.list({ prefix: "mailboxes/" });
	const results: InboxProfile[] = [];
	for (const obj of list.objects) {
		const id = obj.key.replace("mailboxes/", "").replace(/\.json$/, "");
		if (!id) continue;
		const settings = await loadMailboxSettings(env, id);
		if (settings === null) continue;
		results.push(profileFromSettings(id, settings));
	}
	return results;
}

/** Resolve a MailboxDO stub for a given InboxProfile via storageMailboxId. */
export function getMailboxStubForInbox(
	env: Env,
	profile: InboxProfile,
): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX;
	const id = ns.idFromName(profile.storageMailboxId);
	return ns.get(id);
}

/**
 * Build a server-owned inbox profile.
 *
 * Identity and routing fields (canonicalAddress, lifecycleStatus,
 * storageMailboxId, agentProfileId, enabledToolIds) come from
 * `existingProfile` when present, otherwise are derived from `mailboxId`.
 * The incoming `settings` payload is NEVER trusted for these fields — the
 * raw `settings.inboxProfile` block, if any, is intentionally ignored
 * here so external callers cannot redirect or corrupt inbox identity.
 *
 * Only `displayName` is allowed to sync from user-visible inputs:
 * prefer `settings.fromName`, fall back to existing displayName, then
 * canonical address.
 */
export function buildServerOwnedInboxProfile(
	mailboxId: string,
	settings: Record<string, unknown>,
	existingProfile?: Record<string, unknown>,
): InboxProfileSettings {
	const canonicalAddress = normalizeInboxAddress(mailboxId);
	const ex = existingProfile && typeof existingProfile === "object"
		? existingProfile
		: undefined;

	const fromName = typeof settings.fromName === "string" ? settings.fromName : "";
	const existingDisplayName =
		ex && typeof ex.displayName === "string" && ex.displayName.length > 0
			? ex.displayName
			: "";
	const displayName = fromName || existingDisplayName || canonicalAddress;

	const serverCanonical =
		ex && typeof ex.canonicalAddress === "string" && ex.canonicalAddress.length > 0
			? normalizeInboxAddress(ex.canonicalAddress)
			: canonicalAddress;

	const lifecycleStatus: InboxLifecycleStatus =
		ex && ex.lifecycleStatus === "disabled" ? "disabled" : "active";

	const storageMailboxId =
		ex &&
		typeof ex.storageMailboxId === "string" &&
		ex.storageMailboxId.length > 0
			? ex.storageMailboxId
			: canonicalAddress;

	const agentProfileId =
		ex &&
		typeof ex.agentProfileId === "string" &&
		ex.agentProfileId.length > 0
			? ex.agentProfileId
			: DEFAULT_AGENT_PROFILE_ID;

	const enabledToolIds =
		ex && Array.isArray(ex.enabledToolIds)
			? (ex.enabledToolIds.filter((t) => typeof t === "string") as string[])
			: [];

	const built: InboxProfileSettings = {
		version: 1,
		canonicalAddress: serverCanonical,
		displayName,
		lifecycleStatus,
		storageMailboxId,
		agentProfileId,
		enabledToolIds,
	};

	if (!isInboxProfileSettings(built)) {
		return {
			version: 1,
			canonicalAddress,
			displayName: displayName || canonicalAddress,
			lifecycleStatus: "active",
			storageMailboxId: canonicalAddress,
			agentProfileId: DEFAULT_AGENT_PROFILE_ID,
			enabledToolIds: [],
		};
	}
	return built;
}

/**
 * On mailbox CREATE: build a server-owned inbox profile from the
 * mailbox id and user-visible settings (fromName). Any incoming
 * `settings.inboxProfile` block is intentionally discarded — external
 * callers must not be able to set canonicalAddress, storageMailboxId,
 * agentProfileId, lifecycleStatus, or enabledToolIds at creation time.
 */
export function ensureSettingsInboxProfile(
	mailboxId: string,
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const inboxProfile = buildServerOwnedInboxProfile(mailboxId, settings, undefined);
	return { ...settings, inboxProfile };
}

/**
 * On mailbox UPDATE: merge an incoming settings payload with existing
 * settings while protecting server-owned inbox identity/routing fields.
 *
 * - If incoming omits `inboxProfile`, server-owned identity/routing fields
 *   from the existing profile are preserved exactly. `displayName` is
 *   synchronized from `settings.fromName` when it is a non-empty string,
 *   so existing UIs that update the display name via `fromName` alone
 *   keep `inboxProfile.displayName` in sync.
 * - If incoming includes `inboxProfile`, its identity/routing fields are
 *   ignored. Server-owned fields are taken from the existing profile when
 *   present, otherwise derived from `mailboxId`. Only `displayName` may
 *   sync from `settings.fromName`.
 */
export function mergeSettingsPreservingInboxProfile(
	existing: Record<string, unknown>,
	incoming: Record<string, unknown>,
	mailboxId: string,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...incoming };
	const existingProfile =
		existing.inboxProfile && typeof existing.inboxProfile === "object"
			? (existing.inboxProfile as Record<string, unknown>)
			: undefined;

	const incomingHasProfile =
		"inboxProfile" in incoming && incoming.inboxProfile != null;

	if (!incomingHasProfile) {
		if (existingProfile) {
			const incomingFromName =
				typeof merged.fromName === "string" ? merged.fromName : "";
			merged.inboxProfile = incomingFromName
				? { ...existingProfile, displayName: incomingFromName }
				: existingProfile;
			return merged;
		}
		merged.inboxProfile = buildServerOwnedInboxProfile(
			mailboxId,
			merged,
			undefined,
		);
		return merged;
	}

	merged.inboxProfile = buildServerOwnedInboxProfile(
		mailboxId,
		merged,
		existingProfile,
	);
	return merged;
}
