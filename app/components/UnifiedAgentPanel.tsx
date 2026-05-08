// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	StopIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import type { UIMessage } from "ai";
import {
	AGENTS,
	AGENTS_BY_ID,
	type AgentDef,
	type AgentId,
	readLastAgent,
	writeLastAgent,
} from "./agent-chat/agents";
import { MessageBubble } from "./agent-chat/MessageBubble";
import MentionAutocomplete from "./agent-chat/MentionAutocomplete";

// ── Empty state ──────────────────────────────────────────────────────

function EmptyState({
	onSendToAgent,
}: {
	onSendToAgent: (id: AgentId, text: string) => void;
}) {
	return (
		<div className="flex flex-col items-center justify-center min-h-full gap-5 py-2">
			<p className="text-xs text-kumo-subtle text-center leading-relaxed px-4">
				Send a message — type{" "}
				<kbd className="px-1 py-0.5 rounded bg-kumo-fill text-[10px] font-mono">
					@
				</kbd>{" "}
				to switch agents.
			</p>
			<div className="flex flex-col gap-2.5 w-full">
				{AGENTS.map((agent) => (
					<div
						key={agent.id}
						className="border border-kumo-line rounded-lg p-3 bg-kumo-base"
					>
						<div className="flex items-center gap-2 mb-2">
							<span className="shrink-0">{agent.largeIcon}</span>
							<div className="flex flex-col min-w-0">
								<span className="text-xs font-semibold text-kumo-default">
									@{agent.label}
								</span>
								<span className="text-[11px] text-kumo-subtle leading-snug">
									{agent.description}
								</span>
							</div>
						</div>
						<div className="flex flex-col gap-1">
							{agent.suggestedPrompts.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() => onSendToAgent(agent.id, prompt)}
									className="text-left px-2 py-1.5 rounded text-xs text-kumo-strong hover:bg-kumo-tint transition-colors cursor-pointer bg-transparent border border-transparent hover:border-kumo-line"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function ThinkingIndicator({ agent }: { agent: AgentDef }) {
	return (
		<div className="flex gap-2">
			<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
				{agent.icon}
			</div>
			<div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-kumo-elevated border border-kumo-line rounded-bl-sm">
				<Loader size="sm" />
				<span className="text-xs text-kumo-subtle">
					@{agent.label} thinking...
				</span>
			</div>
		</div>
	);
}

// ── Inner component (called once both lazy modules are loaded) ──────

interface TaggedMessage {
	msg: UIMessage;
	agentId: AgentId;
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
	const isNearBottomRef = useRef(true);
	const [inputValue, setInputValue] = useState("");
	const [pendingAgent, setPendingAgent] = useState<AgentId | null>(null);
	// Lazy initializer reads sessionStorage on first render. `readLastAgent`
	// itself guards `typeof window === "undefined"` for SSR, so this is safe
	// and avoids a first-paint mis-routing race vs. an effect-based init.
	const [defaultAgent, setDefaultAgent] = useState<AgentId>(() =>
		readLastAgent(mailboxId),
	);
	// If the route changes mailbox underneath us (e.g. user navigates between
	// mailboxes without unmounting the panel), re-read the per-mailbox preference
	// and drop any in-progress @-mention so it doesn't carry over.
	useEffect(() => {
		setDefaultAgent(readLastAgent(mailboxId));
		setPendingAgent(null);
	}, [mailboxId]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		isNearBottomRef.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	}, []);

	const routerAgent = useAgent({ agent: "RouterAgent", name: mailboxId });
	// `resume: false` — disable the SDK's stream-resume on reconnect so a user-
	// triggered stop() truly aborts the run instead of being instantly
	// resurrected by the resume handshake.
	const chat = useAgentChat({ agent: routerAgent, resume: false });

	const isStreaming = chat.status === "streaming" || chat.status === "submitted";

	const timeline: TaggedMessage[] = useMemo(
		() => chat.messages.map((msg): TaggedMessage => ({ msg, agentId: "router" })),
		[chat.messages],
	);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [timeline.length, isStreaming]);

	const targetAgent: AgentId = pendingAgent ?? defaultAgent;

	const sendToAgent = (agentId: AgentId, text: string) => {
		const hint = agentId !== "router" ? `[→${agentId}] ` : "";
		chat.sendMessage({ text: hint + text });
		writeLastAgent(agentId, mailboxId);
		setDefaultAgent(agentId);
	};

	const handleSend = () => {
		const text = inputValue.trim();
		if (!text || isStreaming) return;
		sendToAgent(targetAgent, text);
		setInputValue("");
		setPendingAgent(null);
		// Always scroll to bottom when the user sends — even if they had
		// scrolled up to read earlier messages.
		isNearBottomRef.current = true;
		requestAnimationFrame(() => {
			const el = scrollRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		});
	};

	const handleStop = () => {
		chat.stop();
	};

	const handleClearAll = async () => {
		if (
			window.confirm(
				"Clear chat history for this mailbox? This cannot be undone.",
			)
		) {
			await chat.clearHistory();
		}
	};

	const placeholder = pendingAgent
		? `Asking @${AGENTS_BY_ID[pendingAgent].label}...`
		: `Ask @${defaultAgent} — type @ to switch`;

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-kumo-line shrink-0">
				<div className="flex items-center gap-2">
					<Badge variant="beta">AI</Badge>
					<span className="text-xs text-kumo-subtle">Assistant</span>
				</div>
				<div className="flex items-center gap-1">
					{isStreaming && <Loader size="sm" />}
					{timeline.length > 0 && (
						<Tooltip content="Clear chat" asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={handleClearAll}
								aria-label="Clear chat"
							/>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Messages */}
			<div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-4">
				{timeline.length === 0 ? (
					<EmptyState onSendToAgent={sendToAgent} />
				) : (
					<div className="flex flex-col gap-3">
						{timeline.map(({ msg, agentId }) => {
							const agent = AGENTS_BY_ID[agentId];
							return (
								<MessageBubble
									key={`${agentId}-${msg.id}`}
									message={msg}
									toolLabels={agent.toolLabels}
									assistantIcon={agent.icon}
								/>
							);
						})}
						{isStreaming && (
							<ThinkingIndicator agent={AGENTS_BY_ID.router} />
						)}
					</div>
				)}
			</div>

			{/* Composer */}
			<div className="shrink-0 border-t border-kumo-line px-3 py-2">
				{isStreaming ? (
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
						onSubmit={handleSend}
						pendingAgent={pendingAgent}
						onPendingAgentChange={setPendingAgent}
						canSubmit={!!inputValue.trim()}
						placeholder={placeholder}
					/>
				)}
			</div>
		</div>
	);
}

// ── Lazy-loaded outer component ──────────────────────────────────────

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
				setLoadError("Failed to connect to agents. Reload to retry.");
			});
	}, []);

	// Without a concrete mailbox we must NOT fall back to a shared DO name
	// (e.g. `"default"`) — that would let chat history and tool calls leak
	// across users. Render a placeholder until the route resolves.
	if (!mailboxId) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
				<span className="text-xs text-kumo-subtle">
					Open a mailbox to chat with agents.
				</span>
			</div>
		);
	}

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
			mailboxId={mailboxId}
			useAgent={hooks.useAgent}
			useAgentChat={hooks.useAgentChat}
		/>
	);
}
