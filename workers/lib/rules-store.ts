// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Rules persistence — typed wrapper over the MailboxDO RPC surface.
 *
 * Replaces R2 `settings.rules: Rule[]` with per-mailbox SQLite rows. The DO
 * owns identity, position ordering, version CAS, and history; this module
 * owns domain-schema validation (zod `RuleSchema`) and the public API surface
 * consumers reach for.
 */
import type { Env } from "../types";
import type {
	DoReplaceRulesInput,
	DoStoredRule,
	DoRuleHistoryEntry,
} from "../durableObject/index";
import {
	RuleConditionSchema,
	RuleActionSchema,
	RulesSchema,
	parseRulesLoose,
	type Rule,
	type RuleAction,
	type RuleCondition,
} from "./rules";

export type RulesSource = "d1" | "r2";

/** Choose the active storage backend for rule reads/writes. The default is
 *  R2 so any deployment that hasn't run the rules-to-D1 backfill stays on
 *  the legacy path. */
export function getRulesSource(env: Env): RulesSource {
	return env.RULES_SOURCE === "d1" ? "d1" : "r2";
}

export interface StoredRule extends Rule {
	id: string;
	position: number;
	version: number;
	updatedAt: string;
}

export interface RuleInput {
	/** Present = update existing row. Absent = create new (DO mints id). */
	id?: string;
	name?: string | null;
	enabled: boolean;
	if: RuleCondition;
	then: RuleAction;
}

export interface RuleHistoryEntry {
	seq: number;
	ruleId: string;
	version: number;
	changeKind: "create" | "update" | "delete" | "reorder";
	snapshot: unknown;
	changedAt: string;
	changedBy: string | null;
}

export class RuleConflictError extends Error {
	constructor(public readonly conflicts: readonly string[]) {
		super(`Rule version conflict on: ${conflicts.join(", ")}`);
		this.name = "RuleConflictError";
	}
}

export class RuleValidationError extends Error {
	constructor(message: string, public readonly index?: number) {
		super(message);
		this.name = "RuleValidationError";
	}
}

function getMailboxStub(env: Env, mailboxId: string) {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
}

function toStoredRule(row: DoStoredRule): StoredRule {
	// Validate on read so a corrupt row (legacy migration, manual edit) is
	// surfaced rather than silently broken. Tolerant: failing a parse logs
	// and substitutes an empty condition/action so the rule becomes a
	// no-op rather than crashing the inbound-email pipeline.
	const condParsed = RuleConditionSchema.safeParse(row.conditions);
	const actParsed = RuleActionSchema.safeParse(row.actions);
	if (!condParsed.success) {
		console.error(
			`rules-store: rule ${row.id} has invalid conditions, treating as no-match`,
			condParsed.error.message,
		);
	}
	if (!actParsed.success) {
		console.error(
			`rules-store: rule ${row.id} has invalid actions, treating as empty`,
			actParsed.error.message,
		);
	}
	return {
		id: row.id,
		position: row.position,
		version: row.version,
		updatedAt: row.updated_at,
		name: row.name ?? undefined,
		enabled: row.enabled,
		if: condParsed.success ? condParsed.data : {},
		then: actParsed.success ? actParsed.data : {},
	};
}

/**
 * Read all rules for a mailbox, sorted by position.
 *
 * Branches on `getRulesSource(env)`:
 *   - "d1": authoritative SQLite read with real ids / versions
 *   - "r2": legacy settings.rules JSON; ids are synthesized as `r2-<idx>`
 *           and version is always 1 since R2 has no row-level CAS. Callers
 *           that depend on stable ids across saves must wait for the d1
 *           cutover.
 */
export async function listRules(env: Env, mailboxId: string): Promise<StoredRule[]> {
	if (getRulesSource(env) === "d1") {
		const stub = getMailboxStub(env, mailboxId);
		const rows = await stub.listRules();
		return rows.map(toStoredRule);
	}
	const settings = await readSettings(env, mailboxId);
	const rules = parseRulesLoose(settings ?? undefined);
	return rules.map((r, idx) => ({
		id: `r2-${idx}`,
		position: (idx + 1) * 10,
		version: 1,
		updatedAt: new Date(0).toISOString(),
		name: r.name,
		enabled: r.enabled,
		if: r.if,
		then: r.then,
	}));
}

/**
 * Read just the evaluator-ready `Rule[]` for the inbound-email pipeline.
 * Drops the per-row metadata (id/version/position) since `evaluateRules`
 * doesn't need them. Disabled rules are kept so the evaluator's own
 * `enabled` check stays the single source of truth.
 *
 * Accepts an optional `settingsHint` so callers that already have the R2
 * settings document in hand (e.g. `getAgentConfig`) avoid a second R2 GET
 * in the r2-source path.
 */
export async function loadRulesForEvaluation(
	env: Env,
	mailboxId: string,
	settingsHint?: Record<string, unknown> | null,
): Promise<Rule[]> {
	if (getRulesSource(env) === "d1") {
		const stub = getMailboxStub(env, mailboxId);
		const rows = await stub.listRules();
		return rows.map(toStoredRule).map((r) => ({
			name: r.name,
			enabled: r.enabled,
			if: r.if,
			then: r.then,
		}));
	}
	const settings =
		settingsHint !== undefined ? settingsHint : await readSettings(env, mailboxId);
	return parseRulesLoose(settings ?? undefined);
}

async function readSettings(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown> | null> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return null;
	return (await obj.json()) as Record<string, unknown>;
}

export interface ReplaceRulesArgs {
	rules: RuleInput[];
	/** Map of ruleId → version the caller last saw. Required for any rule
	 *  whose `id` is present in `rules`; missing entries are treated as
	 *  "no expectation" (used by tests / migrations). */
	expectedVersions: Record<string, number>;
	actor: string;
}

/**
 * Full-replace semantics: the input list is the new authoritative ordering.
 * Rules in the input with an `id` are updated (version-checked); rules
 * without an `id` are created; existing rules absent from the input are
 * deleted. Positions are re-numbered 10/20/30… on every call.
 *
 * Throws:
 *   - RuleValidationError if any rule fails the zod schema
 *   - RuleConflictError if any version mismatch is detected
 */
export async function replaceRules(
	env: Env,
	mailboxId: string,
	args: ReplaceRulesArgs,
): Promise<StoredRule[]> {
	// Validate every rule before touching the DO. Failing fast here gives the
	// UI a clean 422 instead of a partial DO write.
	args.rules.forEach((r, idx) => {
		const cond = RuleConditionSchema.safeParse(r.if);
		if (!cond.success) {
			throw new RuleValidationError(
				`rule[${idx}] has invalid condition: ${cond.error.message}`,
				idx,
			);
		}
		const act = RuleActionSchema.safeParse(r.then);
		if (!act.success) {
			throw new RuleValidationError(
				`rule[${idx}] has invalid action: ${act.error.message}`,
				idx,
			);
		}
	});

	if (getRulesSource(env) === "d1") {
		const input: DoReplaceRulesInput = {
			rules: args.rules.map((r) => ({
				id: r.id,
				name: r.name ?? null,
				enabled: r.enabled,
				conditions: r.if,
				actions: r.then,
			})),
			expectedVersions: args.expectedVersions,
			actor: args.actor,
		};
		const stub = getMailboxStub(env, mailboxId);
		const result = await stub.replaceRules(input);
		if (!result.ok) {
			throw new RuleConflictError(result.conflicts);
		}
		return result.rules.map(toStoredRule);
	}

	// r2 source: write rules as a flat array into the settings JSON.
	// No real CAS — `expectedVersions` is ignored, latest writer wins. This
	// matches the legacy PUT /api/v1/mailboxes/:id behaviour and is the
	// price of keeping the bridge phase simple. The d1 cutover restores
	// row-level CAS.
	const flatRules = args.rules.map((r) => ({
		...(r.name ? { name: r.name } : {}),
		enabled: r.enabled,
		if: r.if,
		then: r.then,
	}));
	const validated = RulesSchema.parse(flatRules);
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) {
		throw new Error(`Mailbox "${mailboxId}" not found`);
	}
	const settings = (await obj.json()) as Record<string, unknown>;
	settings.rules = validated;
	await env.BUCKET.put(`mailboxes/${mailboxId}.json`, JSON.stringify(settings));
	return listRules(env, mailboxId);
}

const KNOWN_CHANGE_KINDS = new Set(["create", "update", "delete", "reorder"]);

function toRuleHistoryEntry(row: DoRuleHistoryEntry): RuleHistoryEntry {
	const kind = KNOWN_CHANGE_KINDS.has(row.change_kind)
		? (row.change_kind as RuleHistoryEntry["changeKind"])
		: "update";
	return {
		seq: row.seq,
		ruleId: row.rule_id,
		version: row.version,
		changeKind: kind,
		snapshot: row.snapshot,
		changedAt: row.changed_at,
		changedBy: row.changed_by,
	};
}

export async function getRuleHistory(
	env: Env,
	mailboxId: string,
	ruleId: string,
	limit = 20,
): Promise<RuleHistoryEntry[]> {
	// r2 mode never wrote history — surface an empty audit trail rather
	// than a 5xx so the UI can render the "no history" state uniformly.
	if (getRulesSource(env) !== "d1") return [];
	const stub = getMailboxStub(env, mailboxId);
	const rows = await stub.getRuleHistory(ruleId, limit);
	return rows.map(toRuleHistoryEntry);
}
