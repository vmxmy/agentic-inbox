// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbox agent configuration helper - Phase 2 product control plane.
 *
 * Wraps the existing AgentProfile + tool-capability + safety primitives in
 * a constrained config surface that is safe to expose to user-owned-inbox
 * owners. Storage stays in R2 mailbox settings; structured writes go through
 * `applyInboxAgentConfigUpdate`, which never touches identity/routing fields.
 */

import {
	DEFAULT_EMAIL_AGENT_MODEL_ID,
	DEFAULT_EMAIL_AGENT_PROFILE,
	DEFAULT_EMAIL_AGENT_PROFILE_ID,
	DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT,
	resolveAgentProfile,
	type AgentProfile,
} from "./agent-profile";
import { type InboxProfile } from "./inbox-profile";
import { listBuiltinCapabilities, type ToolCapability } from "./tool-capabilities";
import { readUserOwnedInboxMetadata } from "./user-owned-inbox";
import type { Env } from "../types";

export const INBOX_AGENT_CONFIG_SCHEMA_VERSION = 1 as const;

const PROMPT_MAX_LENGTH = 16_000;
const DISPLAY_NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 280;

/** Backend-owned model option exposed to clients. */
export interface ModelOption {
	id: string;
	displayName: string;
	tier: "default" | "workers-ai" | "openai-compatible" | "deprecated";
	description?: string;
}

/** Tool capability metadata as exposed to clients. */
export interface ToolCatalogEntry {
	id: string;
	displayName: string;
	description: string;
	surfaces: string[];
	permissions: {
		mutates: boolean;
		sendsMail: boolean;
		global: boolean;
		readsInbox: boolean;
	};
	editable: boolean;
	lockReason?: string;
	defaultEnabled: boolean;
}

/** Per-inbox safety policy persisted under `settings.agentSafety`. */
export interface AgentSafetyPolicy {
	version: 1;
	promptInjectionScanEnabled: boolean;
	threadContextScanEnabled: boolean;
	draftVerificationEnabled: boolean;
	safetyModelId: string | null;
	level: "off" | "standard" | "strict";
}

export interface SafetyLevelOption {
	id: AgentSafetyPolicy["level"];
	displayName: string;
	description: string;
}

export interface SafetyOptions {
	defaults: AgentSafetyPolicy;
	levels: SafetyLevelOption[];
}

/** Combined options payload for the settings UI. */
export interface InboxAgentConfigOptions {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	models: ModelOption[];
	defaultModelId: string;
	tools: ToolCatalogEntry[];
	defaultEnabledToolIds: string[];
	safety: SafetyOptions;
	defaults: {
		agentDisplayName: string;
		systemPrompt: string;
		automation: AgentProfile["automation"];
	};
	lockedToolIds: string[];
}

/** Per-inbox config returned by GET /agent-config. */
export interface InboxAgentConfigResponse {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	revision: string;
	inboxId: string;
	canonicalAddress: string;
	displayName: string;
	agent: {
		profileId: string;
		displayName: string;
		description?: string;
		systemPrompt: string;
		modelId: string;
		modelDeprecated: boolean;
		automation: AgentProfile["automation"];
	};
	tools: {
		enabledToolIds: string[];
		usingDefaultPreset: boolean;
	};
	safety: AgentSafetyPolicy;
}

/** Validated PATCH body. */
export interface InboxAgentConfigPatchInput {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	expectedRevision: string;
	agent?: {
		displayName?: string;
		description?: string;
		systemPrompt?: string;
		modelId?: string;
		automation?: { inboundAutoDraftEnabled?: boolean };
	};
	tools?: { enabledToolIds?: string[] };
	safety?: Partial<AgentSafetyPolicy>;
}

export interface InboxAgentConfigValidationError {
	field: string;
	code: string;
	message: string;
}

export type InboxAgentConfigValidationResult =
	| { ok: true; patch: InboxAgentConfigPatchInput }
	| { ok: false; errors: InboxAgentConfigValidationError[] };

// -- Defaults -------------------------------------------------------

export const DEFAULT_AGENT_SAFETY_POLICY: AgentSafetyPolicy = {
	version: 1,
	promptInjectionScanEnabled: true,
	threadContextScanEnabled: true,
	draftVerificationEnabled: true,
	safetyModelId: null,
	level: "standard",
};

const SAFETY_LEVEL_OPTIONS: SafetyLevelOption[] = [
	{
		id: "off",
		displayName: "Off",
		description:
			"No prompt-injection scan or draft verification. Not recommended for inboxes that receive untrusted mail.",
	},
	{
		id: "standard",
		displayName: "Standard (recommended)",
		description:
			"Scan inbound bodies and thread context for prompt injection, and verify drafts before saving.",
	},
	{
		id: "strict",
		displayName: "Strict",
		description:
			"Standard checks plus stricter draft verification fallbacks. May skip more borderline drafts.",
	},
];

/** Phase 2 default tool preset for ordinary owners. */
const DEFAULT_USER_TOOL_PRESET: string[] = [
	"list_emails",
	"get_email",
	"get_thread",
	"search_emails",
	"draft_reply",
	"draft_email",
	"discard_draft",
	"mark_email_read",
	"move_email",
];

/** Phase 2 locked tool ids. Send-mail tools must remain server-rejected. */
const LOCKED_TOOL_IDS = new Set<string>(["send_email", "send_reply"]);

const LOCK_REASON_PHASE2_DRAFTS_ONLY = "drafts_only_in_phase2";

/** Backend-owned model allowlist. */
const MODEL_OPTIONS: ModelOption[] = [
	{
		id: DEFAULT_EMAIL_AGENT_MODEL_ID,
		displayName: "Kimi K2.5 (Workers AI)",
		tier: "default",
		description:
			"Default Workers AI model. Good balance of quality and latency.",
	},
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		displayName: "Llama 3.3 70B Fast (Workers AI)",
		tier: "workers-ai",
		description: "Larger Llama 3.3 model with faster inference variant.",
	},
];

type LlmConfigEnv = Env & {
	LLM_BASE_URL?: string;
	LLM_DEFAULT_MODEL?: string;
};

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function buildModelOptions(env?: Env): ModelOption[] {
	const llmEnv = env as LlmConfigEnv | undefined;
	const baseUrl = readNonEmptyString(llmEnv?.LLM_BASE_URL);
	const defaultModel = readNonEmptyString(llmEnv?.LLM_DEFAULT_MODEL);
	if (baseUrl && defaultModel) {
		return [
			{
				id: defaultModel,
				displayName: `Deployment default (${defaultModel})`,
				tier: "default",
				description:
					"Default OpenAI-compatible model configured for this deployment.",
			},
		];
	}
	return MODEL_OPTIONS;
}

function modelOptionIds(env?: Env): Set<string> {
	return new Set(buildModelOptions(env).map((m) => m.id));
}

function defaultConfigModelId(env?: Env): string {
	return buildModelOptions(env)[0]?.id ?? DEFAULT_EMAIL_AGENT_MODEL_ID;
}

function effectiveConfigModelId(env: Env, modelId: string): string {
	const llmEnv = env as LlmConfigEnv;
	const defaultModel = readNonEmptyString(llmEnv.LLM_DEFAULT_MODEL);
	if (
		readNonEmptyString(llmEnv.LLM_BASE_URL) &&
		defaultModel &&
		modelId === DEFAULT_EMAIL_AGENT_MODEL_ID
	) {
		return defaultModel;
	}
	return modelId;
}

// -- Settings reader/writer -----------------------------------------

interface AgentConfigMeta {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	revision: string;
	updatedAt: string;
}

function readAgentConfigMeta(
	settings: Record<string, unknown>,
): AgentConfigMeta | null {
	const meta = settings.agentConfigMeta;
	if (!meta || typeof meta !== "object") return null;
	const m = meta as Record<string, unknown>;
	if (m.schemaVersion !== INBOX_AGENT_CONFIG_SCHEMA_VERSION) return null;
	if (typeof m.revision !== "string" || m.revision.length === 0) return null;
	const updatedAt =
		typeof m.updatedAt === "string" ? m.updatedAt : new Date(0).toISOString();
	return {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		revision: m.revision,
		updatedAt,
	};
}

function readSafetyPolicy(
	settings: Record<string, unknown>,
): AgentSafetyPolicy {
	const raw = settings.agentSafety;
	if (!raw || typeof raw !== "object") return DEFAULT_AGENT_SAFETY_POLICY;
	const r = raw as Record<string, unknown>;
	const level: AgentSafetyPolicy["level"] =
		r.level === "off" || r.level === "strict" || r.level === "standard"
			? r.level
			: DEFAULT_AGENT_SAFETY_POLICY.level;
	return {
		version: 1,
		promptInjectionScanEnabled:
			typeof r.promptInjectionScanEnabled === "boolean"
				? r.promptInjectionScanEnabled
				: DEFAULT_AGENT_SAFETY_POLICY.promptInjectionScanEnabled,
		threadContextScanEnabled:
			typeof r.threadContextScanEnabled === "boolean"
				? r.threadContextScanEnabled
				: DEFAULT_AGENT_SAFETY_POLICY.threadContextScanEnabled,
		draftVerificationEnabled:
			typeof r.draftVerificationEnabled === "boolean"
				? r.draftVerificationEnabled
				: DEFAULT_AGENT_SAFETY_POLICY.draftVerificationEnabled,
		safetyModelId:
			typeof r.safetyModelId === "string" && r.safetyModelId.length > 0
				? r.safetyModelId
				: null,
		level,
	};
}

/** Resolve the runtime safety policy for an inbox. Safe-on by default. */
export function resolveSafetyPolicy(
	inbox: InboxProfile | null,
): AgentSafetyPolicy {
	if (!inbox) return DEFAULT_AGENT_SAFETY_POLICY;
	return readSafetyPolicy(inbox.settings ?? {});
}

// -- Tool catalog ---------------------------------------------------

function describeCapability(cap: ToolCapability): ToolCatalogEntry {
	const locked = LOCKED_TOOL_IDS.has(cap.id);
	const editable = !locked && cap.surfaces.includes("agent");
	const defaultEnabled = DEFAULT_USER_TOOL_PRESET.includes(cap.id);
	return {
		id: cap.id,
		displayName: cap.displayName,
		description: cap.description,
		surfaces: [...cap.surfaces],
		permissions: {
			mutates: cap.permissions.mutates,
			sendsMail: cap.permissions.sendsMail,
			global: Boolean(cap.permissions.global),
			readsInbox: !cap.permissions.global,
		},
		editable,
		lockReason: locked ? LOCK_REASON_PHASE2_DRAFTS_ONLY : undefined,
		defaultEnabled,
	};
}

/** Tool catalog scoped to inbox configuration. Excludes purely global capabilities. */
function buildInboxToolCatalog(): ToolCatalogEntry[] {
	return listBuiltinCapabilities()
		.filter((cap) => cap.surfaces.includes("agent") || cap.surfaces.includes("mcp"))
		.filter((cap) => !cap.permissions.global)
		.map(describeCapability);
}

// -- Options endpoint payload ---------------------------------------

export function buildInboxAgentConfigOptions(env?: Env): InboxAgentConfigOptions {
	const tools = buildInboxToolCatalog();
	const models = buildModelOptions(env);
	return {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		models,
		defaultModelId: defaultConfigModelId(env),
		tools,
		defaultEnabledToolIds: [...DEFAULT_USER_TOOL_PRESET],
		safety: {
			defaults: DEFAULT_AGENT_SAFETY_POLICY,
			levels: SAFETY_LEVEL_OPTIONS,
		},
		defaults: {
			agentDisplayName: DEFAULT_EMAIL_AGENT_PROFILE.displayName,
			systemPrompt: DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT,
			automation: DEFAULT_EMAIL_AGENT_PROFILE.automation,
		},
		lockedToolIds: [...LOCKED_TOOL_IDS],
	};
}

// -- Revision computation -------------------------------------------

function configFingerprintSource(
	agent: AgentProfile,
	enabledToolIds: string[],
	safety: AgentSafetyPolicy,
	displayName: string,
): string {
	return JSON.stringify({
		displayName,
		agent: {
			id: agent.id,
			displayName: agent.displayName,
			description: agent.description ?? "",
			systemPrompt: agent.systemPrompt,
			modelId: agent.modelId,
			automation: agent.automation,
		},
		tools: enabledToolIds.slice().sort(),
		safety,
	});
}

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let out = "";
	for (let i = 0; i < bytes.length; i += 1) {
		out += bytes[i].toString(16).padStart(2, "0");
	}
	return out.slice(0, 32);
}

async function computeRevision(
	settings: Record<string, unknown>,
	agent: AgentProfile,
	enabledToolIds: string[],
	safety: AgentSafetyPolicy,
	displayName: string,
): Promise<string> {
	const stored = readAgentConfigMeta(settings);
	if (stored) return stored.revision;
	const source = configFingerprintSource(
		agent,
		enabledToolIds,
		safety,
		displayName,
	);
	return sha256Hex(source);
}

// -- Build response -------------------------------------------------

function effectiveEnabledToolIds(
	inbox: InboxProfile,
	agent: AgentProfile,
): { ids: string[]; usingDefaultPreset: boolean } {
	if (hasExplicitAgentToolPolicy(inbox.settings)) {
		return { ids: [...agent.enabledToolIds], usingDefaultPreset: false };
	}
	const inboxIds = inbox.enabledToolIds ?? [];
	const agentIds = agent.enabledToolIds ?? [];
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const id of [...inboxIds, ...agentIds]) {
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push(id);
	}
	if (merged.length > 0) return { ids: merged, usingDefaultPreset: false };
	return { ids: [...DEFAULT_USER_TOOL_PRESET], usingDefaultPreset: true };
}

export async function buildInboxAgentConfigResponse(
	env: Env,
	inbox: InboxProfile,
): Promise<InboxAgentConfigResponse> {
	const settings = inbox.settings ?? {};
	const agent = resolveAgentProfile(env, inbox);
	const safety = readSafetyPolicy(settings);
	const { ids: enabledToolIds, usingDefaultPreset } = effectiveEnabledToolIds(
		inbox,
		agent,
	);

	const responseModelId = effectiveConfigModelId(env, agent.modelId);
	const modelDeprecated = !modelOptionIds(env).has(responseModelId);
	const revision = await computeRevision(
		settings,
		agent,
		enabledToolIds,
		safety,
		inbox.displayName,
	);

	return {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		revision,
		inboxId: inbox.canonicalAddress,
		canonicalAddress: inbox.canonicalAddress,
		displayName: inbox.displayName,
		agent: {
			profileId: agent.id,
			displayName: agent.displayName,
			description: agent.description,
			systemPrompt: agent.systemPrompt,
			modelId: responseModelId,
			modelDeprecated,
			automation: agent.automation,
		},
		tools: { enabledToolIds, usingDefaultPreset },
		safety,
	};
}

// -- Patch validation -----------------------------------------------

function validationError(
	errors: InboxAgentConfigValidationError[],
	field: string,
	code: string,
	message: string,
) {
	errors.push({ field, code, message });
}

export function validateInboxAgentConfigPatch(
	body: unknown,
	env?: Env,
): InboxAgentConfigValidationResult {
	const errors: InboxAgentConfigValidationError[] = [];

	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return {
			ok: false,
			errors: [
				{
					field: "",
					code: "invalid_body",
					message: "Request body must be an object.",
				},
			],
		};
	}
	const b = body as Record<string, unknown>;

	if (b.schemaVersion !== INBOX_AGENT_CONFIG_SCHEMA_VERSION) {
		validationError(
			errors,
			"schemaVersion",
			"invalid_schema_version",
			`schemaVersion must be ${INBOX_AGENT_CONFIG_SCHEMA_VERSION}.`,
		);
	}
	if (typeof b.expectedRevision !== "string" || b.expectedRevision.length === 0) {
		validationError(
			errors,
			"expectedRevision",
			"missing_revision",
			"expectedRevision is required.",
		);
	}

	const patch: InboxAgentConfigPatchInput = {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		expectedRevision: typeof b.expectedRevision === "string" ? b.expectedRevision : "",
	};

	if (b.agent !== undefined) {
		if (!b.agent || typeof b.agent !== "object") {
			validationError(errors, "agent", "invalid_agent", "agent must be an object.");
		} else {
			const a = b.agent as Record<string, unknown>;
			const agentPatch: NonNullable<InboxAgentConfigPatchInput["agent"]> = {};
			if (a.displayName !== undefined) {
				if (typeof a.displayName !== "string") {
					validationError(errors, "agent.displayName", "invalid_type", "displayName must be a string.");
				} else {
					const trimmed = a.displayName.trim();
					if (trimmed.length === 0) {
						validationError(errors, "agent.displayName", "empty", "displayName cannot be empty.");
					} else if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
						validationError(errors, "agent.displayName", "too_long", `displayName must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`);
					} else {
						agentPatch.displayName = trimmed;
					}
				}
			}
			if (a.description !== undefined) {
				if (typeof a.description !== "string") {
					validationError(errors, "agent.description", "invalid_type", "description must be a string.");
				} else if (a.description.length > DESCRIPTION_MAX_LENGTH) {
					validationError(errors, "agent.description", "too_long", `description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.`);
				} else {
					agentPatch.description = a.description;
				}
			}
			if (a.systemPrompt !== undefined) {
				if (typeof a.systemPrompt !== "string") {
					validationError(errors, "agent.systemPrompt", "invalid_type", "systemPrompt must be a string.");
				} else if (a.systemPrompt.length > PROMPT_MAX_LENGTH) {
					validationError(errors, "agent.systemPrompt", "too_long", `systemPrompt must be ${PROMPT_MAX_LENGTH} characters or fewer.`);
				} else {
					agentPatch.systemPrompt = a.systemPrompt;
				}
			}
			if (a.modelId !== undefined) {
				if (typeof a.modelId !== "string" || a.modelId.length === 0) {
					validationError(errors, "agent.modelId", "invalid_type", "modelId must be a non-empty string.");
				} else if (!modelOptionIds(env).has(a.modelId)) {
					validationError(errors, "agent.modelId", "unsupported_model", `Model '${a.modelId}' is not in the supported model list.`);
				} else {
					agentPatch.modelId = a.modelId;
				}
			}
			if (a.automation !== undefined) {
				if (!a.automation || typeof a.automation !== "object") {
					validationError(errors, "agent.automation", "invalid_type", "automation must be an object.");
				} else {
					const auto = a.automation as Record<string, unknown>;
					const automationPatch: { inboundAutoDraftEnabled?: boolean } = {};
					if (auto.inboundAutoDraftEnabled !== undefined) {
						if (typeof auto.inboundAutoDraftEnabled !== "boolean") {
							validationError(errors, "agent.automation.inboundAutoDraftEnabled", "invalid_type", "inboundAutoDraftEnabled must be a boolean.");
						} else {
							automationPatch.inboundAutoDraftEnabled = auto.inboundAutoDraftEnabled;
						}
					}
					if (Object.keys(automationPatch).length > 0) {
						agentPatch.automation = automationPatch;
					}
				}
			}
			if (Object.keys(agentPatch).length > 0) patch.agent = agentPatch;
		}
	}

	if (b.tools !== undefined) {
		if (!b.tools || typeof b.tools !== "object") {
			validationError(errors, "tools", "invalid_type", "tools must be an object.");
		} else {
			const t = b.tools as Record<string, unknown>;
			if (t.enabledToolIds !== undefined) {
				if (!Array.isArray(t.enabledToolIds) || !t.enabledToolIds.every((v) => typeof v === "string")) {
					validationError(errors, "tools.enabledToolIds", "invalid_type", "enabledToolIds must be an array of strings.");
				} else {
					const ids = t.enabledToolIds as string[];
					const catalog = buildInboxToolCatalog();
					const known = new Map(catalog.map((c) => [c.id, c]));
					const cleaned: string[] = [];
					for (const id of ids) {
						const cap = known.get(id);
						if (!cap) {
							validationError(errors, "tools.enabledToolIds", "unknown_tool", `Tool '${id}' is not registered.`);
							continue;
						}
						if (!cap.editable) {
							validationError(errors, "tools.enabledToolIds", "tool_locked", `Tool '${id}' is not editable for ordinary users (${cap.lockReason ?? "locked"}).`);
							continue;
						}
						if (!cleaned.includes(id)) cleaned.push(id);
					}
					patch.tools = { enabledToolIds: cleaned };
				}
			}
		}
	}

	if (b.safety !== undefined) {
		if (!b.safety || typeof b.safety !== "object") {
			validationError(errors, "safety", "invalid_type", "safety must be an object.");
		} else {
			const s = b.safety as Record<string, unknown>;
			const safetyPatch: Partial<AgentSafetyPolicy> = {};
			for (const key of [
				"promptInjectionScanEnabled",
				"threadContextScanEnabled",
				"draftVerificationEnabled",
			] as const) {
				if (s[key] !== undefined) {
					if (typeof s[key] !== "boolean") {
						validationError(errors, `safety.${key}`, "invalid_type", `${key} must be a boolean.`);
					} else {
						safetyPatch[key] = s[key] as boolean;
					}
				}
			}
			if (s.level !== undefined) {
				if (s.level !== "off" && s.level !== "standard" && s.level !== "strict") {
					validationError(errors, "safety.level", "invalid_level", "level must be 'off', 'standard', or 'strict'.");
				} else {
					safetyPatch.level = s.level;
				}
			}
			if (s.safetyModelId !== undefined) {
				if (s.safetyModelId !== null && typeof s.safetyModelId !== "string") {
					validationError(errors, "safety.safetyModelId", "invalid_type", "safetyModelId must be a string or null.");
				} else if (typeof s.safetyModelId === "string" && s.safetyModelId.length > 0) {
					validationError(errors, "safety.safetyModelId", "unsupported_safety_model", "Per-inbox safety model selection is not editable in this phase.");
				} else {
					safetyPatch.safetyModelId = null;
				}
			}
			if (Object.keys(safetyPatch).length > 0) {
				patch.safety = safetyPatch;
			}
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, patch };
}

// -- Apply patch ----------------------------------------------------

export interface ApplyConfigUpdateResult {
	settings: Record<string, unknown>;
	revision: string;
	changedFields: string[];
}

/**
 * Merge a validated patch into existing R2 mailbox settings without
 * touching server-owned routing fields. Caller MUST verify revision and
 * ownership before calling.
 */
export async function applyInboxAgentConfigUpdate(
	mailboxId: string,
	settings: Record<string, unknown>,
	patch: InboxAgentConfigPatchInput,
): Promise<ApplyConfigUpdateResult> {
	const next: Record<string, unknown> = { ...settings };
	const changedFields: string[] = [];

	const profileId = DEFAULT_EMAIL_AGENT_PROFILE_ID;
	const existingProfilesRaw = next.agentProfiles;
	const profiles =
		existingProfilesRaw && typeof existingProfilesRaw === "object" && !Array.isArray(existingProfilesRaw)
			? { ...(existingProfilesRaw as Record<string, unknown>) }
			: {};
	const existingProfileEntry = profiles[profileId];
	const existingProfile =
		existingProfileEntry && typeof existingProfileEntry === "object"
			? { ...(existingProfileEntry as Record<string, unknown>) }
			: ({} as Record<string, unknown>);

	if (patch.agent) {
		const a = patch.agent;
		const profile: Record<string, unknown> = {
			...existingProfile,
			id: profileId,
		};
		if (a.displayName !== undefined) {
			profile.displayName = a.displayName;
			next.fromName = a.displayName;
			changedFields.push("agent.displayName");
		}
		if (a.description !== undefined) {
			profile.description = a.description;
			changedFields.push("agent.description");
		}
		if (a.systemPrompt !== undefined) {
			profile.systemPrompt = a.systemPrompt;
			changedFields.push("agent.systemPrompt");
			delete next.agentSystemPrompt;
		}
		if (a.modelId !== undefined) {
			profile.modelId = a.modelId;
			changedFields.push("agent.modelId");
		}
		if (a.automation !== undefined) {
			const existingAuto =
				profile.automation && typeof profile.automation === "object"
					? (profile.automation as Record<string, unknown>)
					: {};
			profile.automation = { ...existingAuto, ...a.automation };
			changedFields.push("agent.automation");
		}
		profiles[profileId] = profile;
		next.agentProfiles = profiles;
	}

	if (patch.tools?.enabledToolIds !== undefined) {
		const ids = patch.tools.enabledToolIds;
		const inboxProfile =
			next.inboxProfile && typeof next.inboxProfile === "object"
				? { ...(next.inboxProfile as Record<string, unknown>) }
				: undefined;
		if (inboxProfile) {
			inboxProfile.enabledToolIds = [...ids];
			next.inboxProfile = inboxProfile;
		}
		const profile =
			profiles[profileId] && typeof profiles[profileId] === "object"
				? { ...(profiles[profileId] as Record<string, unknown>) }
				: ({ id: profileId } as Record<string, unknown>);
		profile.enabledToolIds = [...ids];
		profiles[profileId] = profile;
		next.agentProfiles = profiles;
		changedFields.push("tools.enabledToolIds");
	}

	if (patch.safety && Object.keys(patch.safety).length > 0) {
		const existingSafety = readSafetyPolicy(settings);
		const merged: AgentSafetyPolicy = {
			...existingSafety,
			...patch.safety,
			version: 1,
		};
		next.agentSafety = merged;
		changedFields.push("safety");
	}

	const revision = await mintRevision(mailboxId);
	next.agentConfigMeta = {
		schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
		revision,
		updatedAt: new Date().toISOString(),
	};

	return { settings: next, revision, changedFields };
}

async function mintRevision(mailboxId: string): Promise<string> {
	const seed = `${mailboxId}|${Date.now()}|${crypto.randomUUID()}`;
	return sha256Hex(seed);
}

// -- Audit log ------------------------------------------------------

export interface InboxAgentConfigAuditEntry {
	version: 1;
	type: "inbox_agent_config_change";
	timestamp: string;
	actorEmail: string | null;
	canonicalAddress: string;
	storageMailboxId: string;
	changedFields: string[];
	previousRevision: string | null;
	nextRevision: string;
	summary: Record<string, { from?: string; to?: string }>;
}

const AUDIT_PREFIX = "audit/inbox-config/";

function redactValue(value: unknown): string {
	if (value === undefined || value === null) return "(unset)";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		if (value.length === 0) return "(empty)";
		if (value.length <= 32) return value;
		return `${value.slice(0, 24)}...(len=${value.length})`;
	}
	if (Array.isArray(value)) return `array(len=${value.length})`;
	return "object";
}

function buildAuditSummary(
	previous: Record<string, unknown>,
	next: Record<string, unknown>,
	changedFields: string[],
): InboxAgentConfigAuditEntry["summary"] {
	const summary: InboxAgentConfigAuditEntry["summary"] = {};
	const prevAgent = readAgentProfileEntry(previous);
	const nextAgent = readAgentProfileEntry(next);
	const prevSafety = readSafetyPolicy(previous);
	const nextSafety = readSafetyPolicy(next);
	const prevTools = readEnabledToolIds(previous);
	const nextTools = readEnabledToolIds(next);

	for (const field of changedFields) {
		switch (field) {
			case "agent.displayName":
				summary[field] = {
					from: redactValue(prevAgent?.displayName),
					to: redactValue(nextAgent?.displayName),
				};
				break;
			case "agent.description":
				summary[field] = {
					from: redactValue(prevAgent?.description),
					to: redactValue(nextAgent?.description),
				};
				break;
			case "agent.systemPrompt":
				summary[field] = {
					from: redactValue(prevAgent?.systemPrompt),
					to: redactValue(nextAgent?.systemPrompt),
				};
				break;
			case "agent.modelId":
				summary[field] = {
					from: redactValue(prevAgent?.modelId),
					to: redactValue(nextAgent?.modelId),
				};
				break;
			case "agent.automation":
				summary[field] = {
					from: redactValue(prevAgent?.automation),
					to: redactValue(nextAgent?.automation),
				};
				break;
			case "tools.enabledToolIds":
				summary[field] = {
					from: redactValue(prevTools),
					to: redactValue(nextTools),
				};
				break;
			case "safety":
				summary[field] = {
					from: redactValue(prevSafety),
					to: redactValue(nextSafety),
				};
				break;
			default:
				summary[field] = { from: "(redacted)", to: "(redacted)" };
		}
	}
	return summary;
}

function readAgentProfileEntry(
	settings: Record<string, unknown>,
): Record<string, unknown> | null {
	const profiles = settings.agentProfiles;
	if (!profiles || typeof profiles !== "object") return null;
	const entry = (profiles as Record<string, unknown>)[
		DEFAULT_EMAIL_AGENT_PROFILE_ID
	];
	if (!entry || typeof entry !== "object") return null;
	return entry as Record<string, unknown>;
}

function hasExplicitAgentToolPolicy(
	settings: Record<string, unknown>,
): boolean {
	const profile = readAgentProfileEntry(settings);
	return Boolean(
		profile &&
			Object.prototype.hasOwnProperty.call(profile, "enabledToolIds") &&
			Array.isArray(profile.enabledToolIds),
	);
}

function readEnabledToolIds(settings: Record<string, unknown>): string[] {
	const profile = readAgentProfileEntry(settings);
	if (profile && Array.isArray(profile.enabledToolIds)) {
		return (profile.enabledToolIds as unknown[]).filter(
			(v): v is string => typeof v === "string",
		);
	}
	const inbox = settings.inboxProfile;
	if (inbox && typeof inbox === "object") {
		const ids = (inbox as Record<string, unknown>).enabledToolIds;
		if (Array.isArray(ids)) {
			return ids.filter((v): v is string => typeof v === "string");
		}
	}
	return [];
}

export interface AppendAuditLogInput {
	env: Env;
	mailboxId: string;
	canonicalAddress: string;
	storageMailboxId: string;
	actorEmail: string | null;
	previousSettings: Record<string, unknown>;
	nextSettings: Record<string, unknown>;
	previousRevision: string | null;
	nextRevision: string;
	changedFields: string[];
}

export async function appendInboxAgentConfigAudit(
	input: AppendAuditLogInput,
): Promise<void> {
	if (input.changedFields.length === 0) return;
	const entry: InboxAgentConfigAuditEntry = {
		version: 1,
		type: "inbox_agent_config_change",
		timestamp: new Date().toISOString(),
		actorEmail: input.actorEmail,
		canonicalAddress: input.canonicalAddress,
		storageMailboxId: input.storageMailboxId,
		changedFields: input.changedFields,
		previousRevision: input.previousRevision,
		nextRevision: input.nextRevision,
		summary: buildAuditSummary(
			input.previousSettings,
			input.nextSettings,
			input.changedFields,
		),
	};
	const safeAddress = encodeURIComponent(input.canonicalAddress);
	const id = crypto.randomUUID().slice(0, 8);
	const key = `${AUDIT_PREFIX}${safeAddress}/${entry.timestamp}-${id}.json`;
	try {
		await input.env.BUCKET.put(key, JSON.stringify(entry));
	} catch (e) {
		console.warn("Failed to append inbox agent config audit:", (e as Error).message);
	}
}

// -- Ownership / phase guard ----------------------------------------

export type StructuredConfigEligibility =
	| { ok: true }
	| { ok: false; code: "legacy_mailbox" | "not_owner"; message: string };

export function checkStructuredConfigEligibility(
	settings: Record<string, unknown>,
	actorEmail: string | null,
): StructuredConfigEligibility {
	const userOwned = readUserOwnedInboxMetadata(settings);
	if (!userOwned) {
		return {
			ok: false,
			code: "legacy_mailbox",
			message:
				"Structured Agent/Tools/Safety configuration is only available for user-owned inboxes in this phase.",
		};
	}
	if (!actorEmail || actorEmail.toLowerCase() !== userOwned.ownerEmail.toLowerCase()) {
		return {
			ok: false,
			code: "not_owner",
			message: "Not authorized to view or change this inbox configuration.",
		};
	}
	return { ok: true };
}

// -- Re-exports used by runtime gating ------------------------------

export {
	DEFAULT_USER_TOOL_PRESET as DEFAULT_USER_TOOL_PRESET_IDS,
	LOCKED_TOOL_IDS as INBOX_LOCKED_TOOL_IDS,
};
