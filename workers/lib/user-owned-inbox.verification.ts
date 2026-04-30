// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for user-owned AI inbox helpers. The exported
 * scenarios are inert unless called, but `tsc -b` keeps the surfaces checked.
 */
import type { Env } from "../types";
import { mailboxSettingsKey } from "./inbox-profile";
import {
	buildUserOwnedInboxSettings,
	deriveUserOwnedInboxAddress,
	deriveUsernameBaseFromEmail,
	ensureUserMetadata,
	readUserOwnedInboxMetadata,
	userMetadataKey,
	usernameIndexKey,
	validateInboxSubname,
	type UserMetadata,
	type UserOwnedInboxMetadata,
} from "./user-owned-inbox";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

type _UserMetadataShape = Expect<
	Equal<keyof UserMetadata, "version" | "email" | "username" | "createdAt" | "updatedAt">
>;

type _UserOwnedMetadataShape = Expect<
	Equal<keyof UserOwnedInboxMetadata, "version" | "ownerEmail" | "username" | "subname" | "rootDomain" | "address">
>;

// --- Inert fixtures --------------------------------------------------------

function makeEnv(records: Record<string, unknown> = {}): Env {
	return {
		DOMAINS: "example.com",
		BUCKET: {
			get: async (key: string) => {
				const value = records[key];
				if (!value) return null;
				return { json: async () => value };
			},
			head: async (key: string) => (records[key] ? ({ key }) : null),
			put: async (key: string, value: string) => {
				records[key] = JSON.parse(value) as unknown;
				return null;
			},
		},
	} as unknown as Env;
}

// --- Case 1: username base generation -------------------------------------

export function verifyUsernameBaseGeneration(): void {
	if (deriveUsernameBaseFromEmail("Alice.Work+test@example.com") !== "alice-work") {
		throw new Error("username base should derive from normalized email local part");
	}
	if (deriveUsernameBaseFromEmail("admin@example.com") !== "user-admin") {
		throw new Error("reserved username base should be prefixed");
	}
}

// --- Case 2: username remains stable --------------------------------------

export async function verifyUsernameStability(): Promise<void> {
	const env = makeEnv();
	const first = await ensureUserMetadata(env, "alice@example.com");
	const second = await ensureUserMetadata(env, "alice@example.com");
	if (first.username !== second.username) {
		throw new Error("stored username should remain stable");
	}
}

// --- Case 3: username collision receives suffix ---------------------------

export async function verifyUsernameCollisionSuffix(): Promise<void> {
	const env = makeEnv({
		[usernameIndexKey("alice")]: { version: 1, username: "alice", email: "other@example.com" },
	});
	const user = await ensureUserMetadata(env, "alice@example.com");
	if (user.username !== "alice-2") {
		throw new Error("username collision should receive numeric suffix");
	}
}

// --- Case 4: subname validation -------------------------------------------

export function verifySubnameValidation(): void {
	const valid = validateInboxSubname("Reimburse");
	if (!valid.ok || valid.subname !== "reimburse") {
		throw new Error("valid subname should normalize to lowercase");
	}
	if (validateInboxSubname("-bad").ok) {
		throw new Error("leading hyphen should be rejected");
	}
	if (validateInboxSubname("bad--name").ok) {
		throw new Error("repeated hyphen should be rejected");
	}
	if (validateInboxSubname("admin").ok) {
		throw new Error("reserved subname should be rejected");
	}
}

// --- Case 5: address and settings metadata --------------------------------

export function verifyDerivedAddressAndSettings(): void {
	const address = deriveUserOwnedInboxAddress("alice", "reimburse", "Example.com");
	if (address !== "alice.reimburse@example.com") {
		throw new Error("derived inbox address drift");
	}
	const settings = buildUserOwnedInboxSettings({
		address,
		displayName: "报销",
		ownerEmail: "Alice@Example.com",
		username: "alice",
		subname: "reimburse",
		rootDomain: "Example.com",
	});
	const metadata = readUserOwnedInboxMetadata(settings);
	if (!metadata || metadata.ownerEmail !== "alice@example.com") {
		throw new Error("user-owned metadata should be stored in settings");
	}
	if (!settings.inboxProfile || typeof settings.inboxProfile !== "object") {
		throw new Error("user-owned settings should include InboxProfile metadata");
	}
	if (mailboxSettingsKey(address) !== "mailboxes/alice.reimburse@example.com.json") {
		throw new Error("mailbox settings key drift");
	}
}

export type UserOwnedInboxVerificationCases = {
	userMetadataShape: _UserMetadataShape;
	userOwnedMetadataShape: _UserOwnedMetadataShape;
};
