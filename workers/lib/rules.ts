// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Declarative rule engine (v1) for inbound-email processing.
 *
 * Rules live inside mailbox settings (`settings.rules: Rule[]`) and are
 * evaluated top-down when a new email is received. The first rule whose
 * conditions ALL match wins; its action is applied. If no rule matches, the
 * default pipeline runs (auto-draft if enabled).
 *
 * Supported conditions (AND across fields):
 *   - from:             exact email address (case-insensitive)
 *   - fromDomain:       exact domain (no @)
 *   - to:               exact recipient email (any of the comma-separated to's)
 *   - subjectContains:  at least one substring appears in subject (case-insensitive)
 *   - bodyContains:     at least one substring appears in plain body
 *
 * Supported actions:
 *   - skipDraft:       bool  — don't fire the agent auto-draft
 *   - moveTo:          string — folder id to move into (inbox|sent|draft|archive|trash|spam)
 *   - markRead:        bool  — mark the email as read immediately
 *   - promptOverride:  string — prepended to the system prompt for this email's draft
 *
 * No regex support on purpose — keeps the UI simple and the eval fast.
 */
import { z } from "zod";

export const RuleConditionSchema = z.object({
	from: z.string().optional(),
	fromDomain: z.string().optional(),
	to: z.string().optional(),
	subjectContains: z.array(z.string()).optional(),
	bodyContains: z.array(z.string()).optional(),
	/** Rule matches only if the email has at least one attachment whose
	 *  extension (case-insensitive, without the dot) is listed here. */
	hasAttachmentExt: z.array(z.string()).optional(),
}).strict();

export const RuleActionSchema = z.object({
	skipDraft: z.boolean().optional(),
	moveTo: z.string().optional(),
	markRead: z.boolean().optional(),
	promptOverride: z.string().optional(),
	/** When true, parse eligible attachments (XML today, PDF via OCR later)
	 *  and prepend their extracted text to the agent's prompt for this email. */
	extractAttachmentText: z.boolean().optional(),
	/** When true, parse XML attachments as Chinese 全电/增值税发票 and persist
	 *  the structured fields (header + line items) to the mailbox database.
	 *  Runs BEFORE the auto-draft early-return, so it works alongside skipDraft. */
	extractInvoice: z.boolean().optional(),
}).strict();

export const RuleSchema = z.object({
	name: z.string().optional(),
	enabled: z.boolean().default(true),
	if: RuleConditionSchema,
	then: RuleActionSchema,
}).strict();

export const RulesSchema = z.array(RuleSchema);

export type RuleCondition = z.infer<typeof RuleConditionSchema>;
export type RuleAction = z.infer<typeof RuleActionSchema>;
export type Rule = z.infer<typeof RuleSchema>;

export interface IncomingEmailFacts {
	from: string;
	to: string[];
	subject: string;
	body: string;
	/** Lowercased filename extensions (no dot) of the email's attachments. */
	attachmentExts: string[];
}

function normalize(s: string): string {
	return s.trim().toLowerCase();
}

function matches(cond: RuleCondition, facts: IncomingEmailFacts): boolean {
	if (cond.from) {
		if (normalize(facts.from) !== normalize(cond.from)) return false;
	}
	if (cond.fromDomain) {
		const dom = normalize(facts.from).split("@")[1] ?? "";
		if (dom !== normalize(cond.fromDomain)) return false;
	}
	if (cond.to) {
		const want = normalize(cond.to);
		if (!facts.to.some((t) => normalize(t) === want)) return false;
	}
	if (cond.subjectContains?.length) {
		const subj = normalize(facts.subject);
		if (!cond.subjectContains.some((s) => subj.includes(normalize(s)))) return false;
	}
	if (cond.bodyContains?.length) {
		const body = normalize(facts.body);
		if (!cond.bodyContains.some((s) => body.includes(normalize(s)))) return false;
	}
	if (cond.hasAttachmentExt?.length) {
		const wanted = cond.hasAttachmentExt.map((e) => normalize(e).replace(/^\./, ""));
		if (!facts.attachmentExts.some((ext) => wanted.includes(ext))) return false;
	}
	return true;
}

/**
 * First-match-wins. Returns the action of the first enabled rule that matches,
 * or an empty action if nothing matches.
 */
export function evaluateRules(rules: Rule[] | undefined, facts: IncomingEmailFacts): {
	action: RuleAction;
	matchedIndex: number | null;
	matchedName: string | undefined;
} {
	if (!rules?.length) return { action: {}, matchedIndex: null, matchedName: undefined };
	for (let i = 0; i < rules.length; i++) {
		const r = rules[i];
		if (r.enabled === false) continue;
		if (matches(r.if, facts)) {
			return { action: r.then, matchedIndex: i, matchedName: r.name };
		}
	}
	return { action: {}, matchedIndex: null, matchedName: undefined };
}

/** Extract rules from a settings blob, tolerating malformed entries. */
export function parseRulesLoose(settings: Record<string, unknown> | null | undefined): Rule[] {
	if (!settings) return [];
	const raw = settings.rules;
	if (!Array.isArray(raw)) return [];
	const parsed = RulesSchema.safeParse(raw);
	return parsed.success ? parsed.data : [];
}
