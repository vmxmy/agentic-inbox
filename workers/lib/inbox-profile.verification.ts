// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for InboxProfile defaulting and inbound
 * recipient resolution. This file is intentionally not imported by
 * production code; `tsc -b` keeps the exported scenarios type-checked.
 */
import {
	DEFAULT_AGENT_PROFILE_ID,
	createDefaultInboxProfile,
	mailboxSettingsKey,
	pickInboundRecipient,
	resolveInboundInboxProfile,
	type InboxProfile,
	type InboundInboxResolution,
} from "./inbox-profile";
import type { Env } from "../types";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

type _InboundResolutionShape = Expect<
	Equal<
		keyof InboundInboxResolution,
		"status" | "matchedAddress" | "profile"
	>
>;

// --- Inert fixtures --------------------------------------------------------

const LEGACY_MAILBOX = "verify-inbox@example.com";

function makeEnv(
	records: Record<string, Record<string, unknown>>,
	emailAddresses: string[] = [],
): Env {
	return {
		EMAIL_ADDRESSES: emailAddresses,
		BUCKET: {
			get: async (key: string) => {
				const value = records[key];
				if (!value) return null;
				return { json: async () => value };
			},
		},
	} as unknown as Env;
}

// --- Case 1: legacy mailbox settings default into an InboxProfile ----------

export function verifyLegacySettingsDefaultToInboxProfile(): InboxProfile {
	const profile = createDefaultInboxProfile(LEGACY_MAILBOX, {
		fromName: "Verification Inbox",
	});

	if (profile.canonicalAddress !== LEGACY_MAILBOX) {
		throw new Error("legacy inbox canonical address default drift");
	}
	if (profile.displayName !== "Verification Inbox") {
		throw new Error("legacy inbox displayName should default from fromName");
	}
	if (profile.agentProfileId !== DEFAULT_AGENT_PROFILE_ID) {
		throw new Error("legacy inbox should use default agent profile");
	}
	if (profile.enabledToolIds.length !== 0) {
		throw new Error("legacy inbox should not narrow tools by default");
	}
	return profile;
}

// --- Case 2: allowed-address routing picks the configured recipient --------

export function verifyAllowedRecipientSelection(): string {
	const picked = pickInboundRecipient(
		["other@example.com", "Verify-Inbox@Example.com"],
		[LEGACY_MAILBOX],
	);
	if (picked !== LEGACY_MAILBOX) {
		throw new Error("allowed recipient selection did not normalize match");
	}
	return picked;
}

// --- Case 3: known inbound recipient resolves an active profile ------------

export async function verifyKnownInboundRecipientResolves(): Promise<void> {
	const env = makeEnv(
		{
			[mailboxSettingsKey(LEGACY_MAILBOX)]: {
				fromName: "Known Inbox",
			},
		},
		[LEGACY_MAILBOX],
	);

	const result = await resolveInboundInboxProfile(env, [LEGACY_MAILBOX]);
	if (result.status !== "resolved" || !result.profile) {
		throw new Error("known inbound recipient should resolve");
	}
	if (result.profile.displayName !== "Known Inbox") {
		throw new Error("known inbound profile should preserve defaults");
	}
}

// --- Case 4: unknown recipient is not implicitly created -------------------

export async function verifyUnknownInboundRecipientIsRejected(): Promise<void> {
	const env = makeEnv({}, []);
	const result = await resolveInboundInboxProfile(env, [LEGACY_MAILBOX]);
	if (result.status !== "unknown" || result.profile !== null) {
		throw new Error("unknown recipient should not auto-create profile");
	}
}

// --- Case 5: disabled inbox does not receive inbound automation ------------

export async function verifyDisabledInboundRecipientIsRejected(): Promise<void> {
	const env = makeEnv({
		[mailboxSettingsKey(LEGACY_MAILBOX)]: {
			fromName: "Disabled Inbox",
			inboxProfile: {
				version: 1,
				canonicalAddress: LEGACY_MAILBOX,
				displayName: "Disabled Inbox",
				lifecycleStatus: "disabled",
				storageMailboxId: LEGACY_MAILBOX,
				agentProfileId: DEFAULT_AGENT_PROFILE_ID,
				enabledToolIds: [],
			},
		},
	});

	const result = await resolveInboundInboxProfile(env, [LEGACY_MAILBOX]);
	if (result.status !== "disabled" || result.profile !== null) {
		throw new Error("disabled inbox should not resolve for inbound handling");
	}
}

export type InboxProfileVerificationCases = {
	inboundResolution: _InboundResolutionShape;
};
