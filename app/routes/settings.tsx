// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Combobox, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon,
	CopyIcon,
	FunnelIcon,
	KeyIcon,
	LinkIcon,
	LockKeyIcon,
	PlugIcon,
	PlusIcon,
	RobotIcon,
	TrashIcon,
	UserIcon,
	UsersIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { AGENTS, type AgentId } from "~/lib/agent-registry";
import { queryKeys } from "~/queries/keys";
import { useWhoami } from "~/queries/identity";
import { useCapabilities, type CapabilityDescriptor } from "~/queries/capabilities";
import { useModels } from "~/queries/models";
import CapabilityActionEditor from "~/components/CapabilityActionEditor";
import ConnectedApps from "~/components/settings/ConnectedApps";
import { useFolders } from "~/queries/folders";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import {
	useAddMember,
	useCreateInvite,
	useMembers,
	useRemoveMember,
} from "~/queries/members";
import api, { ApiError } from "~/services/api";

type SettingsTab = "account" | "agents" | "rules" | "members" | "connections";

interface SettingsTabDef {
	id: SettingsTab;
	label: string;
	icon: typeof RobotIcon;
}

const SETTINGS_TABS: SettingsTabDef[] = [
	{ id: "account",     label: "Account",      icon: UserIcon },
	{ id: "agents",      label: "Agents",       icon: RobotIcon },
	{ id: "rules",       label: "Rules",        icon: FunnelIcon },
	{ id: "members",     label: "Members",      icon: UsersIcon },
	{ id: "connections", label: "Connections",  icon: PlugIcon },
];

// Model dropdown is populated dynamically from `GET /api/v1/models`
// (see `useModels` hook). Empty initial state means "use server default
// once the catalog loads".
const DEFAULT_MODEL = "";

function friendlyModelName(id: string): string {
	const claude = id.match(/^claude-(\w+)-(\d+)-(\d+)/);
	if (claude) {
		const tier = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
		return `Claude ${tier} ${claude[2]}.${claude[3]}`;
	}
	if (id === "gpt-4o") return "GPT-4o";
	if (id === "gpt-4o-mini") return "GPT-4o mini";
	if (id.startsWith("gpt-4")) return id.replace("gpt-4", "GPT-4").replace(/-/g, " ");
	if (/^o\d+(-\w+)?$/.test(id)) return id.toUpperCase().replace(/-/g, " ");
	const gemini = id.match(/^gemini-(.+)/);
	if (gemini) return `Gemini ${gemini[1].split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")}`;
	return id;
}

// ── Rule types (mirror workers/lib/rules.ts) ──
interface UIRuleAction {
	capabilityId: string;
	params: Record<string, unknown>;
}
// Keys of `then` that the UI knows how to handle. Legacy boolean keys
// (skipDraft / markRead / extractAttachmentText / extractInvoice) are NOT
// written by new saves — they round-trip into `actions[]` on read so the
// data model stays single-source-of-truth. Any other key flows through
// `_unknownThen` so a Settings save never silently destroys a field the UI
// doesn't yet have a control for.
const KNOWN_THEN_KEYS = new Set([
	"skipDraft",
	"moveTo",
	"markRead",
	"extractAttachmentText",
	"extractInvoice",
	"promptOverride",
	"actions",
]);
// Capability ids that the legacy boolean `then.*` flags lift into. Order
// preserved on read so a rule with all four bools renders deterministically.
const LEGACY_BOOL_TO_CAPABILITY: ReadonlyArray<{ key: string; capabilityId: string }> = [
	{ key: "skipDraft", capabilityId: "core:skip-draft" },
	{ key: "markRead", capabilityId: "core:mark-email-read" },
	{ key: "extractAttachmentText", capabilityId: "core:extract-attachment-text" },
	{ key: "extractInvoice", capabilityId: "core:extract-invoice" },
];
interface UIRule {
	name: string;
	enabled: boolean;
	from: string;
	fromDomain: string;
	to: string;
	subjectContains: string;   // comma-separated in UI; split on save
	bodyContains: string;      // comma-separated in UI; split on save
	hasAttachmentExt: string;  // comma-separated, e.g. "xml,pdf"
	moveTo: string;            // "" | <folder id>
	promptOverride: string;
	/** Source of truth for every action the rule runs. Legacy boolean
	 *  fields from R2 are translated into entries here on read. */
	actions: UIRuleAction[];
	/** Backend-supported `then.*` keys the UI doesn't render. Preserved verbatim
	 *  so a save round-trip never deletes them — see the Apr 2026 review where
	 *  `extractInvoice` was lost this way. */
	_unknownThen: Record<string, unknown>;
}
const BLANK_RULE: UIRule = {
	name: "",
	enabled: true,
	from: "",
	fromDomain: "",
	to: "",
	subjectContains: "",
	bodyContains: "",
	hasAttachmentExt: "",
	moveTo: "",
	promptOverride: "",
	actions: [],
	_unknownThen: {},
};
const MOVE_KEEP_OPTION = { value: "", label: "(keep in inbox)" } as const;

/** A capability has no required input fields when the JSON-Schema-serialised
 *  form has no `required` array (or an empty one). Used by RuleThenActionsPicker
 *  to decide which capabilities surface in the no-arg multi-select. */
function hasNoRequiredFields(jsonSchema: unknown): boolean {
	if (!jsonSchema || typeof jsonSchema !== "object") return false;
	const required = (jsonSchema as { required?: unknown }).required;
	return !Array.isArray(required) || required.length === 0;
}

function csvToArray(s: string): string[] {
	return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function arrayToCsv(a: unknown): string {
	return Array.isArray(a) ? a.join(", ") : "";
}
function loadRulesFromSettings(settings: Record<string, unknown> | undefined): UIRule[] {
	const raw = settings?.rules;
	if (!Array.isArray(raw)) return [];
	return raw.map((r) => {
		const cond = (r?.if ?? {}) as Record<string, unknown>;
		const act = (r?.then ?? {}) as Record<string, unknown>;
		const unknownThen: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(act)) {
			if (!KNOWN_THEN_KEYS.has(key)) unknownThen[key] = value;
		}

		// Build the action list: legacy boolean fields lift into capability
		// invocations first (preserving stable order) and explicit actions[]
		// entries follow. Dedupe by capabilityId so a rule with both shapes
		// for the same capability collapses to one entry.
		const actions: UIRuleAction[] = [];
		const seen = new Set<string>();
		for (const { key, capabilityId } of LEGACY_BOOL_TO_CAPABILITY) {
			if (act[key] === true && !seen.has(capabilityId)) {
				seen.add(capabilityId);
				actions.push({ capabilityId, params: {} });
			}
		}
		if (Array.isArray(act.actions)) {
			for (const a of act.actions as unknown[]) {
				if (!a || typeof a !== "object") continue;
				const item = a as { capabilityId?: unknown; params?: unknown };
				if (typeof item.capabilityId !== "string") continue;
				if (seen.has(item.capabilityId)) continue;
				seen.add(item.capabilityId);
				actions.push({
					capabilityId: item.capabilityId,
					params: item.params && typeof item.params === "object"
						? (item.params as Record<string, unknown>)
						: {},
				});
			}
		}

		return {
			name: typeof r?.name === "string" ? r.name : "",
			enabled: r?.enabled !== false,
			from: typeof cond.from === "string" ? cond.from : "",
			fromDomain: typeof cond.fromDomain === "string" ? cond.fromDomain : "",
			to: typeof cond.to === "string" ? cond.to : "",
			subjectContains: arrayToCsv(cond.subjectContains),
			bodyContains: arrayToCsv(cond.bodyContains),
			hasAttachmentExt: arrayToCsv(cond.hasAttachmentExt),
			moveTo: typeof act.moveTo === "string" ? act.moveTo : "",
			promptOverride: typeof act.promptOverride === "string" ? act.promptOverride : "",
			actions,
			_unknownThen: unknownThen,
		};
	});
}
function dumpRulesForSave(rules: UIRule[]) {
	return rules
		.map((r) => {
			const cond: Record<string, unknown> = {};
			if (r.from.trim()) cond.from = r.from.trim();
			if (r.fromDomain.trim()) cond.fromDomain = r.fromDomain.trim();
			if (r.to.trim()) cond.to = r.to.trim();
			const sArr = csvToArray(r.subjectContains);
			if (sArr.length) cond.subjectContains = sArr;
			const bArr = csvToArray(r.bodyContains);
			if (bArr.length) cond.bodyContains = bArr;
			const extArr = csvToArray(r.hasAttachmentExt).map((e) => e.replace(/^\./, "").toLowerCase());
			if (extArr.length) cond.hasAttachmentExt = extArr;
			// Spread unknown-then keys first so any explicit UI control wins on
			// conflict — preserves backend-supported fields the UI does not yet
			// render (e.g. a future capability flag) without overriding state
			// the user just edited in the UI.
			//
			// Legacy boolean fields (skipDraft / markRead / extractAttachmentText /
			// extractInvoice) are no longer written. Their information lives in
			// `actions[]` now; the backend's legacy-shim still accepts the old
			// shape on read so existing R2 documents keep working without rewrite.
			const act: Record<string, unknown> = { ...r._unknownThen };
			if (r.moveTo) act.moveTo = r.moveTo;
			if (r.promptOverride.trim()) act.promptOverride = r.promptOverride.trim();
			const cleanActions = r.actions.filter((a) => a.capabilityId.trim().length > 0);
			if (cleanActions.length) act.actions = cleanActions;
			// Drop rules with no conditions or no actions — they're no-ops / footguns.
			if (Object.keys(cond).length === 0) return null;
			if (Object.keys(act).length === 0) return null;
			return {
				...(r.name.trim() ? { name: r.name.trim() } : {}),
				enabled: r.enabled,
				if: cond,
				then: act,
			};
		})
		.filter(Boolean);
}

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

// Placeholder for the invoice-agent prompt. Authoritative default lives in
// workers/invoice-agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const INVOICE_PROMPT_PLACEHOLDER = `You are the invoice and reimbursement assistant for this mailbox. You search invoices, manage reimbursement bundles, and re-run extraction on specific emails.\n\nNever invent invoice fields. Match the user's language. Display invoice numbers verbatim.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: folders } = useFolders(mailboxId);
	const moveOptions = useMemo(() => {
		const list = (folders ?? []).map((f) => ({ value: f.id, label: f.name }));
		return [MOVE_KEEP_OPTION, ...list];
	}, [folders]);
	const updateMailboxMutation = useUpdateMailbox();
	const { data: modelsData, isLoading: modelsLoading } = useModels();
	const modelOptions = modelsData?.models ?? [];
	const serverDefaultModel = modelsData?.default ?? null;
	const visibleTabs = SETTINGS_TABS;

	const [activeTab, setActiveTab] = useState<SettingsTab>("account");
	const [activeAgentId, setActiveAgentId] = useState<AgentId>(AGENTS[0].id);

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [invoicePrompt, setInvoicePrompt] = useState("");
	const [autoDraft, setAutoDraft] = useState(true);
	// Per-agent model overrides. Empty string = "use server default".
	const [emailReplyModel, setEmailReplyModel] = useState<string>(DEFAULT_MODEL);
	const [invoiceModel, setInvoiceModel] = useState<string>(DEFAULT_MODEL);
	const [rules, setRules] = useState<UIRule[]>([]);
	const [isSaving, setIsSaving] = useState(false);
	/** null = "use server defaults" (no allowlist); array = explicit subset. */
	const [emailReplyEnabledSkills, setEmailReplyEnabledSkills] =
		useState<string[] | null>(null);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setInvoicePrompt(mailbox.settings?.invoiceAgentSystemPrompt || "");
			setAutoDraft((mailbox.settings as Record<string, unknown> | undefined)?.autoDraft !== false);
			const rawSettings = mailbox.settings as Record<string, unknown> | undefined;
			const legacyModel = typeof rawSettings?.agentModel === "string" ? rawSettings.agentModel : "";
			const rawEmailReplyModel = typeof rawSettings?.emailReplyModel === "string"
				? rawSettings.emailReplyModel : "";
			const rawInvoiceModel = typeof rawSettings?.invoiceModel === "string"
				? rawSettings.invoiceModel : "";
			// Per-agent: explicit field wins, else legacy shared field, else "" (server default).
			setEmailReplyModel(rawEmailReplyModel || legacyModel || DEFAULT_MODEL);
			setInvoiceModel(rawInvoiceModel || legacyModel || DEFAULT_MODEL);
			setRules(loadRulesFromSettings(mailbox.settings as Record<string, unknown> | undefined));
			const rawSkills = (mailbox.settings as Record<string, unknown> | undefined)
				?.emailReplyEnabledSkills;
			setEmailReplyEnabledSkills(
				Array.isArray(rawSkills) ? (rawSkills.filter((s) => typeof s === "string") as string[]) : null,
			);
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			invoiceAgentSystemPrompt: invoicePrompt.trim() || undefined,
			autoDraft,
			// Per-agent overrides. Empty string = "use server default" → drop
			// the field so the reader falls back to legacy `agentModel`, then
			// env.LLM_DEFAULT_MODEL.
			emailReplyModel: emailReplyModel.trim() || undefined,
			invoiceModel: invoiceModel.trim() || undefined,
			// Stop writing the legacy shared `agentModel` — the per-agent
			// fields above replace it. Existing values stay intact in the
			// blob (we don't delete) so other readers still see them as
			// fallback if needed.
			rules: dumpRulesForSave(rules),
			emailReplyEnabledSkills: emailReplyEnabledSkills ?? undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const updateRule = (idx: number, patch: Partial<UIRule>) => {
		setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
	};
	const addRule = () => setRules((prev) => [...prev, { ...BLANK_RULE }]);
	const removeRule = (idx: number) =>
		setRules((prev) => prev.filter((_, i) => i !== idx));

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const activeAgent = AGENTS.find((a) => a.id === activeAgentId) ?? AGENTS[0];
	const ActiveAgentIcon = activeAgent.icon;
	const activePromptValue =
		activeAgent.promptField === "agentSystemPrompt" ? agentPrompt : invoicePrompt;
	const setActivePrompt =
		activeAgent.promptField === "agentSystemPrompt" ? setAgentPrompt : setInvoicePrompt;
	const isActivePromptCustom = activePromptValue.trim().length > 0;
	const activePromptPlaceholder =
		activeAgent.promptField === "agentSystemPrompt" ? PROMPT_PLACEHOLDER : INVOICE_PROMPT_PLACEHOLDER;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			{/* Tab bar */}
			<div
				role="tablist"
				aria-label="Settings sections"
				className="flex items-center gap-1 border-b border-kumo-line mb-6 -mx-4 px-4 md:-mx-8 md:px-8 overflow-x-auto"
			>
				{visibleTabs.map((t) => {
					const Icon = t.icon;
					const active = activeTab === t.id;
					return (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => setActiveTab(t.id)}
							className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
								active
									? "text-kumo-default border-kumo-primary"
									: "text-kumo-subtle hover:text-kumo-default border-transparent"
							}`}
						>
							<Icon size={14} weight={active ? "duotone" : "regular"} />
							{t.label}
						</button>
					);
				})}
			</div>

			<div className="space-y-6">
				{/* ── Account tab ── */}
				{activeTab === "account" && (
					<>
						<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
							<div className="text-sm font-medium text-kumo-default mb-4">Account</div>
							<div className="space-y-3">
								<Input
									label="Display Name"
									value={displayName}
									onChange={(e) => setDisplayName(e.target.value)}
									autoComplete="name"
								/>
								<Input label="Email" type="email" value={mailbox.email} disabled />
							</div>
						</div>
						<ChangePasswordCard />
						<ApiKeysCard />
					</>
				)}

				{/* ── Agents tab ── */}
				{activeTab === "agents" && (
					<div className="space-y-4">
						{/* Agent chip selector */}
						<div
							role="tablist"
							aria-label="Agents"
							className="flex items-center gap-2 overflow-x-auto pb-1"
						>
							{AGENTS.map((a) => {
								const Icon = a.icon;
								const active = activeAgentId === a.id;
								return (
									<button
										key={a.id}
										type="button"
										role="tab"
										aria-selected={active}
										onClick={() => setActiveAgentId(a.id)}
										className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors ${
											active
												? "bg-kumo-recessed border-kumo-primary text-kumo-default"
												: "bg-kumo-base border-kumo-line text-kumo-subtle hover:text-kumo-default"
										}`}
									>
										<Icon size={13} weight="duotone" />
										{a.name}
									</button>
								);
							})}
						</div>

						{/* Selected agent detail */}
						<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-5">
							<div className="flex items-start gap-2">
								<ActiveAgentIcon size={18} weight="duotone" className="text-kumo-subtle mt-0.5" />
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium text-kumo-default">{activeAgent.name}</div>
									<div className="text-xs text-kumo-subtle">{activeAgent.description}</div>
								</div>
							</div>

							{activeAgent.hasAutoDraft && (
								<label className="flex items-start gap-3 cursor-pointer">
									<input
										type="checkbox"
										className="mt-1 h-4 w-4 accent-kumo-primary cursor-pointer"
										checked={autoDraft}
										onChange={(e) => setAutoDraft(e.target.checked)}
									/>
									<span className="text-xs text-kumo-default">
										<span className="block font-medium mb-0.5">Auto-draft on new emails</span>
										<span className="text-kumo-subtle">
											When on, every inbound email triggers the agent to draft a reply
											into Drafts (you still review &amp; send). When off, the agent only
											responds in the side panel when you ask.
										</span>
									</span>
								</label>
							)}

							{activeAgent.hasModelOverride && (() => {
								// Per-agent model bound to the active agent's slot.
								const activeModel = emailReplyModel;
								const setActiveModel = setEmailReplyModel;
								return (
								<div>
									<label className="block text-xs font-medium text-kumo-default mb-1.5">Model</label>
									<select
										value={activeModel}
										onChange={(e) => setActiveModel(e.target.value)}
										disabled={modelsLoading}
										className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring disabled:opacity-50"
									>
										<option value="">
											{modelsLoading
												? "Loading models…"
												: serverDefaultModel
													? `(server default: ${serverDefaultModel})`
													: "(server default)"}
										</option>
										{modelOptions.map((m) => (
											<option key={m.id} value={m.id}>
												{friendlyModelName(m.id)}{m.owned_by ? ` — ${m.owned_by}` : ""}
											</option>
										))}
										{activeModel && !modelOptions.find((m) => m.id === activeModel) && (
											<option value={activeModel}>{activeModel} (not in current catalog)</option>
										)}
									</select>
									<p className="text-xs text-kumo-subtle mt-1.5">
										Routes through the active LLM provider (Settings → System).
										Each agent's model is independent — empty falls back to the
										server default. Tool-calling support varies; swap if drafts
										or invoice extractions look off.
									</p>
								</div>
								);
							})()}

							{/* System prompt */}
							<div>
								<div className="flex items-center justify-between mb-2">
									<div className="flex items-center gap-2">
										<span className="text-xs font-medium text-kumo-default">System prompt</span>
										{isActivePromptCustom ? (
											<Badge variant="primary">Custom</Badge>
										) : (
											<Badge variant="secondary">Default</Badge>
										)}
									</div>
									{isActivePromptCustom && (
										<Button
											variant="ghost"
											size="xs"
											icon={<ArrowCounterClockwiseIcon size={14} />}
											onClick={() => setActivePrompt("")}
										>
											Reset to default
										</Button>
									)}
								</div>
								<textarea
									value={activePromptValue}
									onChange={(e) => setActivePrompt(e.target.value)}
									placeholder={activePromptPlaceholder}
									rows={12}
									className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
								/>
								<p className="text-xs text-kumo-subtle mt-2">
									Leave empty to use the built-in default prompt. Sent as the
									system message to the model on every turn.
								</p>
							</div>

							{/* Skills — capabilities the agent is allowed to invoke */}
							{activeAgent.id === "email-reply" && (
								<EmailAgentSkillsPicker
									mailboxId={mailboxId}
									enabledSkills={emailReplyEnabledSkills}
									onChange={setEmailReplyEnabledSkills}
									allowedToolNames={activeAgent.tools.map((t) => t.name)}
								/>
							)}
							{activeAgent.id !== "email-reply" && (
								<div>
									<div className="flex items-center gap-2 mb-2">
										<span className="text-xs font-medium text-kumo-default">Available actions</span>
										<Badge variant="secondary">{activeAgent.tools.length}</Badge>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{activeAgent.tools.map((t) => (
											<span
												key={t.name}
												title={t.description}
												className="inline-flex items-center px-2 py-0.5 rounded border border-kumo-line bg-kumo-recessed text-[11px] font-mono text-kumo-default cursor-help"
											>
												{t.name}
											</span>
										))}
									</div>
									<p className="text-xs text-kumo-subtle mt-2">
										Per-skill toggles for this agent ship with its capability migration in Phase 2.
									</p>
								</div>
							)}
						</div>
					</div>
				)}

				{/* ── Rules tab ── */}
				{activeTab === "rules" && (
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
						<div className="flex items-center justify-between mb-3">
							<div className="flex items-center gap-2">
								<FunnelIcon size={16} weight="duotone" className="text-kumo-subtle" />
								<span className="text-sm font-medium text-kumo-default">Processing Rules</span>
								<Badge variant="secondary">{rules.length}</Badge>
							</div>
							<Button variant="ghost" size="xs" icon={<PlusIcon size={14} />} onClick={addRule}>
								Add rule
							</Button>
						</div>
						<p className="text-xs text-kumo-subtle mb-3">
							Evaluated top-to-bottom on every incoming email. The first rule whose
							conditions ALL match applies its actions. Rules run BEFORE the agent
							auto-draft, so <code>skipDraft</code> / <code>moveTo</code> can short-circuit it.
						</p>

						{rules.length === 0 && (
							<div className="text-xs italic text-kumo-subtle px-2 py-4 text-center">
								No rules. Every inbound email goes through the default auto-draft pipeline.
							</div>
						)}

						<div className="space-y-3">
							{rules.map((r, idx) => (
								<div key={idx} className="rounded border border-kumo-line bg-kumo-recessed p-3">
									<div className="flex items-center justify-between mb-2">
										<div className="flex items-center gap-2">
											<label className="flex items-center gap-1.5 cursor-pointer">
												<input
													type="checkbox"
													className="h-3.5 w-3.5 accent-kumo-primary"
													checked={r.enabled}
													onChange={(e) => updateRule(idx, { enabled: e.target.checked })}
												/>
												<span className="text-xs text-kumo-subtle">enabled</span>
											</label>
											<Input
												placeholder="Rule name (optional)"
												value={r.name}
												onChange={(e) => updateRule(idx, { name: e.target.value })}
											/>
										</div>
										<Button
											variant="ghost"
											size="xs"
											icon={<TrashIcon size={13} />}
											aria-label="Remove rule"
											onClick={() => removeRule(idx)}
										/>
									</div>

									<div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
										<div>
											<label className="block text-[10px] uppercase tracking-wide text-kumo-subtle mb-1">When …</label>
											<div className="space-y-1.5">
												<Input
													placeholder='from (exact email, e.g. "alice@x.com")'
													value={r.from}
													onChange={(e) => updateRule(idx, { from: e.target.value })}
												/>
												<Input
													placeholder='fromDomain (e.g. "acme.com")'
													value={r.fromDomain}
													onChange={(e) => updateRule(idx, { fromDomain: e.target.value })}
												/>
												<Input
													placeholder='to (exact recipient)'
													value={r.to}
													onChange={(e) => updateRule(idx, { to: e.target.value })}
												/>
												<Input
													placeholder='subjectContains (comma-separated)'
													value={r.subjectContains}
													onChange={(e) => updateRule(idx, { subjectContains: e.target.value })}
												/>
												<Input
													placeholder='bodyContains (comma-separated)'
													value={r.bodyContains}
													onChange={(e) => updateRule(idx, { bodyContains: e.target.value })}
												/>
												<Input
													placeholder='hasAttachmentExt (comma-separated, e.g. "xml, pdf")'
													value={r.hasAttachmentExt}
													onChange={(e) => updateRule(idx, { hasAttachmentExt: e.target.value })}
												/>
											</div>
										</div>

										<div>
											<label className="block text-[10px] uppercase tracking-wide text-kumo-subtle mb-1">Then …</label>
											<div className="space-y-1.5">
												<RuleThenActionsPicker
													mailboxId={mailboxId}
													actions={r.actions}
													onChange={(nextActions) => updateRule(idx, { actions: nextActions })}
												/>
												<div>
													<label className="block text-[10px] text-kumo-subtle mb-0.5">Move to folder</label>
													<select
														value={r.moveTo}
														onChange={(e) => updateRule(idx, { moveTo: e.target.value })}
														className="w-full rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default"
													>
														{moveOptions.map((o) => (
															<option key={o.value} value={o.value}>{o.label}</option>
														))}
														{r.moveTo && !moveOptions.some((o) => o.value === r.moveTo) && (
															<option key={r.moveTo} value={r.moveTo}>{r.moveTo} (missing)</option>
														)}
													</select>
												</div>
												<div>
													<label className="block text-[10px] text-kumo-subtle mb-0.5">Prompt addon (prepended to system prompt for this email)</label>
													<textarea
														rows={3}
														value={r.promptOverride}
														onChange={(e) => updateRule(idx, { promptOverride: e.target.value })}
														placeholder='e.g. "This is a VIP sender — reply warmly, CC me-backup@x.com"'
														className="w-full resize-y rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
													/>
												</div>
												<RuleCapabilityActions
													mailboxId={mailboxId}
													actions={r.actions}
													onChange={(next) => updateRule(idx, { actions: next })}
												/>
											</div>
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{/* ── Members tab ── */}
				{activeTab === "members" && mailboxId && <MembersCard mailboxId={mailboxId} />}

				{/* ── Connections tab (L4 MCP Client) ── */}
				{activeTab === "connections" && mailboxId && (
					<ConnectionsTabPanel mailboxId={mailboxId} />
				)}

				{/* Save (covers Account / Agents / Rules — Members / Connections manage their own actions) */}
				{activeTab !== "members" && activeTab !== "connections" && (
					<div className="flex justify-end">
						<Button variant="primary" onClick={handleSave} loading={isSaving}>
							Save Changes
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

// ── ConnectionsTabPanel ───────────────────────────────────────────
//
// Thin wrapper around <ConnectedApps /> that resolves the owner flag
// using the same `whoami.email === members.owner` shape as the
// Members tab — keeps the role-gating logic single-source-of-truth at
// the route level rather than duplicating it inside the leaf
// component.

function ConnectionsTabPanel({ mailboxId }: { mailboxId: string }) {
	const { data: whoami } = useWhoami();
	const { data: members } = useMembers(mailboxId);
	const isOwner = !!(whoami?.email && members?.owner && members.owner === whoami.email);
	return <ConnectedApps mailboxId={mailboxId} isOwner={isOwner} />;
}

// ── MembersCard ────────────────────────────────────────────────────

function MembersCard({ mailboxId }: { mailboxId: string }) {
	const toastManager = useKumoToastManager();
	const { data: whoami } = useWhoami();
	const { data: members, isLoading } = useMembers(mailboxId);
	const addMember = useAddMember();
	const removeMember = useRemoveMember();
	const createInvite = useCreateInvite();
	const [addEmail, setAddEmail] = useState("");
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);
	const [inviteExpires, setInviteExpires] = useState<number | null>(null);

	const isOwner = !!(whoami?.email && members?.owner && members.owner === whoami.email);
	const teamManaged = !!members?.teamManaged;
	const canMutateMembers = isOwner && !teamManaged;

	const handleAdd = async () => {
		const value = addEmail.trim();
		if (!value || !value.includes("@")) {
			toastManager.add({ title: "Enter a valid email", variant: "error" });
			return;
		}
		try {
			await addMember.mutateAsync({ mailboxId, email: value });
			setAddEmail("");
			toastManager.add({ title: `Added ${value}` });
		} catch {
			toastManager.add({ title: "Failed to add member", variant: "error" });
		}
	};

	const handleRemove = async (email: string) => {
		try {
			await removeMember.mutateAsync({ mailboxId, email });
			toastManager.add({ title: `Removed ${email}` });
		} catch {
			toastManager.add({ title: "Failed to remove member", variant: "error" });
		}
	};

	const handleInvite = async () => {
		try {
			const res = await createInvite.mutateAsync(mailboxId);
			setInviteUrl(res.url);
			setInviteExpires(res.expiresAt);
		} catch {
			toastManager.add({ title: "Failed to create invite", variant: "error" });
		}
	};

	const handleCopy = async () => {
		if (!inviteUrl) return;
		try {
			await navigator.clipboard.writeText(inviteUrl);
			toastManager.add({ title: "Invite link copied" });
		} catch {
			toastManager.add({ title: "Copy failed — select the link manually", variant: "error" });
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-4">
				<UsersIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Members</span>
				{teamManaged ? (
					<Badge variant="primary">Team-managed</Badge>
				) : isOwner ? (
					<Badge variant="primary">Owner</Badge>
				) : (
					<Badge variant="secondary">Read-only (member)</Badge>
				)}
			</div>
			{teamManaged ? (
				<div className="mb-3 rounded-md border border-kumo-line bg-kumo-recessed p-3 text-xs text-kumo-subtle">
					This mailbox belongs to{" "}
					<span className="font-medium text-kumo-default">
						{members?.team?.displayName ?? "a team"}
					</span>
					{members?.team?.kind === "team_user" && members.team.userSlug && (
						<>
							{" "}
							(<code>{members.team.userSlug}</code>)
						</>
					)}
					. Access follows team membership — add or remove people from the
					Admin dashboard instead of editing this list.
				</div>
			) : (
				<p className="text-xs text-kumo-subtle mb-3">
					Members (with equal rw access) must already be allowed by the
					Cloudflare Access policy. Only the owner can add or remove
					members, or issue invite links.
				</p>
			)}

			{isLoading ? (
				<div className="flex justify-center py-4"><Loader size="sm" /></div>
			) : teamManaged ? (
				<div className="space-y-2 mb-4">
					<div className="flex items-center justify-between text-xs text-kumo-default bg-kumo-recessed px-3 py-2 rounded">
						<span className="truncate">{members?.team?.displayName ?? "Team mailbox"}</span>
						<Badge variant="primary">
							{members?.team?.kind === "team_user" ? "team user" : "team"}
						</Badge>
					</div>
					{members?.team?.userSlug && (
						<div className="flex items-center justify-between text-xs text-kumo-default bg-kumo-recessed px-3 py-2 rounded">
							<span className="truncate">{members.team.userSlug}</span>
							<Badge variant="secondary">user slug</Badge>
						</div>
					)}
				</div>
			) : (
				<div className="space-y-2 mb-4">
					<div className="flex items-center justify-between text-xs text-kumo-default bg-kumo-recessed px-3 py-2 rounded">
						<span className="truncate">{members?.owner ?? "(no owner yet)"}</span>
						<Badge variant="primary">owner</Badge>
					</div>
					{(members?.members ?? []).map((m) => (
						<div key={m} className="flex items-center justify-between text-xs text-kumo-default bg-kumo-recessed px-3 py-2 rounded">
							<span className="truncate">{m}</span>
							{canMutateMembers && (
								<Button
									variant="ghost"
									size="xs"
									icon={<TrashIcon size={14} />}
									aria-label={`Remove ${m}`}
									onClick={() => handleRemove(m)}
								>
									Remove
								</Button>
							)}
						</div>
					))}
					{members && members.members.length === 0 && (
						<div className="text-xs text-kumo-subtle italic px-3 py-2">
							No additional members.
						</div>
					)}
				</div>
			)}

			{canMutateMembers && (
				<>
					<div className="flex items-end gap-2 mb-3">
						<div className="flex-1">
							<Input
								label="Add member by email"
								placeholder="person@example.com"
								value={addEmail}
								onChange={(e) => setAddEmail(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
								type="email"
								inputMode="email"
								autoComplete="email"
								enterKeyHint="done"
							/>
						</div>
						<Button
							variant="secondary"
							onClick={handleAdd}
							loading={addMember.isPending}
						>
							Add
						</Button>
					</div>

					<div className="border-t border-kumo-line pt-3">
						<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
							<span className="text-xs text-kumo-subtle">
								Or share a 7-day invite link (recipient must pass Access)
							</span>
							<Button
								variant="ghost"
								size="xs"
								icon={<LinkIcon size={14} />}
								onClick={handleInvite}
								loading={createInvite.isPending}
								className="self-start sm:self-auto"
							>
								Generate invite link
							</Button>
						</div>
						{inviteUrl && (
							<div className="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
								<div className="flex-1 min-w-0">
									<Input
										value={inviteUrl}
										readOnly
										onFocus={(e) => e.currentTarget.select()}
									/>
								</div>
								<Button
									variant="secondary"
									size="sm"
									icon={<CopyIcon size={14} />}
									onClick={handleCopy}
									className="shrink-0 self-end sm:self-auto"
								>
									Copy
								</Button>
							</div>
						)}
						{inviteExpires && (
							<p className="text-xs text-kumo-subtle mt-1">
								Expires {new Date(inviteExpires * 1000).toLocaleString()}
							</p>
						)}
					</div>
				</>
			)}
		</div>
	);
}

// ── ChangePasswordCard ─────────────────────────────────────────────
//
// Lets a logged-in user rotate their password. Users created via magic-link
// have no password hash on file; for them this card sets the initial password
// (no current-password prompt) and switches the title to "Set password".

// ── RuleThenActionsPicker ──────────────────────────────────────────
//
// Multi-select Combobox covering every no-arg rule-action capability in
// the registry. Pulls options from useCapabilities at runtime so any new
// no-arg capability shows up automatically — no hardcoded list, no second
// edit when a capability is added. Capabilities that need parameters
// (move-email, webhook, …) live in `RuleCapabilityActions` below.

function RuleThenActionsPicker({
	mailboxId,
	actions,
	onChange,
}: {
	mailboxId: string | undefined;
	actions: UIRuleAction[];
	onChange: (next: UIRuleAction[]) => void;
}) {
	const { data, isLoading } = useCapabilities(mailboxId, { surface: "rule-action" });
	const noArgCaps = useMemo(
		() => (data?.capabilities ?? []).filter((c) => hasNoRequiredFields(c.inputSchema)),
		[data],
	);
	const noArgIds = useMemo(() => new Set(noArgCaps.map((c) => c.id)), [noArgCaps]);
	const selected = useMemo(() => {
		const selectedIds = new Set(actions.map((a) => a.capabilityId));
		return noArgCaps.filter((c) => selectedIds.has(c.id));
	}, [actions, noArgCaps]);

	return (
		<Combobox
			multiple
			items={noArgCaps as unknown as CapabilityDescriptor[]}
			value={selected}
			onValueChange={(next: unknown) => {
				const picked = Array.isArray(next) ? (next as CapabilityDescriptor[]) : [];
				const pickedIds = new Set(picked.map((c) => c.id));
				// Keep with-param actions (handled by RuleCapabilityActions)
				// untouched; replace the no-arg slice with the new selection.
				const kept = actions.filter((a) => !noArgIds.has(a.capabilityId));
				const added = picked.map((c) => ({ capabilityId: c.id, params: {} }));
				const reordered: UIRuleAction[] = [];
				// Stable order: previously-selected first, then newly-added.
				for (const a of actions) {
					if (pickedIds.has(a.capabilityId) && noArgIds.has(a.capabilityId)) {
						reordered.push(a);
						pickedIds.delete(a.capabilityId);
					}
				}
				for (const c of added) {
					if (pickedIds.has(c.capabilityId)) reordered.push(c);
				}
				onChange([...reordered, ...kept]);
			}}
		>
			<Combobox.TriggerMultipleWithInput<CapabilityDescriptor>
				placeholder={
					isLoading
						? "Loading actions…"
						: selected.length === 0
							? "Pick actions…"
							: "Add another…"
				}
				renderItem={(item) => <Combobox.Chip>{item.displayName}</Combobox.Chip>}
			/>
			<Combobox.Content>
				<Combobox.List>
					{((item: CapabilityDescriptor) => (
						<Combobox.Item key={item.id} value={item}>
							<div>
								<div className="text-xs">{item.displayName}</div>
								<div className="text-[10px] text-kumo-subtle">
									{item.description}
								</div>
							</div>
						</Combobox.Item>
					)) as unknown as React.ReactNode}
				</Combobox.List>
				<Combobox.Empty>No matching actions</Combobox.Empty>
			</Combobox.Content>
		</Combobox>
	);
}

// ── RuleCapabilityActions ──────────────────────────────────────────
//
// Editor for capability invocations that take parameters (webhook URL,
// custom fields, etc.). No-arg capabilities live in `RuleThenActionsPicker`
// above and `core:move-email` has its own "Move to folder" field — this
// component handles everything else.

function RuleCapabilityActions({
	mailboxId,
	actions,
	onChange,
}: {
	mailboxId: string | undefined;
	actions: UIRuleAction[];
	onChange: (next: UIRuleAction[]) => void;
}) {
	const { data, isLoading } = useCapabilities(mailboxId, { surface: "rule-action" });
	const allCaps = data?.capabilities ?? [];
	// No-arg capabilities live in `RuleThenActionsPicker` (the Combobox above);
	// `core:move-email` has its own dedicated "Move to folder" field. Both are
	// excluded here so each capability has exactly one home in the editor.
	const selectableCaps = allCaps.filter((c) => {
		if (hasNoRequiredFields(c.inputSchema)) return false;
		if (c.id === "core:move-email") return false;
		return true;
	});

	const addAction = () => {
		const first = selectableCaps[0];
		if (!first) return;
		onChange([...actions, { capabilityId: first.id, params: {} }]);
	};
	const removeAction = (idx: number) => {
		onChange(actions.filter((_, i) => i !== idx));
	};
	const updateAction = (idx: number, patch: Partial<UIRuleAction>) => {
		onChange(actions.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
	};

	return (
		<div className="border-t border-kumo-line pt-3 mt-2">
			<div className="flex items-center justify-between mb-2">
				<label className="block text-[10px] uppercase tracking-wide text-kumo-subtle">
					More actions <span className="lowercase normal-case text-kumo-subtle">(webhook etc.)</span>
				</label>
				<button
					type="button"
					onClick={addAction}
					disabled={isLoading || selectableCaps.length === 0}
					className="text-[11px] text-kumo-link hover:underline disabled:opacity-50"
				>
					+ Add action
				</button>
			</div>
			{actions.length === 0 ? (
				<p className="text-[11px] text-kumo-subtle italic">
					{isLoading ? "Loading capabilities…" : "No additional actions."}
				</p>
			) : (
				<div className="space-y-2">
					{actions.map((a, i) => {
						const cap = allCaps.find((c) => c.id === a.capabilityId);
						return (
							<div key={i} className="rounded border border-kumo-line bg-kumo-recessed p-2 space-y-2">
								<div className="flex items-center gap-2">
									<select
										value={a.capabilityId}
										onChange={(e) => updateAction(i, { capabilityId: e.target.value, params: {} })}
										className="flex-1 bg-kumo-base border border-kumo-line rounded px-2 py-1 text-xs text-kumo-default"
									>
										{selectableCaps.map((c) => (
											<option key={c.id} value={c.id}>
												{c.displayName} ({c.id})
											</option>
										))}
										{!selectableCaps.find((c) => c.id === a.capabilityId) && (
											<option value={a.capabilityId}>{a.capabilityId} (unknown)</option>
										)}
									</select>
									<button
										type="button"
										onClick={() => removeAction(i)}
										className="text-[11px] text-red-400 hover:underline"
									>
										Remove
									</button>
								</div>
								{cap && (
									<CapabilityActionEditor
										capability={cap}
										value={a.params}
										onChange={(next) => updateAction(i, { params: next })}
									/>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ── EmailAgentSkillsPicker ─────────────────────────────────────────
//
// Renders a checkbox per agent-tool capability the EmailAgent is allowed to
// use, bound to the mailbox's `emailReplyEnabledSkills` setting. Default
// (null) = all enabled — preserves pre-Capability behaviour for mailboxes
// that haven't opted into per-skill toggles. Toggling any checkbox
// "materialises" the explicit allowlist; clicking "Reset to default" returns
// to null.

function EmailAgentSkillsPicker({
	mailboxId,
	enabledSkills,
	onChange,
	allowedToolNames,
}: {
	mailboxId: string | undefined;
	enabledSkills: string[] | null;
	onChange: (next: string[] | null) => void;
	allowedToolNames: string[];
}) {
	const { data, isLoading } = useCapabilities(mailboxId, { surface: "agent-tool" });
	const allowedNameSet = new Set(allowedToolNames);
	const candidates = (data?.capabilities ?? []).filter((cap) => {
		const local = cap.id.includes(":") ? cap.id.slice(cap.id.indexOf(":") + 1) : cap.id;
		const toolName = local.replaceAll("-", "_");
		return allowedNameSet.has(toolName);
	});

	const isUsingDefault = enabledSkills === null;
	const enabledSet = isUsingDefault
		? new Set(candidates.map((c) => c.id))
		: new Set(enabledSkills);

	const toggle = (id: string, checked: boolean) => {
		// Materialise explicit list on first toggle.
		const base = isUsingDefault ? candidates.map((c) => c.id) : [...(enabledSkills ?? [])];
		const next = checked
			? base.includes(id) ? base : [...base, id]
			: base.filter((x) => x !== id);
		onChange(next);
	};

	return (
		<div>
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-kumo-default">Skills</span>
					<Badge variant="secondary">{enabledSet.size}/{candidates.length}</Badge>
				</div>
				{!isUsingDefault && (
					<button
						type="button"
						onClick={() => onChange(null)}
						className="text-[11px] text-kumo-subtle hover:text-kumo-default hover:underline"
					>
						Reset to default
					</button>
				)}
			</div>
			{isLoading ? (
				<div className="flex justify-center py-3"><Loader size="sm" /></div>
			) : candidates.length === 0 ? (
				<p className="text-xs text-kumo-subtle italic">No skills available.</p>
			) : (
				<div className="space-y-1.5">
					{candidates.map((cap) => (
						<label
							key={cap.id}
							className="flex items-start gap-2 text-[12px] text-kumo-default cursor-pointer hover:bg-kumo-recessed/50 rounded px-1 py-1"
						>
							<input
								type="checkbox"
								className="mt-0.5"
								checked={enabledSet.has(cap.id)}
								onChange={(e) => toggle(cap.id, e.target.checked)}
							/>
							<span>
								<span className="font-medium">{cap.displayName}</span>
								<span className="text-kumo-subtle ml-2 font-mono text-[10px]">{cap.id}</span>
								<span className="block text-[11px] text-kumo-subtle">{cap.description}</span>
							</span>
						</label>
					))}
				</div>
			)}
			<p className="text-xs text-kumo-subtle mt-2">
				Uncheck to deny the agent that capability. Default is everything enabled.
			</p>
		</div>
	);
}

function ChangePasswordCard() {
	const toastManager = useKumoToastManager();
	const qc = useQueryClient();
	const { data: whoami } = useWhoami();
	const hasPassword = whoami?.hasPassword ?? false;

	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");

	const change = useMutation({
		mutationFn: () =>
			api.changePassword(hasPassword ? currentPassword : null, newPassword),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.whoami });
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
			toastManager.add({ title: hasPassword ? "Password updated" : "Password set" });
		},
		onError: (e) => {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Failed to update password",
				variant: "error",
			});
		},
	});

	const handleSubmit = () => {
		if (newPassword.length < 8) {
			toastManager.add({
				title: "New password must be at least 8 characters",
				variant: "error",
			});
			return;
		}
		if (newPassword !== confirmPassword) {
			toastManager.add({ title: "New passwords don't match", variant: "error" });
			return;
		}
		if (hasPassword && !currentPassword) {
			toastManager.add({ title: "Enter your current password", variant: "error" });
			return;
		}
		change.mutate();
	};

	const submitDisabled =
		!newPassword || !confirmPassword || (hasPassword && !currentPassword);

	return (
		<div className="bg-kumo-base border border-kumo-line rounded-lg p-4 space-y-4">
			<div className="flex items-center gap-2">
				<LockKeyIcon size={16} />
				<span className="text-sm font-medium text-kumo-default">
					{hasPassword ? "Change password" : "Set password"}
				</span>
			</div>
			{!hasPassword && (
				<p className="text-xs text-kumo-subtle">
					Your account doesn't have a password yet — you've only used magic-link
					sign-in. Set one to enable password sign-in too.
				</p>
			)}
			<div className="space-y-3">
				{hasPassword && (
					<Input
						label="Current password"
						type="password"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(e) => setCurrentPassword(e.target.value)}
					/>
				)}
				<Input
					label="New password"
					type="password"
					autoComplete="new-password"
					value={newPassword}
					onChange={(e) => setNewPassword(e.target.value)}
				/>
				<Input
					label="Confirm new password"
					type="password"
					autoComplete="new-password"
					value={confirmPassword}
					onChange={(e) => setConfirmPassword(e.target.value)}
				/>
			</div>
			<div className="flex justify-end">
				<Button
					variant="primary"
					onClick={handleSubmit}
					loading={change.isPending}
					disabled={submitDisabled}
				>
					{hasPassword ? "Update password" : "Set password"}
				</Button>
			</div>
		</div>
	);
}

// ── ApiKeysCard ────────────────────────────────────────────────────
//
// Per-user (not per-mailbox) Bearer tokens that MCP / programmatic clients
// can send via `Authorization: Bearer aix_…`. The raw key is shown exactly
// once, at creation. Revoking is instant (sets revoked_at; verifyApiKey
// filters on isNull(revoked_at)).

function ApiKeysCard() {
	const toastManager = useKumoToastManager();
	const qc = useQueryClient();
	const { data: keys, isLoading } = useQuery({
		queryKey: queryKeys.apiKeys,
		queryFn: () => api.listApiKeys(),
	});
	const create = useMutation({
		mutationFn: (name: string) => api.createApiKey(name),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apiKeys }),
	});
	const revoke = useMutation({
		mutationFn: (id: string) => api.revokeApiKey(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apiKeys }),
	});

	const [newName, setNewName] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);

	const handleCreate = async () => {
		const name = newName.trim();
		if (!name) {
			toastManager.add({ title: "Give the key a name", variant: "error" });
			return;
		}
		try {
			const res = await create.mutateAsync(name);
			setCreatedKey(res.key);
			setNewName("");
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Failed to create key",
				variant: "error",
			});
		}
	};

	const handleCopy = async (raw: string) => {
		try {
			await navigator.clipboard.writeText(raw);
			toastManager.add({ title: "API key copied" });
		} catch {
			toastManager.add({ title: "Copy failed", variant: "error" });
		}
	};

	const handleRevoke = async (id: string, label: string) => {
		try {
			await revoke.mutateAsync(id);
			toastManager.add({ title: `Revoked ${label}` });
		} catch {
			toastManager.add({ title: "Revoke failed", variant: "error" });
		}
	};

	return (
		<div className="bg-kumo-base border border-kumo-line rounded-lg p-4 space-y-4">
			<div className="flex items-center gap-2">
				<KeyIcon size={16} />
				<span className="text-sm font-medium text-kumo-default">API keys</span>
			</div>
			<p className="text-xs text-kumo-subtle">
				Bearer tokens for MCP clients (Claude Code, Cursor, ProtoAgent, etc.) and
				programmatic API calls. Send as{" "}
				<code className="px-1 py-0.5 rounded bg-kumo-recessed">
					Authorization: Bearer aix_…
				</code>
				. Keys inherit your account's mailbox access; revoking is immediate.
			</p>

			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<label className="flex-1 text-xs text-kumo-subtle">
					New key name
					<Input
						className="mt-1 w-full"
						placeholder="e.g. Claude Code on laptop"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
					/>
				</label>
				<Button
					variant="primary"
					onClick={handleCreate}
					loading={create.isPending}
					icon={<PlusIcon size={14} />}
				>
					Generate
				</Button>
			</div>

			{createdKey && (
				<div className="rounded border border-amber-400/40 bg-amber-500/5 p-3 space-y-2">
					<p className="text-xs text-amber-400">
						Copy this key now — it will not be shown again.
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 break-all text-xs font-mono text-kumo-default bg-kumo-recessed px-2 py-1 rounded">
							{createdKey}
						</code>
						<Button
							variant="secondary"
							size="sm"
							icon={<CopyIcon size={14} />}
							onClick={() => handleCopy(createdKey)}
						>
							Copy
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setCreatedKey(null)}
						>
							Done
						</Button>
					</div>
				</div>
			)}

			{isLoading ? (
				<div className="flex justify-center py-4">
					<Loader size="sm" />
				</div>
			) : !keys || keys.length === 0 ? (
				<p className="text-xs text-kumo-subtle italic">No keys yet.</p>
			) : (
				<div className="overflow-x-auto rounded border border-kumo-line">
					<table className="min-w-full text-xs">
						<thead className="bg-kumo-recessed text-kumo-subtle uppercase tracking-wide text-[10px]">
							<tr>
								<th className="px-3 py-2 text-left">Name</th>
								<th className="px-3 py-2 text-left">Prefix</th>
								<th className="px-3 py-2 text-left">Last used</th>
								<th className="px-3 py-2 text-left">Created</th>
								<th className="px-3 py-2 text-left">Status</th>
								<th className="px-3 py-2" />
							</tr>
						</thead>
						<tbody>
							{keys.map((k) => (
								<tr key={k.id} className="border-t border-kumo-line">
									<td className="px-3 py-2">{k.name}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle">
										aix_{k.prefix}…
									</td>
									<td className="px-3 py-2 text-kumo-subtle">
										{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—"}
									</td>
									<td className="px-3 py-2 text-kumo-subtle">
										{new Date(k.createdAt).toLocaleDateString()}
									</td>
									<td className="px-3 py-2">
										{k.revokedAt ? (
											<Badge variant="destructive">revoked</Badge>
										) : k.expiresAt && k.expiresAt < Date.now() ? (
											<Badge variant="secondary">expired</Badge>
										) : (
											<Badge variant="success">active</Badge>
										)}
									</td>
									<td className="px-3 py-2 text-right">
										{!k.revokedAt && (
											<Button
												variant="ghost"
												size="xs"
												icon={<TrashIcon size={14} />}
												onClick={() => handleRevoke(k.id, k.name)}
												aria-label={`Revoke ${k.name}`}
											>
												Revoke
											</Button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
