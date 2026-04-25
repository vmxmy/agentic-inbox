// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * UnifiedAgentPanel — single chat surface routing to multiple agents via
 * @-mention. Replaces AgentPanel + InvoicePanel.
 *
 * Architecture:
 *   - Two `useAgent` connections kept open simultaneously (EmailAgent +
 *     InvoiceAgent). Both `useAgentChat` hooks produce independent
 *     `UIMessage[]` arrays.
 *   - Messages from both agents are tagged with their `agentId` and merged
 *     into a single timeline sorted by createdAt.
 *   - The composer (`MentionAutocomplete`) lets the user pick an agent via
 *     `@`. Without an explicit chip, the message routes to the last-used
 *     agent (or DEFAULT_AGENT_ID on first send).
 *   - Each `MessageBubble` looks up its agent's avatar / tool labels /
 *     `renderActions` from the registry — adding a third agent is a registry
 *     edit + a new useAgent call here.
 *
 * Trade-off: each agent has its own chat history; one agent can't see what
 * was just discussed in the other. Documented in the empty-state hint.
 */

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	StopIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import type { UIMessage } from "ai";
import { useUIStore } from "~/hooks/useUIStore";
import {
	AGENTS,
	type AgentActionContext,
	type AgentId,
	DEFAULT_AGENT_ID,
	getAgent,
	LAST_USED_AGENT_KEY,
} from "./agent-chat/agents";
import { MessageBubble } from "./agent-chat/MessageBubble";
import { MentionAutocomplete } from "./agent-chat/MentionAutocomplete";

interface TimelineItem {
	agentId: AgentId;
	message: UIMessage;
	sortKey: number;
}

function buildTimeline(
	emailMessages: UIMessage[],
	invoiceMessages: UIMessage[],
): TimelineItem[] {
	const items: TimelineItem[] = [];
	const toSortKey = (m: UIMessage, idx: number): number => {
		const t = (m as any).createdAt;
		if (t instanceof Date) return t.getTime();
		if (typeof t === "string" || typeof t === "number") {
			const n = new Date(t).getTime();
			if (!Number.isNaN(n)) return n;
		}
		// Fallback: arrival order. Multiply so it sorts well alongside ms.
		return idx;
	};
	emailMessages.forEach((m, i) =>
		items.push({ agentId: "email", message: m, sortKey: toSortKey(m, i) }),
	);
	invoiceMessages.forEach((m, i) =>
		items.push({ agentId: "invoice", message: m, sortKey: toSortKey(m, i) }),
	);
	items.sort((a, b) => a.sortKey - b.sortKey);
	return items;
}

function loadInitialAgent(): AgentId {
	if (typeof window === "undefined") return DEFAULT_AGENT_ID;
	const stored = window.sessionStorage.getItem(LAST_USED_AGENT_KEY);
	if (stored && AGENTS.some((a) => a.id === stored)) return stored as AgentId;
	return DEFAULT_AGENT_ID;
}

function UnifiedChatConnected({
	mailboxId,
	useAgent,
	useAgentChat,
}: {
	mailboxId: string;
	useAgent: typeof import("agents/react").useAgent;
	useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [inputValue, setInputValue] = useState("");
	const [pendingAgent, setPendingAgent] = useState<AgentId | null>(null);
	const [lastUsedAgent, setLastUsedAgent] = useState<AgentId>(loadInitialAgent);
	const { startCompose } = useUIStore();

	// Two persistent connections — both agents always reachable.
	const emailAgent = useAgent({ agent: "EmailAgent", name: mailboxId });
	const invoiceAgent = useAgent({ agent: "InvoiceAgent", name: mailboxId });
	const email = useAgentChat({ agent: emailAgent });
	const invoice = useAgentChat({ agent: invoiceAgent });

	const isEmailStreaming =
		email.status === "streaming" || email.status === "submitted";
	const isInvoiceStreaming =
		invoice.status === "streaming" || invoice.status === "submitted";
	const isAnyStreaming = isEmailStreaming || isInvoiceStreaming;

	const timeline = buildTimeline(email.messages, invoice.messages);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [timeline.length]);

	const sendByAgent = (agentId: AgentId, text: string) => {
		if (agentId === "email") email.sendMessage({ text });
		else invoice.sendMessage({ text });
		setLastUsedAgent(agentId);
		try {
			window.sessionStorage.setItem(LAST_USED_AGENT_KEY, agentId);
		} catch {
			/* sessionStorage may be unavailable in some browsers */
		}
	};

	const handleSubmit = () => {
		const text = inputValue.trim();
		if (!text || isAnyStreaming) return;
		const target: AgentId = pendingAgent ?? lastUsedAgent;
		sendByAgent(target, text);
		setInputValue("");
		setPendingAgent(null);
	};

	const handleStop = () => {
		if (isEmailStreaming) email.stop();
		if (isInvoiceStreaming) invoice.stop();
	};

	const handleClearAll = () => {
		if (
			window.confirm(
				"Clear chat history for both agents? This cannot be undone.",
			)
		) {
			email.setMessages([]);
			invoice.setMessages([]);
		}
	};

	const renderItem = (item: TimelineItem) => {
		const agentDef = getAgent(item.agentId);
		const ctx: AgentActionContext = {
			mailboxId,
			isStreaming: isAnyStreaming,
			startCompose,
			sendMessage: ({ text }) => sendByAgent(item.agentId, text),
		};
		const renderActions = agentDef.renderActions
			? (msg: UIMessage) => agentDef.renderActions?.(msg, ctx) ?? null
			: undefined;
		return (
			<MessageBubble
				key={`${item.agentId}-${item.message.id}`}
				message={item.message}
				toolLabels={agentDef.toolLabels}
				assistantIcon={agentDef.icon}
				renderActions={renderActions}
			/>
		);
	};

	const defaultAgent = getAgent(lastUsedAgent);
	const totalMessages = email.messages.length + invoice.messages.length;

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-kumo-line shrink-0">
				<div className="flex items-center gap-2">
					<Badge variant="beta">AI</Badge>
					<span className="text-xs text-kumo-subtle">Assistant</span>
				</div>
				<div className="flex items-center gap-1">
					{isAnyStreaming && <Loader size="sm" />}
					{totalMessages > 0 && (
						<Tooltip content="Clear all chat history" asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={handleClearAll}
								aria-label="Clear all chat history"
							/>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Messages */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
				{timeline.length === 0 ? (
					<EmptyState
						onPick={(agentId, prompt) => sendByAgent(agentId, prompt)}
					/>
				) : (
					<div className="flex flex-col gap-3">
						{timeline.map(renderItem)}
						{isAnyStreaming && (
							<div className="flex gap-2">
								<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
									{getAgent(
										isEmailStreaming ? "email" : "invoice",
									).icon}
								</div>
								<div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-kumo-elevated border border-kumo-line rounded-bl-sm">
									<Loader size="sm" />
									<span className="text-xs text-kumo-subtle">
										{
											getAgent(
												isEmailStreaming ? "email" : "invoice",
											).fullName
										}{" "}
										is thinking...
									</span>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Composer */}
			<div className="shrink-0 border-t border-kumo-line px-3 py-2">
				{isAnyStreaming ? (
					<div className="flex justify-center">
						<Button
							variant="secondary"
							size="sm"
							icon={<StopIcon size={14} weight="fill" />}
							onClick={handleStop}
						>
							Stop generating
						</Button>
					</div>
				) : (
					<MentionAutocomplete
						value={inputValue}
						onChange={setInputValue}
						pendingAgent={pendingAgent}
						onPendingAgentChange={setPendingAgent}
						onSubmit={handleSubmit}
						defaultAgentHint={defaultAgent.label}
					/>
				)}
			</div>
		</div>
	);
}

function EmptyState({
	onPick,
}: {
	onPick: (agentId: AgentId, prompt: string) => void;
}) {
	return (
		<div className="flex flex-col gap-4 h-full">
			<div className="flex flex-col gap-3">
				{AGENTS.map((agent) => (
					<div
						key={agent.id}
						className="rounded-lg border border-kumo-line p-3 bg-kumo-base"
					>
						<div className="flex items-center gap-2 mb-1">
							<span className="flex items-center text-kumo-brand">
								{agent.icon}
							</span>
							<span className="text-xs font-semibold text-kumo-default">
								{agent.fullName}
							</span>
							<span className="text-[11px] text-kumo-subtle font-mono">
								@{agent.label}
							</span>
						</div>
						<p className="text-[11px] text-kumo-subtle leading-relaxed mb-2">
							{agent.description}
						</p>
						<div className="flex flex-col gap-1">
							{agent.suggestedPrompts.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() => onPick(agent.id, prompt)}
									className="text-left px-2 py-1.5 rounded text-xs text-kumo-strong hover:bg-kumo-tint transition-colors cursor-pointer bg-transparent border-0"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				))}
			</div>
			<p className="text-[11px] text-kumo-subtle text-center px-2">
				Tip: type{" "}
				<code className="bg-kumo-fill px-1 py-0.5 rounded text-[10px]">
					@
				</code>{" "}
				to mention an agent. Each agent has its own memory — switching
				doesn't carry conversation context across.
			</p>
		</div>
	);
}

export default function UnifiedAgentPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [hooks, setHooks] = useState<{
		useAgent: typeof import("agents/react").useAgent;
		useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
	} | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		Promise.all([
			import("agents/react"),
			import("@cloudflare/ai-chat/react"),
		])
			.then(([a, c]) =>
				setHooks({
					useAgent: a.useAgent,
					useAgentChat: c.useAgentChat,
				}),
			)
			.catch((err) => {
				console.error("Failed to load agent modules:", err);
				setLoadError("Failed to connect to assistants. Reload to retry.");
			});
	}, []);

	if (loadError) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}

	if (!hooks) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Connecting...</span>
			</div>
		);
	}

	return (
		<UnifiedChatConnected
			mailboxId={mailboxId ?? "default"}
			useAgent={hooks.useAgent}
			useAgentChat={hooks.useAgentChat}
		/>
	);
}
