// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-level Agent configuration, read from the R2 settings blob.
 * Single source of truth for: auto-draft flag, model, system prompt, rules.
 */
import type { Env } from "../types";
import {
	DEFAULT_INVOICE_SOURCE_DOMAINS,
	isValidInvoiceSourceDomain,
} from "./invoice-link-scanner";
import { RulesSchema, type Rule } from "./rules";
import { loadRulesForEvaluation } from "./rules-store";

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
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return defaults(env);
		const settings = (await obj.json()) as Record<string, unknown>;
		// Rules backend is selected by RULES_SOURCE; in d1-mode this hits the
		// MailboxDO, in r2-mode it parses the in-hand settings document
		// without a second R2 GET.
		const rules = await loadRulesForEvaluation(env, mailboxId, settings);
		return {
			// Default TRUE for backward compatibility with mailboxes created
			// before the flag existed.
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
				typeof settings.invoiceAgentSystemPrompt === "string" && settings.invoiceAgentSystemPrompt.trim()
					? settings.invoiceAgentSystemPrompt
					: null,
			emailReplyEnabledSkills: coerceSkills(settings.emailReplyEnabledSkills),
			invoiceEnabledSkills: coerceSkills(settings.invoiceEnabledSkills),
		};
	} catch {
		return defaults(env);
	}
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
 * Patch agent-config fields into the R2 settings blob. Unknown model values
 * are rejected; absent fields leave the current value untouched.
 */
export async function updateAgentConfig(
	env: Env,
	mailboxId: string,
	update: AgentConfigUpdate,
): Promise<AgentConfig> {
	const settings = await readSettings(env, mailboxId);
	if (update.autoDraft !== undefined) {
		settings.autoDraft = update.autoDraft;
	}
	if (update.agentModel !== undefined) {
		const trimmed = update.agentModel.trim();
		if (!trimmed) throw new Error("agentModel must be a non-empty string");
		// No enum check — model id is validated against the live `/v1/models`
		// catalog at agent invocation time (see workers/lib/llm-models.ts).
		settings.agentModel = trimmed;
	}
	if (update.emailReplyModel !== undefined) {
		if (update.emailReplyModel === null || !update.emailReplyModel.trim()) {
			delete settings.emailReplyModel;
		} else {
			settings.emailReplyModel = update.emailReplyModel.trim();
		}
	}
	if (update.invoiceModel !== undefined) {
		if (update.invoiceModel === null || !update.invoiceModel.trim()) {
			delete settings.invoiceModel;
		} else {
			settings.invoiceModel = update.invoiceModel.trim();
		}
	}
	if (update.agentSystemPrompt !== undefined) {
		if (update.agentSystemPrompt === null) delete settings.agentSystemPrompt;
		else settings.agentSystemPrompt = update.agentSystemPrompt;
	}
	if (update.invoiceAgentSystemPrompt !== undefined) {
		if (update.invoiceAgentSystemPrompt === null) delete settings.invoiceAgentSystemPrompt;
		else settings.invoiceAgentSystemPrompt = update.invoiceAgentSystemPrompt;
	}
	if (update.emailReplyEnabledSkills !== undefined) {
		if (update.emailReplyEnabledSkills === null) delete settings.emailReplyEnabledSkills;
		else settings.emailReplyEnabledSkills = [...update.emailReplyEnabledSkills];
	}
	if (update.invoiceEnabledSkills !== undefined) {
		if (update.invoiceEnabledSkills === null) delete settings.invoiceEnabledSkills;
		else settings.invoiceEnabledSkills = [...update.invoiceEnabledSkills];
	}
	await writeSettings(env, mailboxId, settings);
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
