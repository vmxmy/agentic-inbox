// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	PencilSimpleIcon,
	StopIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import type { UIMessage } from "ai";
import { useUIStore } from "~/hooks/useUIStore";
import {
	AGENTS,
	AGENTS_BY_ID,
	type AgentDef,
	type AgentId,
	readLastAgent,
	writeLastAgent,
} from "./agent-chat/agents";
import {
	getToolNameFromPart,
	MessageBubble,
} from "./agent-chat/MessageBubble";
import MentionAutocomplete from "./agent-chat/MentionAutocomplete";

// ── Typed accessors for fields not surfaced by the AI SDK v6 UIMessage ─
//
// AI SDK v6's `UIMessage` union deliberately hides a few runtime fields
// that the AIChatAgent persist path stamps in (`createdAt`) or that vary
// between part shapes (`output` / `result`). Centralising the casts here
// keeps `as unknown as` out of the hot path and makes the assumed shape
// explicit so a future SDK bump is easy to audit.

type WithCreatedAt = { createdAt?: string | number | Date };
type ToolPartShape = { result?: unknown; output?: unknown };

function getCreatedAt(msg: UIMessage): number {
	const stamp = (msg as unknown as WithCreatedAt).createdAt;
	return stamp ? new Date(stamp).getTime() : 0;
}

function getToolResult(part: UIMessage["parts"][number]): unknown {
	const p = part as unknown as ToolPartShape;
	return p.output ?? p.result;
}

// ── Email-agent-specific draft action footer ─────────────────────────
//
// Only the email agent has a `draft_reply` tool that produces a payload
// the user wants to hand off to the composer. The unified panel renders
// `renderEmailActions` only for messages tagged with `agentId === "email"`.

function hasDraftReplyTool(message: UIMessage): boolean {
	return message.parts.some(
		(part) => getToolNameFromPart(part) === "draft_reply",
	);
}

interface DraftReplyData {
	to?: string;
	subject?: string;
	body?: string;
	id?: string;
}

function isDraftReplyData(value: unknown): value is DraftReplyData {
	return typeof value === "object" && value !== null;
}

function findDraftReplyData(message: UIMessage): DraftReplyData | null {
	for (const part of message.parts) {
		if (getToolNameFromPart(part) !== "draft_reply") continue;
		const result = getToolResult(part);
		if (isDraftReplyData(result)) return result;
	}
	return null;
}

function DraftActions({
	onEdit,
	disabled,
}: {
	onEdit: () => void;
	disabled: boolean;
}) {
	return (
		<div className="flex gap-1.5 mt-1">
			<Button
				variant="primary"
				size="sm"
				icon={<PencilSimpleIcon size={14} />}
				onClick={onEdit}
				disabled={disabled}
			>
				Edit & send in composer
			</Button>
		</div>
	);
}

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
	const [inputValue, setInputValue] = useState("");
	const [pendingAgent, setPendingAgent] = useState<AgentId | null>(null);
	// Lazy initializer reads sessionStorage on first render. `readLastAgent`
	// itself guards `typeof window === "undefined"` for SSR, so this is safe
	// and avoids a first-paint mis-routing race vs. an effect-based init.
	const [defaultAgent, setDefaultAgent] = useState<AgentId>(() =>
		readLastAgent(mailboxId),
	);
	const { startCompose } = useUIStore();

	// If the route changes mailbox underneath us (e.g. user navigates between
	// mailboxes without unmounting the panel), re-read the per-mailbox preference.
	useEffect(() => {
		setDefaultAgent(readLastAgent(mailboxId));
	}, [mailboxId]);

	// Two parallel agent connections — each agent owns its own SQLite chat
	// history in its DO, and we merge the two message streams into a single
	// timeline visually (sorted by createdAt).
	const emailAgent = useAgent({ agent: "EmailAgent", name: mailboxId });
	const invoiceAgent = useAgent({ agent: "InvoiceAgent", name: mailboxId });
	const emailChat = useAgentChat({ agent: emailAgent });
	const invoiceChat = useAgentChat({ agent: invoiceAgent });

	const isEmailStreaming =
		emailChat.status === "streaming" || emailChat.status === "submitted";
	const isInvoiceStreaming =
		invoiceChat.status === "streaming" ||
		invoiceChat.status === "submitted";
	const isAnyStreaming = isEmailStreaming || isInvoiceStreaming;

	const timeline: TaggedMessage[] = useMemo(() => {
		const tagged: TaggedMessage[] = [
			...emailChat.messages.map(
				(m): TaggedMessage => ({ msg: m, agentId: "email" }),
			),
			...invoiceChat.messages.map(
				(m): TaggedMessage => ({ msg: m, agentId: "invoice" }),
			),
		];
		return tagged.sort((a, b) => {
			// Primary key: persist-stamped `createdAt`. Falls back to 0
			// (see `getCreatedAt`).
			const dt = getCreatedAt(a.msg) - getCreatedAt(b.msg);
			if (dt !== 0) return dt;
			// Secondary keys keep cross-agent ordering deterministic when
			// timestamps tie or are both missing — otherwise the visual
			// order would depend on which DO's stream landed first.
			if (a.agentId !== b.agentId) {
				return a.agentId < b.agentId ? -1 : 1;
			}
			if (a.msg.id < b.msg.id) return -1;
			if (a.msg.id > b.msg.id) return 1;
			return 0;
		});
	}, [emailChat.messages, invoiceChat.messages]);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [timeline.length, isEmailStreaming, isInvoiceStreaming]);

	const targetAgent: AgentId = pendingAgent ?? defaultAgent;

	const sendToAgent = (agentId: AgentId, text: string) => {
		if (agentId === "email") emailChat.sendMessage({ text });
		else invoiceChat.sendMessage({ text });
		writeLastAgent(agentId, mailboxId);
		setDefaultAgent(agentId);
	};

	const handleSend = () => {
		const text = inputValue.trim();
		if (!text || isAnyStreaming) return;
		sendToAgent(targetAgent, text);
		setInputValue("");
		setPendingAgent(null);
	};

	const handleStop = () => {
		if (isEmailStreaming) emailChat.stop();
		if (isInvoiceStreaming) invoiceChat.stop();
	};

	const handleClearAll = () => {
		// `setMessages([])` resets the local UIMessage[] state. The DO's
		// SQLite-backed history (see workers/agent/index.ts:persistMessages)
		// may persist across reloads depending on the AIChatAgent SDK
		// path — surface that uncertainty in the prompt rather than
		// promising a destructive backend wipe we can't verify here.
		if (
			window.confirm(
				"Clear chat history for both agents on this device? Server-side history may reappear on reload.",
			)
		) {
			emailChat.setMessages([]);
			invoiceChat.setMessages([]);
		}
	};

	const renderEmailActions = (msg: UIMessage) => {
		if (!hasDraftReplyTool(msg)) return null;
		// Extract draft data from the draft_reply tool result so the "Edit
		// & send" button can hand off the right payload to the composer.
		const draftData = findDraftReplyData(msg);
		return (
			<DraftActions
				disabled={isAnyStreaming}
				onEdit={() => {
					if (draftData) {
						startCompose({
							mode: "reply",
							originalEmail: null,
							draftEmail: {
								id: draftData.id || "",
								subject: draftData.subject || "",
								sender: mailboxId,
								recipient: draftData.to || "",
								date: new Date().toISOString(),
								read: true,
								starred: false,
								body: draftData.body || "",
							},
						});
					} else {
						emailChat.sendMessage({
							text: "Let me edit this draft first. Show me what you have so I can modify it.",
						});
					}
				}}
			/>
		);
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
					{isAnyStreaming && <Loader size="sm" />}
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
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
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
									renderActions={
										agentId === "email" ? renderEmailActions : undefined
									}
								/>
							);
						})}
						{isEmailStreaming && (
							<ThinkingIndicator agent={AGENTS_BY_ID.email} />
						)}
						{isInvoiceStreaming && (
							<ThinkingIndicator agent={AGENTS_BY_ID.invoice} />
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
