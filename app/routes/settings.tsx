// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	RobotIcon,
	ArrowCounterClockwiseIcon,
	WrenchIcon,
	ShieldIcon,
	LockIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import {
	useInboxAgentConfig,
	useInboxAgentConfigOptions,
	useMailbox,
	useUpdateInboxAgentConfig,
	useUpdateMailbox,
} from "~/queries/mailboxes";
import { ApiError } from "~/services/api";
import {
	INBOX_AGENT_CONFIG_SCHEMA_VERSION,
	type AgentSafetyPolicy,
	type InboxAgentConfigPatch,
} from "~/types";

const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const isUserOwned = !!mailbox?.userOwnedInbox;

	const optionsQuery = useInboxAgentConfigOptions(isUserOwned);
	const configQuery = useInboxAgentConfig(mailboxId, isUserOwned);
	const updateConfigMutation = useUpdateInboxAgentConfig();

	// Account fields (used for both legacy and user-owned)
	const [displayName, setDisplayName] = useState("");
	const [legacyAgentPrompt, setLegacyAgentPrompt] = useState("");
	const [isSavingAccount, setIsSavingAccount] = useState(false);

	// Agent config form state
	const [agentDisplayName, setAgentDisplayName] = useState("");
	const [modelId, setModelId] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [inboundAutoDraftEnabled, setInboundAutoDraftEnabled] = useState(true);
	const [enabledToolIds, setEnabledToolIds] = useState<string[]>([]);
	const [safety, setSafety] = useState<AgentSafetyPolicy | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [isSavingConfig, setIsSavingConfig] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setLegacyAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	useEffect(() => {
		if (configQuery.data) {
			const c = configQuery.data;
			setAgentDisplayName(c.agent.displayName);
			setModelId(c.agent.modelId);
			setSystemPrompt(c.agent.systemPrompt || "");
			setInboundAutoDraftEnabled(c.agent.automation.inboundAutoDraftEnabled);
			setEnabledToolIds(c.tools.enabledToolIds);
			setSafety(c.safety);
			setConfigError(null);
		}
	}, [configQuery.data]);

	const handleSaveAccount = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSavingAccount(true);
		const settings: Record<string, unknown> = {
			...mailbox.settings,
			fromName: displayName,
		};
		// Only legacy mailboxes still write agentSystemPrompt this way.
		if (!isUserOwned) {
			settings.agentSystemPrompt = legacyAgentPrompt.trim() || undefined;
		}
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({ title: "Failed to save settings", variant: "error" });
		} finally {
			setIsSavingAccount(false);
		}
	};

	const handleResetLegacyPrompt = () => setLegacyAgentPrompt("");

	const toggleTool = (id: string, on: boolean) => {
		setEnabledToolIds((prev) => {
			const set = new Set(prev);
			if (on) set.add(id);
			else set.delete(id);
			return Array.from(set);
		});
	};

	const updateSafety = (patch: Partial<AgentSafetyPolicy>) => {
		setSafety((prev) => (prev ? { ...prev, ...patch } : prev));
	};

	const resetAgentDefaults = () => {
		const options = optionsQuery.data;
		if (!options) return;
		setAgentDisplayName(options.defaults.agentDisplayName);
		setModelId(options.defaultModelId);
		setSystemPrompt(options.defaults.systemPrompt);
		setInboundAutoDraftEnabled(options.defaults.automation.inboundAutoDraftEnabled);
		setConfigError(null);
	};

	const resetToolDefaults = () => {
		const options = optionsQuery.data;
		if (!options) return;
		setEnabledToolIds([...options.defaultEnabledToolIds]);
		setConfigError(null);
	};

	const resetSafetyDefaults = () => {
		const options = optionsQuery.data;
		if (!options) return;
		setSafety({ ...options.safety.defaults });
		setConfigError(null);
	};

	const resetAllDefaults = () => {
		resetAgentDefaults();
		resetToolDefaults();
		resetSafetyDefaults();
	};

	const handleSaveConfig = async () => {
		if (!mailboxId || !configQuery.data || !safety) return;
		setIsSavingConfig(true);
		setConfigError(null);
		const original = configQuery.data;

		const patch: InboxAgentConfigPatch = {
			schemaVersion: INBOX_AGENT_CONFIG_SCHEMA_VERSION,
			expectedRevision: original.revision,
		};

		const agentPatch: NonNullable<InboxAgentConfigPatch["agent"]> = {};
		if (agentDisplayName !== original.agent.displayName) {
			agentPatch.displayName = agentDisplayName;
		}
		if (modelId !== original.agent.modelId) agentPatch.modelId = modelId;
		if (systemPrompt !== (original.agent.systemPrompt ?? "")) {
			agentPatch.systemPrompt = systemPrompt;
		}
		if (inboundAutoDraftEnabled !== original.agent.automation.inboundAutoDraftEnabled) {
			agentPatch.automation = { inboundAutoDraftEnabled };
		}
		if (Object.keys(agentPatch).length > 0) patch.agent = agentPatch;

		const sortedNew = [...enabledToolIds].sort();
		const sortedOld = [...original.tools.enabledToolIds].sort();
		if (
			original.tools.usingDefaultPreset ||
			sortedNew.length !== sortedOld.length ||
			sortedNew.some((id, i) => id !== sortedOld[i])
		) {
			patch.tools = { enabledToolIds: enabledToolIds };
		}

		const safetyPatch: Partial<AgentSafetyPolicy> = {};
		(["promptInjectionScanEnabled", "threadContextScanEnabled", "draftVerificationEnabled"] as const).forEach((k) => {
			if (safety[k] !== original.safety[k]) safetyPatch[k] = safety[k];
		});
		if (safety.level !== original.safety.level) safetyPatch.level = safety.level;
		if (Object.keys(safetyPatch).length > 0) patch.safety = safetyPatch;

		try {
			await updateConfigMutation.mutateAsync({ mailboxId, patch });
			toastManager.add({ title: "Agent configuration saved!" });
		} catch (e) {
			if (e instanceof ApiError) {
				if (e.status === 409 && e.body?.code === "revision_conflict") {
					setConfigError(
						"This inbox configuration was changed elsewhere. The latest values have been reloaded.",
					);
					await configQuery.refetch();
				} else {
					const errors = (e.body?.errors as Array<{ message: string }> | undefined) ?? [];
					setConfigError(errors[0]?.message || e.message);
				}
			} else {
				setConfigError("Failed to save configuration. Please try again.");
			}
			toastManager.add({
				title: "Failed to save configuration",
				variant: "error",
			});
		} finally {
			setIsSavingConfig(false);
		}
	};

	const sortedTools = useMemo(() => {
		const tools = optionsQuery.data?.tools ?? [];
		return [...tools].sort((a, b) => {
			if (a.editable !== b.editable) return a.editable ? -1 : 1;
			return a.displayName.localeCompare(b.displayName);
		});
	}, [optionsQuery.data]);

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isLegacyCustomPrompt = legacyAgentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">Account</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
					<div className="flex justify-end mt-4">
						<Button
							variant="primary"
							onClick={handleSaveAccount}
							loading={isSavingAccount}
						>
							Save account
						</Button>
					</div>
				</div>

				{/* Legacy mailbox: keep the old freeform agent prompt UI */}
				{!isUserOwned && (
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
						<div className="flex items-center justify-between mb-4">
							<div className="flex items-center gap-2">
								<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
								<span className="text-sm font-medium text-kumo-default">
									AI Agent Prompt
								</span>
								{isLegacyCustomPrompt ? (
									<Badge variant="primary">Custom</Badge>
								) : (
									<Badge variant="secondary">Default</Badge>
								)}
							</div>
							{isLegacyCustomPrompt && (
								<Button
									variant="ghost"
									size="xs"
									icon={<ArrowCounterClockwiseIcon size={14} />}
									onClick={handleResetLegacyPrompt}
								>
									Reset to default
								</Button>
							)}
						</div>
						<p className="text-xs text-kumo-subtle mb-3">
							Customize how the AI agent behaves for this mailbox. Leave empty to
							use the built-in default prompt.
						</p>
						<textarea
							value={legacyAgentPrompt}
							onChange={(e) => setLegacyAgentPrompt(e.target.value)}
							placeholder={PROMPT_PLACEHOLDER}
							rows={12}
							className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
						/>
						<p className="text-xs text-kumo-subtle mt-2">
							Tools and safety controls are only available for inboxes you create
							yourself. Save with the Account section above.
						</p>
					</div>
				)}

				{/* User-owned: structured Agent / Tools / Safety controls */}
				{isUserOwned && (
					<>
						{configQuery.isLoading || optionsQuery.isLoading ? (
							<div className="flex justify-center py-10">
								<Loader size="base" />
							</div>
						) : configQuery.data && optionsQuery.data && safety ? (
							<>
								{/* Agent */}
								<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
									<div className="flex items-center justify-between gap-3 mb-4">
										<div className="flex items-center gap-2">
											<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
											<span className="text-sm font-medium text-kumo-default">Agent</span>
											{configQuery.data.agent.modelDeprecated && (
												<Badge variant="destructive">Model deprecated</Badge>
											)}
										</div>
										<Button
											variant="ghost"
											size="xs"
											icon={<ArrowCounterClockwiseIcon size={14} />}
											onClick={resetAgentDefaults}
										>
											Reset
										</Button>
									</div>

									<div className="mb-4">
										<Input
											label="Agent Name"
											value={agentDisplayName}
											onChange={(e) => setAgentDisplayName(e.target.value)}
										/>
									</div>

									<label className="block text-xs font-medium text-kumo-default mb-1">
										Model
									</label>
									<select
										value={modelId}
										onChange={(e) => setModelId(e.target.value)}
										className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
									>
										{optionsQuery.data.models.map((m) => (
											<option key={m.id} value={m.id}>
												{m.displayName}
											</option>
										))}
										{!optionsQuery.data.models.some((m) => m.id === modelId) && (
											<option value={modelId}>{modelId} (current)</option>
										)}
									</select>

									<label className="flex items-center gap-2 mt-4 text-sm text-kumo-default">
										<input
											type="checkbox"
											checked={inboundAutoDraftEnabled}
											onChange={(e) => setInboundAutoDraftEnabled(e.target.checked)}
										/>
										Auto-draft replies for inbound mail
									</label>

									<label className="block text-xs font-medium text-kumo-default mt-4 mb-1">
										System prompt
									</label>
									<textarea
										value={systemPrompt}
										onChange={(e) => setSystemPrompt(e.target.value)}
										placeholder={PROMPT_PLACEHOLDER}
										rows={10}
										className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
									/>
								</div>

								{/* Tools */}
								<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
									<div className="flex items-center justify-between gap-3 mb-3">
										<div className="flex items-center gap-2">
											<WrenchIcon size={16} weight="duotone" className="text-kumo-subtle" />
											<span className="text-sm font-medium text-kumo-default">Tools</span>
											{configQuery.data.tools.usingDefaultPreset && (
												<Badge variant="secondary">Default preset</Badge>
											)}
										</div>
										<Button
											variant="ghost"
											size="xs"
											icon={<ArrowCounterClockwiseIcon size={14} />}
											onClick={resetToolDefaults}
										>
											Reset
										</Button>
									</div>
									<p className="text-xs text-kumo-subtle mb-3">
										Toggle which tools the agent may call. Sending mail directly is
										locked off in this phase - drafts only.
									</p>
									<div className="space-y-2">
										{sortedTools.map((tool) => {
											const checked = enabledToolIds.includes(tool.id);
											const disabled = !tool.editable;
											return (
												<label
													key={tool.id}
													className={`flex items-start gap-3 rounded border border-kumo-line px-3 py-2 ${disabled ? "opacity-60" : ""}`}
												>
													<input
														type="checkbox"
														className="mt-1"
														disabled={disabled}
														checked={disabled ? false : checked}
														onChange={(e) => toggleTool(tool.id, e.target.checked)}
													/>
													<div className="flex-1">
														<div className="flex items-center gap-2 text-sm text-kumo-default">
															<span>{tool.displayName}</span>
															{disabled && (
																<span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-kumo-subtle">
																	<LockIcon size={10} /> {tool.lockReason ?? "locked"}
																</span>
															)}
														</div>
														<div className="text-xs text-kumo-subtle">
															{tool.description}
														</div>
													</div>
												</label>
											);
										})}
									</div>
								</div>

								{/* Safety */}
								<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
									<div className="flex items-center justify-between gap-3 mb-3">
										<div className="flex items-center gap-2">
											<ShieldIcon size={16} weight="duotone" className="text-kumo-subtle" />
											<span className="text-sm font-medium text-kumo-default">Safety</span>
										</div>
										<Button
											variant="ghost"
											size="xs"
											icon={<ArrowCounterClockwiseIcon size={14} />}
											onClick={resetSafetyDefaults}
										>
											Reset
										</Button>
									</div>
									<label className="block text-xs font-medium text-kumo-default mb-1">
										Level
									</label>
									<select
										value={safety.level}
										onChange={(e) =>
											updateSafety({
												level: e.target.value as AgentSafetyPolicy["level"],
											})
										}
										className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
									>
										{optionsQuery.data.safety.levels.map((l) => (
											<option key={l.id} value={l.id}>
												{l.displayName}
											</option>
										))}
									</select>
									<p className="text-xs text-kumo-subtle mt-1">
										{optionsQuery.data.safety.levels.find((l) => l.id === safety.level)?.description}
									</p>

									<div className="space-y-2 mt-4">
										<label className="flex items-center gap-2 text-sm text-kumo-default">
											<input
												type="checkbox"
												checked={safety.promptInjectionScanEnabled}
												onChange={(e) =>
													updateSafety({ promptInjectionScanEnabled: e.target.checked })
												}
											/>
											Scan inbound email bodies for prompt injection
										</label>
										<label className="flex items-center gap-2 text-sm text-kumo-default">
											<input
												type="checkbox"
												checked={safety.threadContextScanEnabled}
												onChange={(e) =>
													updateSafety({ threadContextScanEnabled: e.target.checked })
												}
											/>
											Scan thread history for prompt injection
										</label>
										<label className="flex items-center gap-2 text-sm text-kumo-default">
											<input
												type="checkbox"
												checked={safety.draftVerificationEnabled}
												onChange={(e) =>
													updateSafety({ draftVerificationEnabled: e.target.checked })
												}
											/>
											Verify drafts before saving
										</label>
									</div>
								</div>

								{configError && (
									<div className="rounded border border-kumo-danger bg-kumo-danger-recessed p-3 text-sm text-kumo-danger">
										{configError}
									</div>
								)}

								<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
									<Button
										variant="secondary"
										onClick={resetAllDefaults}
									>
										Reset all to defaults
									</Button>
									<Button
										variant="primary"
										onClick={handleSaveConfig}
										loading={isSavingConfig}
									>
										Save agent configuration
									</Button>
								</div>
							</>
						) : (
							<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 text-sm text-kumo-subtle">
								Agent configuration is unavailable for this inbox.
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
