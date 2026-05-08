// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-level Agent configuration.
 *
 * The agent-config slice (autoDraft, system prompts, model overrides,
 * enabled-skill allowlists) lives in the per-mailbox MailboxDO
 * `mailbox_settings` table. Reads and writes both route through the
 * DO. The legacy R2 settings blob is no longer consulted — by the time PR 8
 * lands, PR 5/6's lazy-backfill has run for at least one production cycle and
 * `mailbox_settings` is the sole authoritative source.
 *
 * Rules continue to load through `rules-store.loadRulesForEvaluation`
 * (D1-backed, with its own one-shot R2 backfill).
 */
import type { Env } from "../types";
import type { Rule } from "./rules";
import { loadRulesForEvaluation } from "./rules-store";
import { getMailboxStub } from "./email-helpers";
import type {
	MailboxSettingsPatch,
	MailboxSettingsRow,
} from "../durableObject";

/**
 * Model id is no longer constrained to a hardcoded enum — the runtime catalog
 * is fetched dynamically from `${LLM_BASE_URL}/v1/models` (see
 * `workers/lib/llm-models.ts`). The constants below are kept only as a safety
 * net for the rare case where the model fetch fails AND the mailbox has no
 * model pinned; in production both `LLM_DEFAULT_MODEL` (env var) and the
 * runtime catalog cover that path.
 */
export const FALLBACK_AGENT_MODEL = "glm-5.1";

/** Legacy alias for callers that still import this. Prefer `LlmModel.id` from
 *  `./llm-models` for live data. */
export type AgentModel = string;

export const DEFAULT_AGENT_MODEL: AgentModel = FALLBACK_AGENT_MODEL;

export interface AgentConfig {
	autoDraft: boolean;
	/** Legacy shared-model field. Kept for back-compat reads of mailboxes
	 *  written before per-agent overrides existed; the per-agent fields below
	 *  fall back to this value when null. New writes target the per-agent
	 *  fields and stop writing this one. */
	model: string;
	/** Per-agent override for the EmailAgent. `null` = use the legacy `model`
	 *  field, then env default. */
	emailReplyModel: string | null;
	customSystemPrompt: string | null;
	rules: Rule[];
	/** Capability ids the EmailAgent is permitted to invoke as tools. `null`
	 *  means "use the agent's default allowlist" — preserves pre-Capability
	 *  behaviour for mailboxes that haven't opted into per-skill toggles. */
	emailReplyEnabledSkills: readonly string[] | null;
}

function coerceModel(raw: unknown, env: Env): AgentModel {
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	return env.LLM_DEFAULT_MODEL?.trim() || DEFAULT_AGENT_MODEL;
}

function coerceOptionalModel(raw: unknown): string | null {
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	return null;
}

/**
 * Coerce a settings field into a Capability id allowlist. Returns `null`
 * (meaning "default allowlist") if the field is absent or not an array.
 * Filters non-string entries silently and dedupes; an empty array survives
 * as `[]` (the user explicitly disabled all skills).
 */
function coerceSkills(raw: unknown): readonly string[] | null {
	if (!Array.isArray(raw)) return null;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		if (seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

export async function getAgentConfig(env: Env, mailboxId: string): Promise<AgentConfig> {
	const stub = getMailboxStub(env, mailboxId);
	// Rules load through their own DO-backed path; pass null so the helper
	// does not touch the R2 settings blob just to read rules.
	const rules = await loadRulesForEvaluation(env, mailboxId, null);

	let doRow: MailboxSettingsRow | null = null;
	try {
		doRow = await stub.getMailboxSettings();
	} catch {
		doRow = null;
	}
	if (doRow) return buildAgentConfigFromDoRow(doRow, rules, env);
	return { ...defaults(env), rules };
}

// ── DO ↔ AgentConfig adapters ──────────────────────────────────────

function buildAgentConfigFromDoRow(
	row: MailboxSettingsRow,
	rules: Rule[],
	env: Env,
): AgentConfig {
	return {
		// Default TRUE for backward compatibility with mailboxes that
		// pre-date the flag (auto_draft NULL → unset → true).
		autoDraft: row.autoDraft !== false,
		model: coerceModel(row.agentModel, env),
		emailReplyModel: coerceOptionalModel(row.emailReplyModel),
		customSystemPrompt:
			typeof row.agentSystemPrompt === "string" && row.agentSystemPrompt.trim()
				? row.agentSystemPrompt
				: null,
		rules,
		emailReplyEnabledSkills: coerceSkills(row.emailReplyEnabledSkills),
	};
}

/**
 * Settings keys that live in the MailboxDO `mailbox_settings` row. Worker
 * entrypoints (HTTP `PUT /api/v1/mailboxes/:id`, MCP `update_mailbox_settings`)
 * split these off any client-supplied payload and route them through
 * `updateMailboxSettings` instead of the legacy R2 settings blob.
 */
export const AGENT_CONFIG_FIELDS = [
	"autoDraft",
	"agentModel",
	"emailReplyModel",
	"agentSystemPrompt",
	"emailReplyEnabledSkills",
] as const;

export type AgentConfigField = (typeof AGENT_CONFIG_FIELDS)[number];

/**
 * Translate a loose key/value object (from a settings PUT payload, MCP tool
 * input, etc.) into a {@link MailboxSettingsPatch}. Only keys present in
 * `raw` populate the patch — missing fields stay `undefined` so the DO's
 * read-modify-write leaves them untouched. String models are trimmed and
 * coalesce to `null` when blank; arrays are filtered to strings.
 */
export function agentSettingsPatchFromRaw(
	raw: Record<string, unknown>,
): MailboxSettingsPatch {
	const patch: MailboxSettingsPatch = {};
	if ("autoDraft" in raw) {
		patch.autoDraft =
			raw.autoDraft === true || raw.autoDraft === false
				? (raw.autoDraft as boolean)
				: null;
	}
	if ("agentModel" in raw) {
		patch.agentModel =
			typeof raw.agentModel === "string" && raw.agentModel.trim()
				? raw.agentModel.trim()
				: null;
	}
	if ("emailReplyModel" in raw) {
		patch.emailReplyModel =
			typeof raw.emailReplyModel === "string" && raw.emailReplyModel.trim()
				? raw.emailReplyModel.trim()
				: null;
	}
	if ("agentSystemPrompt" in raw) {
		patch.agentSystemPrompt =
			typeof raw.agentSystemPrompt === "string" ? raw.agentSystemPrompt : null;
	}
	if ("emailReplyEnabledSkills" in raw) {
		patch.emailReplyEnabledSkills = Array.isArray(raw.emailReplyEnabledSkills)
			? raw.emailReplyEnabledSkills.filter((s): s is string => typeof s === "string")
			: null;
	}
	return patch;
}

/**
 * Project a DO settings row into the flat settings shape the UI and MCP
 * clients expect: agent-config columns + the opaque non-agent JSON object.
 * Null DO columns are omitted so the payload does not advertise a value the
 * user never set. Non-agent fields (fromName / forwarding / signature /
 * autoReply / etc.) come straight from the JSON column.
 */
export function mailboxSettingsRowToR2Shape(
	row: MailboxSettingsRow,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...(row.nonAgentSettings ?? {}) };
	if (row.autoDraft !== null) out.autoDraft = row.autoDraft;
	if (row.agentModel !== null) out.agentModel = row.agentModel;
	if (row.emailReplyModel !== null) out.emailReplyModel = row.emailReplyModel;
	if (row.agentSystemPrompt !== null) out.agentSystemPrompt = row.agentSystemPrompt;
	if (row.emailReplyEnabledSkills !== null) {
		out.emailReplyEnabledSkills = [...row.emailReplyEnabledSkills];
	}
	return out;
}

/**
 * Pick the non-agent UI fields out of a flat settings PUT payload. Agent
 * config fields and server-managed ACL keys (owner / members) are filtered
 * out — what remains is the opaque JSON object that goes into the
 * `non_agent_settings_json` column. Forward-compatible: any future UI-only
 * field added to the settings PUT body comes through unchanged.
 */
export function nonAgentSettingsFromRaw(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if ((AGENT_CONFIG_FIELDS as readonly string[]).includes(k)) continue;
		if (k === "owner" || k === "members") continue;
		out[k] = v;
	}
	return out;
}

/**
 * Fetch the MailboxDO settings row, lazy-backfilling non-agent fields from
 * the legacy R2 blob on first read after the cutover. Returns the row (or
 * null when the DO has no settings yet *and* R2 had nothing to copy).
 *
 * The backfill is one-shot per mailbox: once `non_agent_settings_json` is
 * non-null in the DO, R2 is never consulted again. Callers should treat the
 * R2 blob as legacy bytes only.
 */
export async function readUnifiedMailboxSettings(
	env: Env,
	mailboxId: string,
): Promise<MailboxSettingsRow | null> {
	const stub = getMailboxStub(env, mailboxId);
	const initial: MailboxSettingsRow | null = await readDoSettings(stub);
	if (initial && initial.nonAgentSettings !== null) return initial;

	// Either no DO row at all (un-backfilled mailbox) or the row has no
	// non-agent slice yet. Try R2 once.
	let r2: Record<string, unknown> | null = null;
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (obj) r2 = (await obj.json()) as Record<string, unknown>;
	} catch (e) {
		console.warn(
			`[agent-config] R2 read failed during non-agent backfill for "${mailboxId}":`,
			e,
		);
	}
	if (!r2) return initial;

	const nonAgent = nonAgentSettingsFromRaw(r2);
	if (Object.keys(nonAgent).length === 0) return initial;

	try {
		await stub.updateMailboxSettings({ nonAgentSettings: nonAgent });
		return await readDoSettings(stub);
	} catch (e) {
		console.warn(
			`[agent-config] DO non-agent backfill write failed for "${mailboxId}":`,
			e,
		);
	}
	return initial;
}

async function readDoSettings(
	stub: ReturnType<typeof getMailboxStub>,
): Promise<MailboxSettingsRow | null> {
	try {
		return await stub.getMailboxSettings();
	} catch {
		return null;
	}
}

function defaults(env: Env): AgentConfig {
	return {
		autoDraft: true,
		model: env.LLM_DEFAULT_MODEL?.trim() || DEFAULT_AGENT_MODEL,
		emailReplyModel: null,
		customSystemPrompt: null,
		rules: [],
		emailReplyEnabledSkills: null,
	};
}

// ── Mutation helpers ───────────────────────────────────────────────

export interface AgentConfigUpdate {
	autoDraft?: boolean;
	/** Legacy shared model override. New callers should set
	 *  `emailReplyModel` instead. */
	agentModel?: string;
	/** Per-agent model override for EmailAgent. Pass `null` to clear and fall
	 *  back to the legacy `agentModel`, then env default. */
	emailReplyModel?: string | null;
	/** Pass `null` to clear the custom prompt and fall back to the default. */
	agentSystemPrompt?: string | null;
	/** Pass `null` to clear the allowlist and fall back to the agent's default
	 *  set of skills; pass `[]` to disable all skills. */
	emailReplyEnabledSkills?: readonly string[] | null;
}

/**
 * Patch agent-config fields into the MailboxDO `mailbox_settings` row. Unknown
 * model values are rejected up-front; absent fields leave the current value
 * untouched. R2 is no longer mutated here — agent-config writes are
 * MailboxDO-owned.
 */
export async function updateAgentConfig(
	env: Env,
	mailboxId: string,
	update: AgentConfigUpdate,
): Promise<AgentConfig> {
	const stub = getMailboxStub(env, mailboxId);
	const patch: MailboxSettingsPatch = {};
	if (update.autoDraft !== undefined) patch.autoDraft = update.autoDraft;
	if (update.agentModel !== undefined) {
		const trimmed = update.agentModel.trim();
		if (!trimmed) throw new Error("agentModel must be a non-empty string");
		// No enum check — model id is validated against the live `/v1/models`
		// catalog at agent invocation time (see workers/lib/llm-models.ts).
		patch.agentModel = trimmed;
	}
	if (update.emailReplyModel !== undefined) {
		patch.emailReplyModel =
			update.emailReplyModel === null || !update.emailReplyModel.trim()
				? null
				: update.emailReplyModel.trim();
	}
	if (update.agentSystemPrompt !== undefined) {
		patch.agentSystemPrompt = update.agentSystemPrompt;
	}
	if (update.emailReplyEnabledSkills !== undefined) {
		patch.emailReplyEnabledSkills = update.emailReplyEnabledSkills;
	}
	await stub.updateMailboxSettings(patch);
	return getAgentConfig(env, mailboxId);
}
