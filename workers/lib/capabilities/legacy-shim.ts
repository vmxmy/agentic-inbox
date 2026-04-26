// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Read-side translator: takes a (possibly-legacy) `RuleAction` blob and
 * returns the canonical Capability invocation list + flow envelope.
 *
 * The 6 legacy fields (`markRead`, `moveTo`, `extractAttachmentText`,
 * `extractInvoice`, `skipDraft`, `promptOverride`) on every existing R2
 * settings blob continue to work without rewrite — they're translated to
 * Capability invocations on read. New rules created via the UI use the
 * `actions[]` array directly.
 *
 * `skipDraft` and `promptOverride` are flow flags, not side-effect actions —
 * they stay in the envelope and are read by the executor after the action
 * loop. `moveTo` is BOTH: it triggers a `core:move-folder` invocation AND
 * affects the `movedOutOfInbox` decision in `workers/index.ts`, so we keep
 * it in the envelope alongside emitting the action.
 *
 * `extractAttachmentText` / `extractInvoice` are special: in Phase 1 the
 * executor still implements them inline (they feed extracted text into the
 * agent's `promptOverride` envelope, which the capability surface doesn't
 * model yet). The shim emits the matching capability id as a marker so
 * audit/UI can show "this rule extracts invoices", but the actual work
 * stays inline. Phase 2 will move the inline logic into the capabilities.
 */
import type { RuleAction } from "../rules";

export interface NormalizedAction {
	capabilityId: string;
	params: unknown;
}

export interface NormalizedRuleAction {
	/** Sequential capability invocations (legacy-derived first, then user-authored). */
	actions: NormalizedAction[];
	/** Flow flags read by the executor *after* the action loop. */
	flow: {
		skipDraft: boolean;
		promptOverride: string | null;
		moveTo: string | null;
		extractAttachmentText: boolean;
		extractInvoice: boolean;
	};
}

export function normalizeRuleAction(raw: RuleAction): NormalizedRuleAction {
	const legacy: NormalizedAction[] = [];
	if (raw.markRead) {
		legacy.push({ capabilityId: "core:mark-email-read", params: { read: true } });
	}
	if (raw.moveTo) {
		legacy.push({ capabilityId: "core:move-email", params: { folderId: raw.moveTo } });
	}
	if (raw.extractAttachmentText) {
		legacy.push({ capabilityId: "core:extract-attachment-text", params: {} });
	}
	if (raw.extractInvoice) {
		legacy.push({ capabilityId: "core:extract-invoice", params: {} });
	}

	const explicit: NormalizedAction[] = Array.isArray(raw.actions)
		? raw.actions.map((a) => ({ capabilityId: a.capabilityId, params: a.params ?? {} }))
		: [];

	// Some capabilities are flow markers — having them in `actions[]` is
	// equivalent to setting the matching legacy field. We scan once and lift
	// the signals into the flow envelope so the executor only consults
	// `flow.*` and never has to walk the actions list a second time.
	const explicitIds = new Set(explicit.map((a) => a.capabilityId));
	const explicitMoveTo = explicit.find((a) => a.capabilityId === "core:move-email");
	const explicitMoveToFolder =
		explicitMoveTo && typeof explicitMoveTo.params === "object" && explicitMoveTo.params
			? (explicitMoveTo.params as { folderId?: unknown }).folderId
			: undefined;

	return {
		actions: [...legacy, ...explicit],
		flow: {
			skipDraft: !!raw.skipDraft || explicitIds.has("core:skip-draft"),
			promptOverride: raw.promptOverride ?? null,
			moveTo:
				raw.moveTo ??
				(typeof explicitMoveToFolder === "string" ? explicitMoveToFolder : null),
			extractAttachmentText:
				!!raw.extractAttachmentText || explicitIds.has("core:extract-attachment-text"),
			extractInvoice: !!raw.extractInvoice || explicitIds.has("core:extract-invoice"),
		},
	};
}
