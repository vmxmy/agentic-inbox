// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon,
	CopyIcon,
	FunnelIcon,
	LinkIcon,
	PlusIcon,
	ReceiptIcon,
	RobotIcon,
	TrashIcon,
	UsersIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useWhoami } from "~/queries/identity";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import {
	useAddMember,
	useCreateInvite,
	useMembers,
	useRemoveMember,
} from "~/queries/members";

// ── Models (keep in sync with workers/lib/agent-config.ts ALLOWED_AGENT_MODELS) ──
const MODEL_OPTIONS: { value: string; label: string }[] = [
	{ value: "@cf/moonshotai/kimi-k2.5",                  label: "Kimi K2.5 (default, Moonshot AI)" },
	{ value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",  label: "Llama 3.3 70B (Meta)" },
	{ value: "@cf/qwen/qwen2.5-coder-32b-instruct",       label: "Qwen 2.5 Coder 32B" },
];
const DEFAULT_MODEL = MODEL_OPTIONS[0].value;

// ── Rule types (mirror workers/lib/rules.ts) ──
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
	promptOverride: string;
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
	promptOverride: "",
};
const MOVE_OPTIONS = [
	{ value: "",        label: "(keep in inbox)" },
	{ value: "inbox",   label: "Inbox (no-op)" },
	{ value: "archive", label: "Archive" },
	{ value: "trash",   label: "Trash" },
	{ value: "spam",    label: "Spam" },
];

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
			promptOverride: typeof act.promptOverride === "string" ? act.promptOverride : "",
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
			const act: Record<string, unknown> = {};
			if (r.skipDraft) act.skipDraft = true;
			if (r.moveTo) act.moveTo = r.moveTo;
			if (r.markRead) act.markRead = true;
			if (r.extractAttachmentText) act.extractAttachmentText = true;
			if (r.promptOverride.trim()) act.promptOverride = r.promptOverride.trim();
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

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [invoicePrompt, setInvoicePrompt] = useState("");
	const [autoDraft, setAutoDraft] = useState(true);
	const [agentModel, setAgentModel] = useState<string>(DEFAULT_MODEL);
	const [rules, setRules] = useState<UIRule[]>([]);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setInvoicePrompt(mailbox.settings?.invoiceAgentSystemPrompt || "");
			setAutoDraft((mailbox.settings as Record<string, unknown> | undefined)?.autoDraft !== false);
			const rawModel = (mailbox.settings as Record<string, unknown> | undefined)?.agentModel;
			setAgentModel(
				typeof rawModel === "string" && MODEL_OPTIONS.some((m) => m.value === rawModel)
					? rawModel
					: DEFAULT_MODEL,
			);
			setRules(loadRulesFromSettings(mailbox.settings as Record<string, unknown> | undefined));
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
			agentModel,
			rules: dumpRulesForSave(rules),
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

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	const handleResetInvoicePrompt = () => {
		setInvoicePrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;
	const isCustomInvoicePrompt = invoicePrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Agent Behavior: auto-draft toggle + model selector */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-4">
						<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">Agent Behavior</span>
					</div>

					<label className="flex items-start gap-3 cursor-pointer py-2">
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
								into Drafts (you still review & send). When off, the agent only
								responds in the side panel when you ask.
							</span>
						</span>
					</label>

					<div className="mt-4">
						<label className="block text-xs font-medium text-kumo-default mb-1.5">Model</label>
						<select
							value={agentModel}
							onChange={(e) => setAgentModel(e.target.value)}
							className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
						>
							{MODEL_OPTIONS.map((m) => (
								<option key={m.value} value={m.value}>{m.label}</option>
							))}
						</select>
						<p className="text-xs text-kumo-subtle mt-1.5">
							All models run on Cloudflare Workers AI (pay-per-neuron). Tool
							calling support varies; swap if drafts look off.
						</p>
					</div>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Invoice Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<ReceiptIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								Invoice Agent Prompt
							</span>
							{isCustomInvoicePrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomInvoicePrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetInvoicePrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						System prompt for the Invoice Agent chat (separate from the email
						agent). The agent has invoice / bundle tools wired in — list,
						search, create / update / delete bundles, manage membership, and
						re-run extraction. Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={invoicePrompt}
						onChange={(e) => setInvoicePrompt(e.target.value)}
						placeholder={INVOICE_PROMPT_PLACEHOLDER}
						rows={10}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						Stored as <code>invoiceAgentSystemPrompt</code> on the mailbox
						settings blob. The InvoiceAgent reads it via
						<code> getAgentConfig</code> on every chat turn.
					</p>
				</div>

				{/* Processing Rules */}
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
											<label className="flex items-center gap-2 text-xs text-kumo-default">
												<input
													type="checkbox"
													className="h-3.5 w-3.5 accent-kumo-primary"
													checked={r.skipDraft}
													onChange={(e) => updateRule(idx, { skipDraft: e.target.checked })}
												/>
												Skip auto-draft
											</label>
											<label className="flex items-center gap-2 text-xs text-kumo-default">
												<input
													type="checkbox"
													className="h-3.5 w-3.5 accent-kumo-primary"
													checked={r.markRead}
													onChange={(e) => updateRule(idx, { markRead: e.target.checked })}
												/>
												Mark as read
											</label>
											<label className="flex items-start gap-2 text-xs text-kumo-default">
												<input
													type="checkbox"
													className="mt-0.5 h-3.5 w-3.5 accent-kumo-primary"
													checked={r.extractAttachmentText}
													onChange={(e) => updateRule(idx, { extractAttachmentText: e.target.checked })}
												/>
												<span>
													<span className="block">Extract attachment text</span>
													<span className="block text-[10px] text-kumo-subtle">
														XML parsed inline (incl. 全电发票). PDF OCR — coming next.
													</span>
												</span>
											</label>
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
										</div>
									</div>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>

				{/* Members & Invites */}
				{mailboxId && <MembersCard mailboxId={mailboxId} />}
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
						<div className="flex items-center justify-between">
							<span className="text-xs text-kumo-subtle">
								Or share a 7-day invite link (recipient must pass Access)
							</span>
							<Button
								variant="ghost"
								size="xs"
								icon={<LinkIcon size={14} />}
								onClick={handleInvite}
								loading={createInvite.isPending}
							>
								Generate invite link
							</Button>
						</div>
						{inviteUrl && (
							<div className="mt-2 flex items-center gap-2">
								<Input
									value={inviteUrl}
									readOnly
									onFocus={(e) => e.currentTarget.select()}
								/>
								<Button
									variant="secondary"
									size="sm"
									icon={<CopyIcon size={14} />}
									onClick={handleCopy}
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
