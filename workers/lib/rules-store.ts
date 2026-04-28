// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Rules persistence — typed wrapper over the MailboxDO RPC surface.
 *
 * D1/DO-backed per-mailbox SQLite rows are the sole authority for rules. The
 * DO owns identity, position ordering, version CAS, and history; this module
 * owns domain-schema validation (zod `RuleSchema`) and the public API surface
 * consumers reach for.
 *
 * The legacy R2 `settings.rules` document is read **once** per mailbox via
 * `backfillFromR2IfEmpty` to seed the DO on first read after the cutover.
 * After that, R2 is never touched for rules — no reads, no writes, no flag.
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
	canonicalizeRuleAction,
	parseRulesLoose,
	type Rule,
	type RuleAction,
	type RuleCondition,
} from "./rules";

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
 * If the DO has zero rules but the legacy R2 settings document still has some,
 * copy them into the DO so the cutover is non-destructive. Returns the
 * post-backfill rows. Idempotent: subsequent calls find a non-empty DO and
 * short-circuit without touching R2.
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
 * Authoritative SQLite read with real ids / versions. Lazily backfills from
 * legacy R2 `settings.rules` on first read per mailbox so deployments
 * upgraded across the second-wave cutover do not drop existing rules.
 */
export async function listRules(env: Env, mailboxId: string): Promise<StoredRule[]> {
	const stub = getMailboxStub(env, mailboxId);
	let rows = await stub.listRules();
	rows = await backfillFromR2IfEmpty(env, mailboxId, rows);
	return rows.map(toStoredRule);
}

/**
 * Read just the evaluator-ready `Rule[]` for the inbound-email pipeline.
 * Drops the per-row metadata (id/version/position) since `evaluateRules`
 * doesn't need them. Disabled rules are kept so the evaluator's own
 * `enabled` check stays the single source of truth.
 *
 * Accepts an optional `settingsHint` so callers that already have the R2
 * settings document in hand (e.g. `getAgentConfig`) feed the one-shot lazy
 * backfill without paying a second R2 GET on first hit.
 */
export async function loadRulesForEvaluation(
	env: Env,
	mailboxId: string,
	settingsHint?: Record<string, unknown> | null,
): Promise<Rule[]> {
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

async function readSettings(
	env: Env,
	mailboxId: string,
): Promise<Record<string, unknown> | null> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return null;
	return (await obj.json()) as Record<string, unknown>;
}

/**
 * Mirror an R2-shape rules array (the legacy PUT /api/v1/mailboxes/:id
 * payload) into the per-mailbox DO.
 *
 * Used as a transitional bridge so a UI that still saves rules through the
 * legacy settings endpoint stays consistent with the inbound-email pipeline.
 * Once settings.tsx switches to the dedicated /rules endpoints (Workstream 3)
 * this can be deleted.
 *
 * Failures are logged and swallowed — the legacy PUT may have already
 * persisted unrelated settings fields, so a rules-mirror failure should not
 * 500 the whole settings save. The next D1 read still serves the previous
 * authoritative rules row.
 */
export async function mirrorLegacyRulesToD1(
	env: Env,
	mailboxId: string,
	rawRules: unknown,
	actor: string,
): Promise<void> {
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
	const stub = getMailboxStub(env, mailboxId);
	const rows = await stub.getRuleHistory(ruleId, limit);
	return rows.map(toRuleHistoryEntry);
}
