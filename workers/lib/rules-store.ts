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
	canonicalizeRuleAction,
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
 * In d1 mode, if the DO has zero rules but the legacy R2 settings document
 * still has some, copy them into the DO so the cutover is non-destructive.
 * Returns the post-backfill rows. Idempotent: subsequent calls find a
 * non-empty DO and short-circuit without touching R2.
 *
 * No-op (returns the input rows unchanged) when the DO already has rules or
 * when R2 has no rules to copy. Validation failures are swallowed and logged
 * — a malformed legacy rule should not block the cutover, the offending
 * mailbox just stays empty until an admin re-saves.
 */
async function backfillFromR2IfEmpty(
	env: Env,
	mailboxId: string,
	currentRows: DoStoredRule[],
	settingsHint?: Record<string, unknown> | null,
): Promise<DoStoredRule[]> {
	if (currentRows.length > 0) return currentRows;
	const settings =
		settingsHint !== undefined ? settingsHint : await readSettings(env, mailboxId);
	const r2Rules = parseRulesLoose(settings ?? undefined);
	if (r2Rules.length === 0) return currentRows;
	try {
		const stub = getMailboxStub(env, mailboxId);
		const result = await stub.replaceRules({
			rules: r2Rules.map((r) => ({
				name: r.name ?? null,
				enabled: r.enabled,
				conditions: r.if,
				actions: r.then,
			})),
			expectedVersions: {},
			actor: "r2-backfill",
		});
		if (result.ok) return result.rules;
	} catch (err) {
		console.error(
			`rules-store: r2→d1 backfill failed for mailbox ${mailboxId}`,
			err,
		);
	}
	return currentRows;
}

/**
 * Read all rules for a mailbox, sorted by position.
 *
 * Branches on `getRulesSource(env)`:
 *   - "d1": authoritative SQLite read with real ids / versions; lazily
 *           backfills from legacy R2 settings.rules on first read so the
 *           cutover is non-destructive
 *   - "r2": legacy settings.rules JSON; ids are synthesized as `r2-<idx>`
 *           and version is always 1 since R2 has no row-level CAS. Callers
 *           that depend on stable ids across saves must wait for the d1
 *           cutover.
 */
export async function listRules(env: Env, mailboxId: string): Promise<StoredRule[]> {
	if (getRulesSource(env) === "d1") {
		const stub = getMailboxStub(env, mailboxId);
		let rows = await stub.listRules();
		rows = await backfillFromR2IfEmpty(env, mailboxId, rows);
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
 * in the r2-source path. The hint also feeds the lazy d1 backfill so the
 * inbound-email pipeline does not pay an extra R2 GET on first hit.
 */
export async function loadRulesForEvaluation(
	env: Env,
	mailboxId: string,
	settingsHint?: Record<string, unknown> | null,
): Promise<Rule[]> {
	if (getRulesSource(env) === "d1") {
		const stub = getMailboxStub(env, mailboxId);
		let rows = await stub.listRules();
		rows = await backfillFromR2IfEmpty(env, mailboxId, rows, settingsHint);
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

/**
 * In d1 mode, mirror an R2-shape rules array (the legacy PUT
 * /api/v1/mailboxes/:id payload) into the per-mailbox DO. No-op in r2 mode.
 *
 * Used as a transitional bridge so a UI that still saves rules through the
 * legacy settings endpoint stays consistent with the inbound-email pipeline,
 * which reads from the DO in d1 mode. Once settings.tsx switches to the
 * dedicated /rules endpoints (Workstream 3) this can be deleted.
 *
 * Failures are logged and swallowed — the legacy PUT has already written R2
 * authoritatively for the user, so a D1 mirror failure should not 500 the
 * settings save. The next D1 read will trigger the lazy backfill path.
 */
export async function mirrorLegacyRulesToD1(
	env: Env,
	mailboxId: string,
	rawRules: unknown,
	actor: string,
): Promise<void> {
	if (getRulesSource(env) !== "d1") return;
	const settingsLike = { rules: rawRules } as Record<string, unknown>;
	const parsed = parseRulesLoose(settingsLike);
	try {
		await replaceRules(env, mailboxId, {
			rules: parsed.map((r) => ({
				name: r.name ?? null,
				enabled: r.enabled,
				if: r.if,
				then: r.then,
			})),
			expectedVersions: {},
			actor,
		});
	} catch (err) {
		console.error(
			`rules-store: legacy→d1 mirror failed for mailbox ${mailboxId}`,
			err,
		);
	}
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
	// Validate every rule, then canonicalise — legacy boolean fields lift
	// into `actions[]` here so storage is single-source-of-truth and the
	// shim's translation block becomes dead on the read side. Idempotent on
	// already-canonical rules. Validation runs first so the caller sees a
	// clean 422 instead of a partial DO write.
	const canonical = args.rules.map((r, idx) => {
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
		return { ...r, then: canonicalizeRuleAction(act.data) };
	});

	if (getRulesSource(env) === "d1") {
		const input: DoReplaceRulesInput = {
			rules: canonical.map((r) => ({
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
	const flatRules = canonical.map((r) => ({
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
