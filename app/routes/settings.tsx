// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Combobox, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon,
	CopyIcon,
	FunnelIcon,
	GearSixIcon,
	KeyIcon,
	LinkIcon,
	LockKeyIcon,
	PlusIcon,
	RobotIcon,
	TrashIcon,
	UserIcon,
	UsersIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { AGENTS, type AgentId } from "~/lib/agent-registry";
import { queryKeys } from "~/queries/keys";
import { useWhoami } from "~/queries/identity";
import { useCapabilities } from "~/queries/capabilities";
import { useModels } from "~/queries/models";
import CapabilityActionEditor from "~/components/CapabilityActionEditor";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import {
	useAddMember,
	useCreateInvite,
	useMembers,
	useRemoveMember,
} from "~/queries/members";
import api, { ApiError } from "~/services/api";

type SettingsTab = "account" | "agents" | "rules" | "members" | "system";

interface SettingsTabDef {
	id: SettingsTab;
	label: string;
	icon: typeof RobotIcon;
	/** When true, only admins see this tab. */
	adminOnly?: boolean;
}

const SETTINGS_TABS: SettingsTabDef[] = [
	{ id: "account", label: "Account", icon: UserIcon },
	{ id: "agents",  label: "Agents",  icon: RobotIcon },
	{ id: "rules",   label: "Rules",   icon: FunnelIcon },
	{ id: "members", label: "Members", icon: UsersIcon },
	{ id: "system",  label: "System",  icon: GearSixIcon, adminOnly: true },
];

// Model dropdown is populated dynamically from `GET /api/v1/models`
// (see `useModels` hook). Empty initial state means "use server default
// once the catalog loads".
const DEFAULT_MODEL = "";

// ── Rule types (mirror workers/lib/rules.ts) ──
interface UIRuleAction {
	capabilityId: string;
	params: Record<string, unknown>;
}
// Keys of `then` that the UI knows how to render. Any other key the backend
// supports must round-trip via `_unknownThen` so a Settings save never silently
// destroys a field the UI doesn't yet have a control for.
const KNOWN_THEN_KEYS = new Set([
	"skipDraft",
	"moveTo",
	"markRead",
	"extractAttachmentText",
	"extractInvoice",
	"promptOverride",
	"actions",
]);
interface UIRule {
	name: string;
	enabled: boolean;
	from: string;
	fromDomain: string;
	to: string;
	subjectContains: string;   // comma-separated in UI; split on save
	bodyContains: string;      // comma-separated in UI; split on save
	hasAttachmentExt: string;  // comma-separated, e.g. "xml,pdf"
	skipDraft: boolean;
	moveTo: string;            // "" | inbox | sent | draft | archive | trash | spam
	markRead: boolean;
	extractAttachmentText: boolean;
	extractInvoice: boolean;
	promptOverride: string;
	/** Capability invocations beyond the 5 legacy field actions above. */
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
	skipDraft: false,
	moveTo: "",
	markRead: false,
	extractAttachmentText: false,
	extractInvoice: false,
	promptOverride: "",
	actions: [],
	_unknownThen: {},
};
const MOVE_OPTIONS = [
	{ value: "",        label: "(keep in inbox)" },
	{ value: "inbox",   label: "Inbox (no-op)" },
	{ value: "archive", label: "Archive" },
	{ value: "trash",   label: "Trash" },
	{ value: "spam",    label: "Spam" },
];

// Boolean rule actions that ride on legacy top-level `then.*` fields. Surfaced
// as a multi-select Combobox so the rule editor scales as more no-arg actions
// land — for capabilities that need parameters (move-email, webhook, …) see
// `RuleCapabilityActions` below.
type ThenActionId = "skipDraft" | "markRead" | "extractAttachmentText" | "extractInvoice";
interface ThenActionOption {
	id: ThenActionId;
	label: string;
	description: string;
}
const THEN_ACTION_OPTIONS: readonly ThenActionOption[] = [
	{
		id: "skipDraft",
		label: "Skip auto-draft",
		description: "Don't have the agent draft an auto-reply for this email.",
	},
	{
		id: "markRead",
		label: "Mark as read",
		description: "Auto-mark the email as read on receipt.",
	},
	{
		id: "extractAttachmentText",
		label: "Extract attachment text",
		description: "Parse XML attachments inline (incl. 全电发票) and feed into the agent's prompt. PDF OCR coming next.",
	},
	{
		id: "extractInvoice",
		label: "Extract invoice",
		description: "Parse Chinese 全电/增值税发票 XML and persist header + line items to the mailbox database.",
	},
] as const;

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
		return {
			name: typeof r?.name === "string" ? r.name : "",
			enabled: r?.enabled !== false,
			from: typeof cond.from === "string" ? cond.from : "",
			fromDomain: typeof cond.fromDomain === "string" ? cond.fromDomain : "",
			to: typeof cond.to === "string" ? cond.to : "",
			subjectContains: arrayToCsv(cond.subjectContains),
			bodyContains: arrayToCsv(cond.bodyContains),
			hasAttachmentExt: arrayToCsv(cond.hasAttachmentExt),
			skipDraft: act.skipDraft === true,
			moveTo: typeof act.moveTo === "string" ? act.moveTo : "",
			markRead: act.markRead === true,
			extractAttachmentText: act.extractAttachmentText === true,
			extractInvoice: act.extractInvoice === true,
			promptOverride: typeof act.promptOverride === "string" ? act.promptOverride : "",
			actions: Array.isArray(act.actions)
				? (act.actions as unknown[]).flatMap((a) => {
					if (!a || typeof a !== "object") return [];
					const raw = a as { capabilityId?: unknown; params?: unknown };
					if (typeof raw.capabilityId !== "string") return [];
					return [{
						capabilityId: raw.capabilityId,
						params: (raw.params && typeof raw.params === "object"
							? (raw.params as Record<string, unknown>)
							: {}),
					}];
				})
				: [],
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
			const act: Record<string, unknown> = { ...r._unknownThen };
			if (r.skipDraft) act.skipDraft = true;
			if (r.moveTo) act.moveTo = r.moveTo;
			if (r.markRead) act.markRead = true;
			if (r.extractAttachmentText) act.extractAttachmentText = true;
			if (r.extractInvoice) act.extractInvoice = true;
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
	const updateMailboxMutation = useUpdateMailbox();
	const { data: modelsData, isLoading: modelsLoading } = useModels();
	const modelOptions = modelsData?.models ?? [];
	const serverDefaultModel = modelsData?.default ?? null;
	const { data: whoamiTop } = useWhoami();
	const isAdminUser = !!whoamiTop?.isAdmin;
	const visibleTabs = SETTINGS_TABS.filter((t) => !t.adminOnly || isAdminUser);

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
								const activeModel = activeAgent.id === "invoice" ? invoiceModel : emailReplyModel;
								const setActiveModel = activeAgent.id === "invoice" ? setInvoiceModel : setEmailReplyModel;
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
												{m.id}{m.owned_by ? ` — ${m.owned_by}` : ""}
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
									rows={activeAgent.id === "invoice" ? 10 : 12}
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
													value={r}
													onChange={(patch) => updateRule(idx, patch)}
												/>
												<div>
													<label className="block text-[10px] text-kumo-subtle mb-0.5">Move to folder</label>
													<select
														value={r.moveTo}
														onChange={(e) => updateRule(idx, { moveTo: e.target.value })}
														className="w-full rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default"
													>
														{MOVE_OPTIONS.map((o) => (
															<option key={o.value} value={o.value}>{o.label}</option>
														))}
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

				{/* ── System tab (admin-only) ── */}
				{activeTab === "system" && isAdminUser && <LlmProvidersCard />}

				{/* Save (covers Account / Agents / Rules — Members + System have their own actions) */}
				{activeTab !== "members" && activeTab !== "system" && (
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
				{isOwner ? (
					<Badge variant="primary">Owner</Badge>
				) : (
					<Badge variant="secondary">Read-only (member)</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-3">
				Members (with equal rw access) must already be allowed by the
				Cloudflare Access policy. Only the owner can add or remove
				members, or issue invite links.
			</p>

			{isLoading ? (
				<div className="flex justify-center py-4"><Loader size="sm" /></div>
			) : (
				<div className="space-y-2 mb-4">
					<div className="flex items-center justify-between text-xs text-kumo-default bg-kumo-recessed px-3 py-2 rounded">
						<span className="truncate">{members?.owner ?? "(no owner yet)"}</span>
						<Badge variant="primary">owner</Badge>
					</div>
					{(members?.members ?? []).map((m) => (
						<div key={m} className="flex items-center justify-between text-xs text-kumo-default bg-kumo-recessed px-3 py-2 rounded">
							<span className="truncate">{m}</span>
							{isOwner && (
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

			{isOwner && (
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
// Multi-select Combobox covering the four boolean rule actions that ride
// on legacy top-level `then.*` fields (skipDraft / markRead /
// extractAttachmentText / extractInvoice). Replaces what used to be four
// stacked checkboxes — same data shape on the wire, more compact UI, room
// to grow as new no-arg actions land.

function RuleThenActionsPicker({
	value,
	onChange,
}: {
	value: Pick<UIRule, ThenActionId>;
	onChange: (patch: Partial<UIRule>) => void;
}) {
	const selected = THEN_ACTION_OPTIONS.filter((o) => value[o.id]);
	return (
		<Combobox
			multiple
			items={THEN_ACTION_OPTIONS as unknown as ThenActionOption[]}
			value={selected}
			onValueChange={(next: unknown) => {
				const arr = Array.isArray(next) ? (next as ThenActionOption[]) : [];
				const ids = new Set(arr.map((o) => o.id));
				onChange({
					skipDraft: ids.has("skipDraft"),
					markRead: ids.has("markRead"),
					extractAttachmentText: ids.has("extractAttachmentText"),
					extractInvoice: ids.has("extractInvoice"),
				});
			}}
		>
			<Combobox.TriggerMultipleWithInput<ThenActionOption>
				placeholder={selected.length === 0 ? "Pick actions…" : "Add another…"}
				renderItem={(item) => <Combobox.Chip>{item.label}</Combobox.Chip>}
			/>
			<Combobox.Content>
				<Combobox.List>
					{((item: ThenActionOption) => (
						<Combobox.Item key={item.id} value={item}>
							<div>
								<div className="text-xs">{item.label}</div>
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
// Editable list of capability invocations attached to a rule's `then.actions`
// list. Sits below the legacy "Skip auto-draft / Mark as read / Move to /
// Prompt addon" controls — those still emit their respective Capability
// invocations on the backend via the legacy translator, so the user only
// reaches for this section when they need something the legacy fields don't
// cover (webhook, future capabilities).

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
	const selectableCaps = allCaps.filter((c) => c.id !== "core:skip-draft");

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

// ── LlmProvidersCard ───────────────────────────────────────────────
//
// Admin-only registry of OpenAI-compatible LLM endpoints. Exactly one row may
// carry isDefault=1 and that's the provider EmailAgent / InvoiceAgent stream
// against. When the table is empty the worker falls back to the env-var
// configuration (LLM_BASE_URL / LLM_API_KEY / LLM_DEFAULT_MODEL).

interface LlmProviderPublic {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyMasked: string;
	defaultModel: string;
	enabled: boolean;
	isDefault: boolean;
	createdAt: number;
	updatedAt: number;
}

function LlmProvidersCard() {
	const toastManager = useKumoToastManager();
	const qc = useQueryClient();
	const { data: providers, isLoading } = useQuery({
		queryKey: queryKeys.adminLlmProviders,
		queryFn: () => api.adminListLlmProviders(),
	});

	const [editing, setEditing] = useState<LlmProviderPublic | null>(null);
	const [creating, setCreating] = useState(false);

	const refetch = () => {
		qc.invalidateQueries({ queryKey: queryKeys.adminLlmProviders });
		// Stale model dropdown caches need to drop too — switching the default
		// provider changes the catalog seen by the Settings → Agents tab.
		qc.invalidateQueries({ queryKey: queryKeys.models });
	};

	const handleDelete = async (p: LlmProviderPublic) => {
		if (!confirm(`Delete provider "${p.name}"?`)) return;
		try {
			await api.adminDeleteLlmProvider(p.id);
			toastManager.add({ title: `Deleted ${p.name}` });
			refetch();
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Delete failed",
				variant: "error",
			});
		}
	};

	const handleSetDefault = async (p: LlmProviderPublic) => {
		try {
			await api.adminUpdateLlmProvider(p.id, { makeDefault: true });
			toastManager.add({ title: `${p.name} is now the default` });
			refetch();
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Failed",
				variant: "error",
			});
		}
	};

	const handleTest = async (p: LlmProviderPublic) => {
		try {
			const res = await api.adminTestLlmProvider(p.id);
			toastManager.add({
				title: res.ok
					? `${p.name}: ${res.modelCount} models reachable`
					: `${p.name}: connection failed`,
				variant: res.ok ? "default" : "error",
			});
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Test failed",
				variant: "error",
			});
		}
	};

	return (
		<div className="bg-kumo-base border border-kumo-line rounded-lg p-4 space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<GearSixIcon size={16} />
					<span className="text-sm font-medium text-kumo-default">LLM providers</span>
				</div>
				<Button
					variant="primary"
					size="sm"
					icon={<PlusIcon size={14} />}
					onClick={() => { setCreating(true); setEditing(null); }}
				>
					Add provider
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle">
				OpenAI-compatible endpoints (LiteLLM, OpenRouter, vendor APIs). Exactly one
				provider can be marked as default — that's the one EmailAgent / InvoiceAgent
				route to. When the list is empty the worker falls back to the
				<code className="px-1 py-0.5 mx-1 rounded bg-kumo-recessed">LLM_BASE_URL</code>
				env var configuration.
			</p>

			{(creating || editing) && (
				<LlmProviderForm
					initial={editing}
					onClose={() => { setEditing(null); setCreating(false); }}
					onSaved={() => { setEditing(null); setCreating(false); refetch(); }}
				/>
			)}

			{isLoading ? (
				<div className="flex justify-center py-4"><Loader size="sm" /></div>
			) : !providers || providers.length === 0 ? (
				<p className="text-xs text-kumo-subtle italic">
					No providers configured. Worker is using <code>LLM_BASE_URL</code> env var.
				</p>
			) : (
				<div className="overflow-x-auto rounded border border-kumo-line">
					<table className="min-w-full text-xs">
						<thead className="bg-kumo-recessed text-kumo-subtle uppercase tracking-wide text-[10px]">
							<tr>
								<th className="px-3 py-2 text-left">Name</th>
								<th className="px-3 py-2 text-left">Endpoint</th>
								<th className="px-3 py-2 text-left">Default model</th>
								<th className="px-3 py-2 text-left">API key</th>
								<th className="px-3 py-2 text-left">Status</th>
								<th className="px-3 py-2" />
							</tr>
						</thead>
						<tbody>
							{providers.map((p) => (
								<tr key={p.id} className="border-t border-kumo-line">
									<td className="px-3 py-2 font-medium text-kumo-default">{p.name}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle break-all">{p.baseUrl}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle">{p.defaultModel}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle">{p.apiKeyMasked}</td>
									<td className="px-3 py-2">
										<div className="flex items-center gap-1">
											{p.isDefault && <Badge variant="success">default</Badge>}
											{!p.enabled && <Badge variant="secondary">disabled</Badge>}
										</div>
									</td>
									<td className="px-3 py-2 text-right">
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="xs"
												onClick={() => handleTest(p)}
												aria-label={`Test ${p.name}`}
											>
												Test
											</Button>
											{!p.isDefault && (
												<Button
													variant="ghost"
													size="xs"
													onClick={() => handleSetDefault(p)}
												>
													Set default
												</Button>
											)}
											<Button
												variant="ghost"
												size="xs"
												onClick={() => { setEditing(p); setCreating(false); }}
											>
												Edit
											</Button>
											<Button
												variant="ghost"
												size="xs"
												icon={<TrashIcon size={14} />}
												onClick={() => handleDelete(p)}
												aria-label={`Delete ${p.name}`}
											>
												Delete
											</Button>
										</div>
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

function LlmProviderForm({
	initial,
	onClose,
	onSaved,
}: {
	initial: LlmProviderPublic | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const toastManager = useKumoToastManager();
	const isEdit = !!initial;
	const [name, setName] = useState(initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
	const [enabled, setEnabled] = useState(initial?.enabled ?? true);
	const [makeDefault, setMakeDefault] = useState(initial?.isDefault ?? !isEdit);
	const [saving, setSaving] = useState(false);
	const [discoveredModels, setDiscoveredModels] = useState<string[]>(() =>
		// On open in edit mode, seed with the saved default model so the
		// dropdown isn't empty before the first /v1/models round-trip lands.
		initial?.defaultModel ? [initial.defaultModel] : [],
	);
	const [discovering, setDiscovering] = useState(false);

	const handleDiscover = async () => {
		setDiscovering(true);
		try {
			let modelIds: string[];
			if (isEdit && initial && !apiKey.trim()) {
				// Edit mode without a fresh key entered — use the stored creds via
				// the per-id test endpoint.
				const res = await api.adminTestLlmProvider(initial.id);
				modelIds = res.modelIds;
			} else {
				const u = baseUrl.trim();
				if (!u) {
					toastManager.add({ title: "Endpoint URL is required first", variant: "error" });
					return;
				}
				if (!apiKey.trim() && !isEdit) {
					toastManager.add({ title: "API key is required first", variant: "error" });
					return;
				}
				const res = await api.adminDiscoverLlmModels(u, apiKey);
				modelIds = res.models.map((m) => m.id);
			}
			if (modelIds.length === 0) {
				toastManager.add({ title: "Endpoint reachable but returned no models", variant: "error" });
				return;
			}
			setDiscoveredModels(modelIds);
			// Auto-pick the existing default if it exists in the catalog,
			// otherwise leave whatever the user typed.
			if (defaultModel && !modelIds.includes(defaultModel)) {
				toastManager.add({
					title: `Current model "${defaultModel}" is not in the endpoint's catalog`,
				});
			}
			toastManager.add({ title: `Found ${modelIds.length} models` });
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Discover failed",
				variant: "error",
			});
		} finally {
			setDiscovering(false);
		}
	};

	// Auto-discover on open for edit mode (uses stored creds, no extra typing).
	useEffect(() => {
		if (!isEdit || !initial) return;
		void handleDiscover();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleSubmit = async () => {
		const n = name.trim();
		const u = baseUrl.trim();
		const m = defaultModel.trim();
		if (!n || !u || !m) {
			toastManager.add({ title: "Name, endpoint and default model are required", variant: "error" });
			return;
		}
		if (!isEdit && !apiKey.trim()) {
			toastManager.add({ title: "API key is required for new providers", variant: "error" });
			return;
		}
		setSaving(true);
		try {
			if (isEdit && initial) {
				await api.adminUpdateLlmProvider(initial.id, {
					name: n,
					baseUrl: u,
					...(apiKey ? { apiKey } : {}),
					defaultModel: m,
					enabled,
					makeDefault,
				});
			} else {
				await api.adminCreateLlmProvider({
					name: n,
					baseUrl: u,
					apiKey: apiKey,
					defaultModel: m,
					enabled,
					makeDefault,
				});
			}
			toastManager.add({ title: isEdit ? `Updated ${n}` : `Added ${n}` });
			onSaved();
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Save failed",
				variant: "error",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="rounded border border-kumo-line bg-kumo-recessed p-3 space-y-3">
			<div className="text-sm font-medium text-kumo-default">
				{isEdit ? `Edit "${initial!.name}"` : "Add LLM provider"}
			</div>
			<Input
				label="Name"
				placeholder="e.g. LiteLLM main"
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<Input
				label="Endpoint base URL"
				placeholder="https://litellm.example.com"
				value={baseUrl}
				onChange={(e) => setBaseUrl(e.target.value)}
			/>
			<Input
				label={isEdit ? "API key (leave blank to keep current)" : "API key"}
				type="password"
				placeholder={isEdit ? initial?.apiKeyMasked ?? "" : "sk-..."}
				value={apiKey}
				onChange={(e) => setApiKey(e.target.value)}
				autoComplete="new-password"
			/>
			<div>
				<div className="flex items-end justify-between gap-2 mb-1">
					<label className="block text-xs text-kumo-subtle">Default model</label>
					<button
						type="button"
						onClick={handleDiscover}
						disabled={discovering || !baseUrl.trim() || (!isEdit && !apiKey.trim())}
						className="text-[11px] text-kumo-link hover:underline disabled:opacity-40 disabled:no-underline"
					>
						{discovering ? "Discovering…" : "Discover from /v1/models"}
					</button>
				</div>
				{discoveredModels.length > 0 ? (
					<select
						value={defaultModel}
						onChange={(e) => setDefaultModel(e.target.value)}
						className="w-full bg-kumo-base border border-kumo-line rounded px-2 py-1 text-xs text-kumo-default"
					>
						<option value="">(none — pick one)</option>
						{defaultModel && !discoveredModels.includes(defaultModel) && (
							<option value={defaultModel}>{defaultModel} (not in catalog)</option>
						)}
						{discoveredModels.map((m) => (
							<option key={m} value={m}>{m}</option>
						))}
					</select>
				) : (
					<Input
						placeholder="e.g. glm-5.1 — or fill base URL + key, then click Discover"
						value={defaultModel}
						onChange={(e) => setDefaultModel(e.target.value)}
					/>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<label className="flex items-center gap-2 text-xs text-kumo-default">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
					/>
					Enabled
				</label>
				<label className="flex items-center gap-2 text-xs text-kumo-default">
					<input
						type="checkbox"
						checked={makeDefault}
						onChange={(e) => setMakeDefault(e.target.checked)}
					/>
					Set as default
				</label>
			</div>
			<div className="flex justify-end gap-2 pt-1">
				<Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
				<Button variant="primary" size="sm" onClick={handleSubmit} loading={saving}>
					{isEdit ? "Save" : "Add provider"}
				</Button>
			</div>
		</div>
	);
}

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
