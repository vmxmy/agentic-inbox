// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for the inbox agent configuration helpers
 * (Phase 2 product control plane). Mirrors the pattern used by
 * agent-profile.verification.ts: no runtime side effects, no I/O. The
 * exported functions only run when explicitly invoked, but the file is
 * picked up by `tsc -b` so any drift in shapes or behavior surfaces here.
 */
import {
	DEFAULT_AGENT_PROFILE_ID,
	type InboxProfile,
} from "./inbox-profile";
import {
	DEFAULT_EMAIL_AGENT_PROFILE_ID,
	DEFAULT_EMAIL_AGENT_MODEL_ID,
	DEFAULT_EMAIL_AGENT_PROFILE,
	DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT,
	resolveAgentProfile,
} from "./agent-profile";
import { getAvailableToolCapabilities } from "./tool-capabilities";
import {
	applyInboxAgentConfigUpdate,
	buildInboxAgentConfigOptions,
	checkStructuredConfigEligibility,
	DEFAULT_AGENT_SAFETY_POLICY,
	INBOX_AGENT_CONFIG_SCHEMA_VERSION,
	INBOX_LOCKED_TOOL_IDS,
	resolveSafetyPolicy,
	validateInboxAgentConfigPatch,
	type AgentSafetyPolicy,
	type InboxAgentConfigOptions,
	type InboxAgentConfigPatchInput,
} from "./inbox-agent-config";
import type { Env } from "../types";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

// Schema version is a literal `1` so writes always agree with reads.
type _SchemaVersionLiteral = Expect<
	Equal<typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION, 1>
>;

// Safety policy keeps a stable shape - pinning at compile time guards
// against accidental field drift from runtime resolvers.
type _SafetyShape = Expect<
	Equal<
		keyof AgentSafetyPolicy,
		| "version"
		| "promptInjectionScanEnabled"
		| "threadContextScanEnabled"
		| "draftVerificationEnabled"
		| "safetyModelId"
		| "level"
	>
>;

// Default agent profile id stays aligned with the inbox profile default.
type _ProfileIdAligned = Expect<
	Equal<typeof DEFAULT_EMAIL_AGENT_PROFILE_ID, typeof DEFAULT_AGENT_PROFILE_ID>
>;

// --- Inert fixture builders ------------------------------------------------

const FIXTURE_OWNER = "owner@example.com";
const FIXTURE_INBOX = "owner.support@example.com";

function makeOwnedInboxSettings(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		fromName: "Support Inbox",
		userOwnedInbox: {
			version: 1,
			ownerEmail: FIXTURE_OWNER,
			username: "owner",
			subname: "support",
			rootDomain: "example.com",
			address: FIXTURE_INBOX,
		},
		inboxProfile: {
			version: 1,
			canonicalAddress: FIXTURE_INBOX,
			displayName: "Support Inbox",
			lifecycleStatus: "active",
			storageMailboxId: FIXTURE_INBOX,
			agentProfileId: DEFAULT_EMAIL_AGENT_PROFILE_ID,
			enabledToolIds: [],
		},
		...extra,
	};
}

const FAKE_ENV = {} as unknown as Env;

/**
 * Mirror what `loadInboxProfile` would produce after persisting `settings`
 * to R2: read the server-owned inbox profile fields out of `settings` so
 * downstream resolvers see the same shape they would in production.
 */
function inboxProfileFromSettings(
	settings: Record<string, unknown>,
): InboxProfile {
	const ip =
		(settings.inboxProfile && typeof settings.inboxProfile === "object"
			? (settings.inboxProfile as Record<string, unknown>)
			: {}) ?? {};
	const enabledToolIds = Array.isArray(ip.enabledToolIds)
		? (ip.enabledToolIds as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: [];
	return {
		id: FIXTURE_INBOX,
		canonicalAddress: FIXTURE_INBOX,
		displayName:
			typeof ip.displayName === "string" && ip.displayName.length > 0
				? ip.displayName
				: "Support Inbox",
		lifecycleStatus: "active",
		storageMailboxId: FIXTURE_INBOX,
		agentProfileId:
			typeof ip.agentProfileId === "string" && ip.agentProfileId.length > 0
				? ip.agentProfileId
				: DEFAULT_EMAIL_AGENT_PROFILE_ID,
		enabledToolIds,
		settings,
	};
}

function makeInbox(
	settings: Record<string, unknown>,
	overrides: Partial<InboxProfile> = {},
): InboxProfile {
	return {
		id: FIXTURE_INBOX,
		canonicalAddress: FIXTURE_INBOX,
		displayName: "Support Inbox",
		lifecycleStatus: "active",
		storageMailboxId: FIXTURE_INBOX,
		agentProfileId: DEFAULT_EMAIL_AGENT_PROFILE_ID,
		enabledToolIds: [],
		settings,
		...overrides,
	};
}

// --- Case 1: backend options shape and locked tool ids ----------------------

export function verifyOptionsExposesLockedTools(): InboxAgentConfigOptions {
	const opts = buildInboxAgentConfigOptions();
	if (opts.schemaVersion !== INBOX_AGENT_CONFIG_SCHEMA_VERSION) {
		throw new Error("options schemaVersion drift");
	}
	if (opts.defaultModelId !== DEFAULT_EMAIL_AGENT_MODEL_ID) {
		throw new Error("default model drift");
	}
	if (opts.defaults.agentDisplayName !== DEFAULT_EMAIL_AGENT_PROFILE.displayName) {
		throw new Error("agent display-name default drift");
	}
	if (opts.defaults.systemPrompt !== DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT) {
		throw new Error("system-prompt default drift");
	}
	if (!opts.lockedToolIds.includes("send_email")) {
		throw new Error("send_email must remain locked");
	}
	if (!opts.lockedToolIds.includes("send_reply")) {
		throw new Error("send_reply must remain locked");
	}
	const drafts = opts.tools.find((t) => t.id === "draft_reply");
	if (!drafts || !drafts.editable) {
		throw new Error("draft_reply must be editable");
	}
	const sendEmailEntry = opts.tools.find((t) => t.id === "send_email");
	if (sendEmailEntry && sendEmailEntry.editable) {
		throw new Error("send_email must not be editable");
	}
	if (!INBOX_LOCKED_TOOL_IDS.has("send_email")) {
		throw new Error("send_email must be in the locked set");
	}
	return opts;
}

export function verifyOptionsFollowDeploymentDefaultModel(): true {
	const opts = buildInboxAgentConfigOptions({
		LLM_BASE_URL: "https://llm.example.com",
		LLM_DEFAULT_MODEL: "glm-5.1",
	} as never);
	if (opts.defaultModelId !== "glm-5.1") {
		throw new Error("options should expose deployment default model");
	}
	const validation = validateInboxAgentConfigPatch(
		{
			schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
			expectedRevision: "abc",
			agent: { modelId: "glm-5.1" },
		},
		{
			LLM_BASE_URL: "https://llm.example.com",
			LLM_DEFAULT_MODEL: "glm-5.1",
		} as never,
	);
	if (!validation.ok) {
		throw new Error("deployment default model should validate");
	}
	return true;
}

// --- Case 2: safety policy resolver is safe-on by default -------------------

export function verifySafetyResolverDefaultsToSafeOn(): AgentSafetyPolicy {
	const inbox = makeInbox(makeOwnedInboxSettings());
	const safety = resolveSafetyPolicy(inbox);
	if (!safety.promptInjectionScanEnabled) {
		throw new Error("prompt-injection scan must default to on");
	}
	if (!safety.threadContextScanEnabled) {
		throw new Error("thread-context scan must default to on");
	}
	if (!safety.draftVerificationEnabled) {
		throw new Error("draft verification must default to on");
	}
	if (safety.level !== DEFAULT_AGENT_SAFETY_POLICY.level) {
		throw new Error("safety level default drift");
	}
	return safety;
}

// --- Case 3: validation rejects locked tools and unsupported models ---------

export function verifyValidationRejectsLockedTools(): true {
	const result = validateInboxAgentConfigPatch({
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "abc",
		tools: { enabledToolIds: ["draft_reply", "send_email"] },
	});
	if (result.ok) {
		throw new Error("send_email must be rejected by validator");
	}
	const codes = result.errors.map((e) => e.code);
	if (!codes.includes("tool_locked")) {
		throw new Error("validator must report tool_locked code");
	}
	return true;
}

export function verifyValidationRejectsUnsupportedModel(): true {
	const result = validateInboxAgentConfigPatch({
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "abc",
		agent: { modelId: "not-a-real-model" },
	});
	if (result.ok) {
		throw new Error("unsupported model must be rejected");
	}
	if (!result.errors.some((e) => e.code === "unsupported_model")) {
		throw new Error("validator must report unsupported_model code");
	}
	return true;
}

export function verifyValidationRejectsFreeTextSafetyModel(): true {
	const result = validateInboxAgentConfigPatch({
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "abc",
		safety: { safetyModelId: "unapproved-safety-model" },
	});
	if (result.ok) {
		throw new Error("free-text safety model must be rejected");
	}
	if (!result.errors.some((e) => e.code === "unsupported_safety_model")) {
		throw new Error("validator must report unsupported_safety_model code");
	}
	return true;
}

// --- Case 4: ownership / phase guard ----------------------------------------

export function verifyOwnershipGuardRejectsLegacyMailboxes(): true {
	const legacy = checkStructuredConfigEligibility({}, FIXTURE_OWNER);
	if (legacy.ok) throw new Error("legacy mailbox must be rejected");
	if (legacy.code !== "legacy_mailbox") {
		throw new Error("expected legacy_mailbox code");
	}

	const owned = checkStructuredConfigEligibility(
		makeOwnedInboxSettings(),
		FIXTURE_OWNER,
	);
	if (!owned.ok) throw new Error("owner must be allowed for own inbox");

	const otherOwner = checkStructuredConfigEligibility(
		makeOwnedInboxSettings(),
		"someone-else@example.com",
	);
	if (otherOwner.ok || otherOwner.code !== "not_owner") {
		throw new Error("non-owner must be rejected");
	}
	return true;
}

// --- Case 5: applyInboxAgentConfigUpdate writes structured fields ----------

export async function verifyApplyMergesStructuredConfig(): Promise<true> {
	const settings = makeOwnedInboxSettings({
		agentSystemPrompt: "legacy override",
	});
	const patch: InboxAgentConfigPatchInput = {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "old-revision",
		agent: {
			displayName: "Reimbursements Bot",
			systemPrompt: "Be concise.",
			modelId: DEFAULT_EMAIL_AGENT_MODEL_ID,
			automation: { inboundAutoDraftEnabled: false },
		},
		tools: { enabledToolIds: ["draft_reply", "get_email"] },
		safety: { level: "strict", promptInjectionScanEnabled: true },
	};
	const result = await applyInboxAgentConfigUpdate(
		FIXTURE_INBOX,
		settings,
		patch,
	);
	const profiles = result.settings.agentProfiles as Record<
		string,
		Record<string, unknown>
	>;
	const profile = profiles[DEFAULT_EMAIL_AGENT_PROFILE_ID];
	if (!profile) throw new Error("default profile must be written");
	if (profile.systemPrompt !== "Be concise.") {
		throw new Error("system prompt must be persisted");
	}
	if ((result.settings.fromName as string) !== "Reimbursements Bot") {
		throw new Error("display name must sync to fromName");
	}
	if ("agentSystemPrompt" in result.settings) {
		throw new Error(
			"legacy agentSystemPrompt must be cleared when structured prompt is written",
		);
	}
	const safety = result.settings.agentSafety as AgentSafetyPolicy;
	if (safety.level !== "strict") {
		throw new Error("safety level must be persisted");
	}
	if (!result.changedFields.includes("agent.systemPrompt")) {
		throw new Error("changedFields must record system prompt change");
	}
	return true;
}

// --- Case 6: saved inboundAutoDraftEnabled=false flows to AgentProfile ------
// Backs tasks 3.7 and 5.7: writing a config patch must produce settings that,
// when re-resolved into an AgentProfile (the path EmailAgent.handleNewEmail
// takes per call), surface the disabled automation flag. EmailAgent already
// short-circuits on `!agent.automation.inboundAutoDraftEnabled` (task 3.5).

export async function verifyDisabledAutoDraftPropagatesToAgentProfile(): Promise<true> {
	const initial = makeOwnedInboxSettings();
	const result = await applyInboxAgentConfigUpdate(FIXTURE_INBOX, initial, {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "irrelevant-for-verification",
		agent: { automation: { inboundAutoDraftEnabled: false } },
	});
	const inbox = inboxProfileFromSettings(result.settings);
	const agent = resolveAgentProfile(FAKE_ENV, inbox);
	if (agent.automation.inboundAutoDraftEnabled !== false) {
		throw new Error(
			"saved inboundAutoDraftEnabled=false must propagate to resolveAgentProfile",
		);
	}
	return true;
}

// --- Case 7: saved tool allow-list narrows the agent surface ----------------
// Backs tasks 3.2 and 5.8 (agent side): createAgentToolSet ultimately filters
// through `getAvailableToolCapabilities`, which honors the explicit list
// written by `applyInboxAgentConfigUpdate`.

export async function verifyDisabledToolPropagatesToAgentSurface(): Promise<true> {
	const initial = makeOwnedInboxSettings();
	const result = await applyInboxAgentConfigUpdate(FIXTURE_INBOX, initial, {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "irrelevant-for-verification",
		tools: { enabledToolIds: ["draft_reply", "get_email"] },
	});
	const inbox = inboxProfileFromSettings(result.settings);
	const agent = resolveAgentProfile(FAKE_ENV, inbox);
	const ids = new Set(
		getAvailableToolCapabilities(
			{ inboxProfile: inbox, agentProfile: agent },
			"agent",
		).map((t) => t.id),
	);
	if (ids.size !== 2 || !ids.has("draft_reply") || !ids.has("get_email")) {
		throw new Error(
			`saved tool allow-list did not narrow agent surface: got [${[...ids].join(",")}]`,
		);
	}
	return true;
}

// --- Case 8: saved tool allow-list narrows the MCP surface ------------------
// Backs tasks 3.2 and 5.8 (MCP side): registerMcpToolsFromRegistry routes
// every per-request execution through `resolveExecutableCapability`, which
// uses the same allow-list resolution as the agent surface.

export async function verifyDisabledToolPropagatesToMcpSurface(): Promise<true> {
	const initial = makeOwnedInboxSettings();
	const result = await applyInboxAgentConfigUpdate(FIXTURE_INBOX, initial, {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "irrelevant-for-verification",
		tools: { enabledToolIds: ["draft_reply", "get_email"] },
	});
	const inbox = inboxProfileFromSettings(result.settings);
	const agent = resolveAgentProfile(FAKE_ENV, inbox);
	const ids = new Set(
		getAvailableToolCapabilities(
			{ inboxProfile: inbox, agentProfile: agent },
			"mcp",
		).map((t) => t.id),
	);
	if (ids.size !== 2 || !ids.has("draft_reply") || !ids.has("get_email")) {
		throw new Error(
			`saved tool allow-list did not narrow MCP surface: got [${[...ids].join(",")}]`,
		);
	}
	return true;
}

// --- Case 9: each apply produces a fresh revision (effective-time) ----------
// Backs task 3.7: in-flight runs hold onto the AgentProfile they resolved at
// dispatch time; subsequent saves mint a new revision so the next dispatch
// sees the new policy. This guards against silently sharing a single
// agentConfigMeta object across writes.

export async function verifyApplyMintsFreshRevisionPerWrite(): Promise<true> {
	const initial = makeOwnedInboxSettings();
	const first = await applyInboxAgentConfigUpdate(FIXTURE_INBOX, initial, {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: "irrelevant-for-verification",
		agent: { systemPrompt: "First version." },
	});
	const second = await applyInboxAgentConfigUpdate(
		FIXTURE_INBOX,
		first.settings,
		{
			schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
			expectedRevision: first.revision,
			agent: { systemPrompt: "Second version." },
		},
	);
	if (first.revision === second.revision) {
		throw new Error(
			"each saved config must mint a new revision so future runs can detect change",
		);
	}
	return true;
}
