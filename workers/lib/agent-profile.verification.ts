// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for the AgentProfile foundation (Phase 2).
 *
 * This file is intentionally NOT imported by production code. It exists so
 * that `tsc -b` exercises the AgentProfile resolution surface against
 * representative fixtures. There are no runtime side effects: no top-level
 * I/O, no network calls, no Cloudflare bindings touched. All checks are
 * either type-level (`Expect<Equal<...>>`) or expressed as inert exported
 * functions that only run if a caller invokes them.
 */
import {
	DEFAULT_AGENT_PROFILE_ID,
	type InboxProfile,
} from "./inbox-profile";
import {
	DEFAULT_EMAIL_AGENT_MODEL_ID,
	DEFAULT_EMAIL_AGENT_PROFILE,
	DEFAULT_EMAIL_AGENT_PROFILE_ID,
	DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT,
	resolveAgentProfile,
	type AgentAutomationPolicy,
	type AgentProfile,
} from "./agent-profile";
import type { Env } from "../types";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

// --- Type-level invariants -------------------------------------------------

// The AgentProfile id reuses the InboxProfile default constant so the two
// modules can never disagree about the canonical default profile id.
type _DefaultIdsAligned = Expect<
	Equal<typeof DEFAULT_EMAIL_AGENT_PROFILE_ID, typeof DEFAULT_AGENT_PROFILE_ID>
>;

// AgentProfile shape is what the agent runtime depends on; pin the field
// list at compile time so accidental field removals fail tsc here.
type _AgentProfileShape = Expect<
	Equal<
		keyof AgentProfile,
		| "id"
		| "displayName"
		| "description"
		| "systemPrompt"
		| "modelId"
		| "automation"
		| "enabledToolIds"
	>
>;

type _AutomationShape = Expect<
	Equal<keyof AgentAutomationPolicy, "inboundAutoDraftEnabled">
>;

// --- Inert fixture builders ------------------------------------------------

const FIXTURE_MAILBOX = "verify@example.com";

function makeBaseInbox(overrides: Partial<InboxProfile> = {}): InboxProfile {
	return {
		id: FIXTURE_MAILBOX,
		canonicalAddress: FIXTURE_MAILBOX,
		displayName: FIXTURE_MAILBOX,
		lifecycleStatus: "active",
		storageMailboxId: FIXTURE_MAILBOX,
		agentProfileId: DEFAULT_EMAIL_AGENT_PROFILE_ID,
		enabledToolIds: [],
		settings: {},
		...overrides,
	};
}

// `Env` is a Cloudflare-typed binding bag; the verification never reads
// from it. A typed cast keeps tsc satisfied without constructing real
// bindings (which would require a runtime Cloudflare context).
const FAKE_ENV = {} as unknown as Env;

// --- Case 1: default InboxProfile resolves to default AgentProfile values --

export function verifyDefaultInboxResolvesToDefaultProfile(): AgentProfile {
	const inbox = makeBaseInbox();
	const profile = resolveAgentProfile(FAKE_ENV, inbox);

	// Type-level: resolved profile is structurally an AgentProfile.
	type _IsAgentProfile = Expect<Equal<typeof profile, AgentProfile>>;

	// Value-level identity checks (only run if this function is called).
	if (profile.id !== DEFAULT_EMAIL_AGENT_PROFILE.id) {
		throw new Error("default profile id drift");
	}
	if (profile.systemPrompt !== DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT) {
		throw new Error("default systemPrompt drift");
	}
	if (profile.modelId !== DEFAULT_EMAIL_AGENT_MODEL_ID) {
		throw new Error("default modelId drift");
	}
	if (profile.automation.inboundAutoDraftEnabled !== true) {
		throw new Error("default automation drift");
	}
	return profile;
}

// --- Case 2: legacy `settings.agentSystemPrompt` override is accepted ------

const LEGACY_PROMPT_FIXTURE: InboxProfile = makeBaseInbox({
	settings: {
		agentSystemPrompt: "You are a strictly polite assistant.",
	},
});

export function verifyLegacyPromptOverride(): AgentProfile {
	const profile = resolveAgentProfile(FAKE_ENV, LEGACY_PROMPT_FIXTURE);
	if (profile.systemPrompt !== "You are a strictly polite assistant.") {
		throw new Error("legacy agentSystemPrompt was not honored");
	}
	// Legacy override should not change identity/model.
	if (profile.id !== DEFAULT_EMAIL_AGENT_PROFILE.id) {
		throw new Error("legacy override should not change id");
	}
	if (profile.modelId !== DEFAULT_EMAIL_AGENT_MODEL_ID) {
		throw new Error("legacy override should not change modelId");
	}
	return profile;
}

// --- Case 3 & 4: custom profile shape under settings.agentProfiles[id] -----

const CUSTOM_PROFILE_ID = "concierge";

const CUSTOM_PROFILE_FIXTURE: InboxProfile = makeBaseInbox({
	agentProfileId: CUSTOM_PROFILE_ID,
	settings: {
		agentProfiles: {
			[CUSTOM_PROFILE_ID]: {
				displayName: "Concierge",
				description: "White-glove inbox concierge.",
				systemPrompt: "Reply with concierge-level care.",
				modelId: "@cf/example/custom-model",
				automation: { inboundAutoDraftEnabled: false },
				enabledToolIds: ["draft_reply"],
			},
		},
	},
});

export function verifyCustomProfileShapeAndSelection(): AgentProfile {
	const profile = resolveAgentProfile(FAKE_ENV, CUSTOM_PROFILE_FIXTURE);

	// Case 4: custom id chosen via InboxProfile.agentProfileId.
	if (profile.id !== CUSTOM_PROFILE_ID) {
		throw new Error("custom profile id was not selected");
	}
	// Case 3: custom profile shape is accepted end-to-end.
	if (profile.displayName !== "Concierge") {
		throw new Error("custom displayName was not accepted");
	}
	if (profile.systemPrompt !== "Reply with concierge-level care.") {
		throw new Error("custom systemPrompt was not accepted");
	}
	if (profile.modelId !== "@cf/example/custom-model") {
		throw new Error("custom modelId was not accepted");
	}
	if (profile.automation.inboundAutoDraftEnabled !== false) {
		throw new Error("custom automation was not accepted");
	}
	if (
		profile.enabledToolIds.length !== 1 ||
		profile.enabledToolIds[0] !== "draft_reply"
	) {
		throw new Error("custom enabledToolIds was not accepted");
	}
	return profile;
}

// Touch the type aliases so `tsc` keeps them in the dependency graph and
// reports any future shape regressions through this file.
export type AgentProfileVerificationCases = {
	defaultMatchesDefault: _DefaultIdsAligned;
	agentProfileShape: _AgentProfileShape;
	automationShape: _AutomationShape;
};
