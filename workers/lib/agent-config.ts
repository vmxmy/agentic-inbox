// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-level Agent configuration.
 *
 * After PR 5 + PR 6 of the first-wave architecture migration, the agent-config
 * slice (autoDraft, system prompts, model overrides, enabled-skill allowlists,
 * invoice-source domains) lives in the per-mailbox MailboxDO `mailbox_settings`
 * table. Reads go DO-first; the legacy R2 settings blob is consulted only as
 * a self-healing fallback for un-backfilled legacy mailboxes. Writes go to
 * the DO exclusively.
 *
 * Rules continue to load through `rules-store.loadRulesForEvaluation` (already
 * D1-backed, with its own R2 backfill bridge).
 */
import type { Env } from "../types";
import {
	DEFAULT_INVOICE_SOURCE_DOMAINS,
	isValidInvoiceSourceDomain,
} from "./invoice-link-scanner";
import { RulesSchema, type Rule } from "./rules";
import { loadRulesForEvaluation } from "./rules-store";
import { getMailboxStub } from "./email-helpers";
import type {
	MailboxSettingsInput,
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
	/** Per-agent override for the InvoiceAgent. Same fallback chain. */
	invoiceModel: string | null;
	customSystemPrompt: string | null;
	rules: Rule[];
	/** Per-mailbox extras appended to the built-in invoice-source whitelist.
	 *  Stored on the settings blob as `invoiceSourceDomains`. Malformed
	 *  entries are filtered out silently — tighter than an error, but still
	 *  observable because they won't show up in get_mailbox_settings. */
	invoiceSourceDomains: readonly string[];
	/** Custom system prompt for the InvoiceAgent chat surface. Null falls back
	 *  to the built-in DEFAULT_SYSTEM_PROMPT defined in
	 *  `workers/invoice-agent/index.ts`. Stored as `invoiceAgentSystemPrompt`
	 *  on the settings blob (parallel to `agentSystemPrompt` for EmailAgent). */
	invoiceAgentSystemPrompt: string | null;
	/** Capability ids the EmailAgent is permitted to invoke as tools. `null`
	 *  means "use the agent's default allowlist" — preserves pre-Capability
	 *  behaviour for mailboxes that haven't opted into per-skill toggles. */
	emailReplyEnabledSkills: readonly string[] | null;
	/** Reserved for the Phase-2 invoice-tool migration. Read but not yet
	 *  consumed by InvoiceAgent. */
	invoiceEnabledSkills: readonly string[] | null;
}

function coerceModel(raw: unknown, env: Env): AgentModel {
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	return env.LLM_DEFAULT_MODEL?.trim() || DEFAULT_AGENT_MODEL;
}

function coerceOptionalModel(raw: unknown): string | null {
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	return null;
}

function coerceInvoiceSourceDomains(raw: unknown): readonly string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of raw) {
		if (!isValidInvoiceSourceDomain(entry)) continue;
		const lower = entry.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(lower);
	}
	return out;
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

	// PR 5 read path: DO-first.
	let doRow: MailboxSettingsRow | null = null;
	try {
		doRow = await stub.getMailboxSettings();
	} catch {
		doRow = null;
	}
	if (doRow) return buildAgentConfigFromDoRow(doRow, rules, env);

	// R2 fallback for un-backfilled legacy mailboxes. Self-heals the DO.
	let r2Settings: Record<string, unknown> | null = null;
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (obj) r2Settings = (await obj.json()) as Record<string, unknown>;
	} catch {
		r2Settings = null;
	}
	if (!r2Settings) return { ...defaults(env), rules };

	console.warn(
		`[agent-config] DO mailbox_settings missing for "${mailboxId}" — self-healing from R2. The next save (or an admin replay) finishes the migration.`,
	);
	const lazyInput = r2SettingsToDoInput(r2Settings);
	try {
		await stub.replaceMailboxSettings(lazyInput);
	} catch (e) {
		console.warn(
			`[agent-config] DO self-heal write failed for "${mailboxId}": ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	return buildAgentConfigFromR2(r2Settings, rules, env);
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
		invoiceModel: coerceOptionalModel(row.invoiceModel),
		customSystemPrompt:
			typeof row.agentSystemPrompt === "string" && row.agentSystemPrompt.trim()
				? row.agentSystemPrompt
				: null,
		rules,
		invoiceSourceDomains: coerceInvoiceSourceDomains(row.invoiceSourceDomains),
		invoiceAgentSystemPrompt:
			typeof row.invoiceAgentSystemPrompt === "string" &&
			row.invoiceAgentSystemPrompt.trim()
				? row.invoiceAgentSystemPrompt
				: null,
		emailReplyEnabledSkills: coerceSkills(row.emailReplyEnabledSkills),
		invoiceEnabledSkills: coerceSkills(row.invoiceEnabledSkills),
	};
}

function buildAgentConfigFromR2(
	settings: Record<string, unknown>,
	rules: Rule[],
	env: Env,
): AgentConfig {
	return {
		autoDraft: settings.autoDraft !== false,
		model: coerceModel(settings.agentModel, env),
		emailReplyModel: coerceOptionalModel(settings.emailReplyModel),
		invoiceModel: coerceOptionalModel(settings.invoiceModel),
		customSystemPrompt:
			typeof settings.agentSystemPrompt === "string" && settings.agentSystemPrompt.trim()
				? settings.agentSystemPrompt
				: null,
		rules,
		invoiceSourceDomains: coerceInvoiceSourceDomains(settings.invoiceSourceDomains),
		invoiceAgentSystemPrompt:
			typeof settings.invoiceAgentSystemPrompt === "string" &&
			settings.invoiceAgentSystemPrompt.trim()
				? settings.invoiceAgentSystemPrompt
				: null,
		emailReplyEnabledSkills: coerceSkills(settings.emailReplyEnabledSkills),
		invoiceEnabledSkills: coerceSkills(settings.invoiceEnabledSkills),
	};
}

function r2SettingsToDoInput(settings: Record<string, unknown>): MailboxSettingsInput {
	return {
		autoDraft:
			settings.autoDraft === true || settings.autoDraft === false
				? (settings.autoDraft as boolean)
				: null,
		agentModel: typeof settings.agentModel === "string" ? settings.agentModel : null,
		emailReplyModel:
			typeof settings.emailReplyModel === "string" ? settings.emailReplyModel : null,
		invoiceModel:
			typeof settings.invoiceModel === "string" ? settings.invoiceModel : null,
		agentSystemPrompt:
			typeof settings.agentSystemPrompt === "string" ? settings.agentSystemPrompt : null,
		invoiceAgentSystemPrompt:
			typeof settings.invoiceAgentSystemPrompt === "string"
				? settings.invoiceAgentSystemPrompt
				: null,
		invoiceSourceDomains: stringArrayOrNull(settings.invoiceSourceDomains),
		emailReplyEnabledSkills: stringArrayOrNull(settings.emailReplyEnabledSkills),
		invoiceEnabledSkills: stringArrayOrNull(settings.invoiceEnabledSkills),
	};
}

function stringArrayOrNull(raw: unknown): readonly string[] | null {
	if (!Array.isArray(raw)) return null;
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") out.push(entry);
	}
	return out;
}

/**
 * R2 settings keys that PR 5/6 moved into the MailboxDO `mailbox_settings`
 * row. Worker entrypoints (HTTP `PUT /api/v1/mailboxes/:id`, MCP
 * `update_mailbox_settings`) split these off the R2 write payload and route
 * them through `updateMailboxSettings` instead.
 */
export const AGENT_CONFIG_FIELDS = [
	"autoDraft",
	"agentModel",
	"emailReplyModel",
	"invoiceModel",
	"agentSystemPrompt",
	"invoiceAgentSystemPrompt",
	"invoiceSourceDomains",
	"emailReplyEnabledSkills",
	"invoiceEnabledSkills",
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
	if ("invoiceModel" in raw) {
		patch.invoiceModel =
			typeof raw.invoiceModel === "string" && raw.invoiceModel.trim()
				? raw.invoiceModel.trim()
				: null;
	}
	if ("agentSystemPrompt" in raw) {
		patch.agentSystemPrompt =
			typeof raw.agentSystemPrompt === "string" ? raw.agentSystemPrompt : null;
	}
	if ("invoiceAgentSystemPrompt" in raw) {
		patch.invoiceAgentSystemPrompt =
			typeof raw.invoiceAgentSystemPrompt === "string"
				? raw.invoiceAgentSystemPrompt
				: null;
	}
	if ("invoiceSourceDomains" in raw) {
		patch.invoiceSourceDomains = Array.isArray(raw.invoiceSourceDomains)
			? raw.invoiceSourceDomains.filter((s): s is string => typeof s === "string")
			: null;
	}
	if ("emailReplyEnabledSkills" in raw) {
		patch.emailReplyEnabledSkills = Array.isArray(raw.emailReplyEnabledSkills)
			? raw.emailReplyEnabledSkills.filter((s): s is string => typeof s === "string")
			: null;
	}
	if ("invoiceEnabledSkills" in raw) {
		patch.invoiceEnabledSkills = Array.isArray(raw.invoiceEnabledSkills)
			? raw.invoiceEnabledSkills.filter((s): s is string => typeof s === "string")
			: null;
	}
	return patch;
}

/**
 * Project a DO settings row into the R2-shape settings keys the legacy
 * settings UI expects. Null DO columns are omitted so the merged payload
 * does not advertise a value the user never set.
 */
export function mailboxSettingsRowToR2Shape(
	row: MailboxSettingsRow,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (row.autoDraft !== null) out.autoDraft = row.autoDraft;
	if (row.agentModel !== null) out.agentModel = row.agentModel;
	if (row.emailReplyModel !== null) out.emailReplyModel = row.emailReplyModel;
	if (row.invoiceModel !== null) out.invoiceModel = row.invoiceModel;
	if (row.agentSystemPrompt !== null) out.agentSystemPrompt = row.agentSystemPrompt;
	if (row.invoiceAgentSystemPrompt !== null) {
		out.invoiceAgentSystemPrompt = row.invoiceAgentSystemPrompt;
	}
	if (row.invoiceSourceDomains !== null) {
		out.invoiceSourceDomains = [...row.invoiceSourceDomains];
	}
	if (row.emailReplyEnabledSkills !== null) {
		out.emailReplyEnabledSkills = [...row.emailReplyEnabledSkills];
	}
	if (row.invoiceEnabledSkills !== null) {
		out.invoiceEnabledSkills = [...row.invoiceEnabledSkills];
	}
	return out;
}

function defaults(env: Env): AgentConfig {
	return {
		autoDraft: true,
		model: env.LLM_DEFAULT_MODEL?.trim() || DEFAULT_AGENT_MODEL,
		emailReplyModel: null,
		invoiceModel: null,
		customSystemPrompt: null,
		rules: [],
		invoiceSourceDomains: [],
		invoiceAgentSystemPrompt: null,
		emailReplyEnabledSkills: null,
		invoiceEnabledSkills: null,
	};
}

/**
 * Effective invoice-source domain whitelist for a mailbox: built-in defaults
 * concatenated with valid per-mailbox extras. Pipeline callers feed this to
 * `fetchInvoiceFile` / `scanInvoiceLinks` so per-mailbox onboarding of new
 * tax/ticket platforms doesn't need a redeploy.
 */
export async function resolveInvoiceSourceDomains(
	env: Env,
	mailboxId: string,
): Promise<readonly string[]> {
	const config = await getAgentConfig(env, mailboxId);
	if (config.invoiceSourceDomains.length === 0) return DEFAULT_INVOICE_SOURCE_DOMAINS;
	return [...DEFAULT_INVOICE_SOURCE_DOMAINS, ...config.invoiceSourceDomains];
}

// ── Mutation helpers ───────────────────────────────────────────────

export interface AgentConfigUpdate {
	autoDraft?: boolean;
	/** Legacy shared model override. New callers should set
	 *  `emailReplyModel` / `invoiceModel` instead. */
	agentModel?: string;
	/** Per-agent model override for EmailAgent. Pass `null` to clear and fall
	 *  back to the legacy `agentModel`, then env default. */
	emailReplyModel?: string | null;
	/** Per-agent model override for InvoiceAgent. Same fallback chain. */
	invoiceModel?: string | null;
	/** Pass `null` to clear the custom prompt and fall back to the default. */
	agentSystemPrompt?: string | null;
	/** Pass `null` to clear the InvoiceAgent prompt and fall back to its default. */
	invoiceAgentSystemPrompt?: string | null;
	/** Pass `null` to clear the allowlist and fall back to the agent's default
	 *  set of skills; pass `[]` to disable all skills. */
	emailReplyEnabledSkills?: readonly string[] | null;
	/** Reserved — read by getAgentConfig but not yet consumed by InvoiceAgent. */
	invoiceEnabledSkills?: readonly string[] | null;
}

function settingsKey(mailboxId: string): string {
	return `mailboxes/${mailboxId}.json`;
}

async function readSettings(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown>> {
	const obj = await env.BUCKET.get(settingsKey(mailboxId));
	if (!obj) throw new Error(`Mailbox "${mailboxId}" not found`);
	return (await obj.json()) as Record<string, unknown>;
}

async function writeSettings(
	env: Env,
	mailboxId: string,
	settings: Record<string, unknown>,
): Promise<void> {
	await env.BUCKET.put(settingsKey(mailboxId), JSON.stringify(settings));
}

/**
 * Patch agent-config fields into the MailboxDO `mailbox_settings` row. Unknown
 * model values are rejected up-front; absent fields leave the current value
 * untouched. R2 is no longer mutated here — agent-config writes are
 * MailboxDO-owned (PR 6 cutover).
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
	if (update.invoiceModel !== undefined) {
		patch.invoiceModel =
			update.invoiceModel === null || !update.invoiceModel.trim()
				? null
				: update.invoiceModel.trim();
	}
	if (update.agentSystemPrompt !== undefined) {
		patch.agentSystemPrompt = update.agentSystemPrompt;
	}
	if (update.invoiceAgentSystemPrompt !== undefined) {
		patch.invoiceAgentSystemPrompt = update.invoiceAgentSystemPrompt;
	}
	if (update.emailReplyEnabledSkills !== undefined) {
		patch.emailReplyEnabledSkills = update.emailReplyEnabledSkills;
	}
	if (update.invoiceEnabledSkills !== undefined) {
		patch.invoiceEnabledSkills = update.invoiceEnabledSkills;
	}
	await stub.updateMailboxSettings(patch);
	return getAgentConfig(env, mailboxId);
}

/**
 * Replace the rules array on the R2 settings blob. Runs `RulesSchema.parse`
 * so malformed rules are rejected before storage.
 */
export async function setRules(
	env: Env,
	mailboxId: string,
	rawRules: unknown,
): Promise<Rule[]> {
	const rules = RulesSchema.parse(rawRules);
	const settings = await readSettings(env, mailboxId);
	settings.rules = rules;
	await writeSettings(env, mailboxId, settings);
	return rules;
}
