// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	PaperclipIcon,
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
import {
	compareByCreatedAt,
	type MessageWithCreatedAt,
} from "./agent-chat/messageOrdering";

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

interface TaggedMessage {
	msg: UIMessage;
	agentId: AgentId;
}

interface ChatUploadedFile {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	ordinal: number;
}

const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_FILE_MAX_ATTACHMENTS = 5;

function formatFileSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function uploadChatFile(
	mailboxId: string,
	sessionId: string,
	file: File,
): Promise<ChatUploadedFile> {
	const formData = new FormData();
	formData.set("sessionId", sessionId);
	formData.set("file", file);
	const response = await fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/agent-files`, {
		method: "POST",
		body: formData,
	});
	const body = await response.json().catch(() => ({})) as { error?: string } & Partial<ChatUploadedFile>;
	if (!response.ok) {
		throw new Error(body.error || "Failed to upload file");
	}
	if (!body.id || !body.filename || !body.mimetype || !body.size || !body.ordinal) {
		throw new Error("File upload response was incomplete");
	}
	return {
		id: body.id,
		filename: body.filename,
		mimetype: body.mimetype,
		size: body.size,
		ordinal: body.ordinal,
	};
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
	const [uploadedFiles, setUploadedFiles] = useState<ChatUploadedFile[]>([]);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	// Tracks whether the user manually clicked Stop. Workaround for AI SDK
	// v6 where `chat.stop()` aborts the request but `status` may not flip
	// back to "ready" if the transport doesn't surface the AbortError.
	const stoppedByUserRef = useRef(false);
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
		setUploadedFiles([]);
		setUploadError(null);
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

	// Hide loading UI immediately when the user hits Stop, rather than waiting
	// for the SDK transport to propagate the abort and update status.
	useEffect(() => {
		if (chat.status === "ready" || chat.status === "error") {
			stoppedByUserRef.current = false;
		}
	}, [chat.status]);

	const isStreaming =
		(chat.status === "streaming" || chat.status === "submitted") &&
		!stoppedByUserRef.current;

	const timeline: TaggedMessage[] = useMemo(
		() =>
			chat.messages
				.map((msg): TaggedMessage => ({ msg, agentId: "router" }))
				.sort((a, b) => compareByCreatedAt(a.msg, b.msg)),
		[chat.messages],
	);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [timeline.length, isStreaming]);

	const targetAgent: AgentId = pendingAgent ?? defaultAgent;

	const sendToAgent = (agentId: AgentId, text: string) => {
		const hint = agentId !== "router" ? `[→${agentId}] ` : "";
		const fileContext = uploadedFiles.length > 0
			? `\n\nAvailable uploaded files:\n${uploadedFiles
				.map((file) => `${file.ordinal}. ${file.filename} (id: ${file.id}, ${formatFileSize(file.size)}, ${file.mimetype})`)
				.join("\n")}`
			: "";
		chat.sendMessage({ text: hint + text + fileContext });
		writeLastAgent(agentId, mailboxId);
		setDefaultAgent(agentId);
	};

	const handleFilesSelected = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setUploadError(null);
		if (uploadedFiles.length + files.length > CHAT_FILE_MAX_ATTACHMENTS) {
			setUploadError(`You can attach at most ${CHAT_FILE_MAX_ATTACHMENTS} files.`);
			return;
		}
		setUploading(true);
		try {
			const nextFiles: ChatUploadedFile[] = [];
			for (const file of Array.from(files)) {
				if (file.size > CHAT_FILE_MAX_BYTES) {
					throw new Error(`${file.name} exceeds the 10MB upload limit.`);
				}
				nextFiles.push(await uploadChatFile(mailboxId, mailboxId, file));
			}
			setUploadedFiles((current) => [...current, ...nextFiles]);
		} catch (error) {
			setUploadError(error instanceof Error ? error.message : "Failed to upload file");
		} finally {
			setUploading(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
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
		stoppedByUserRef.current = true;
		chat.stop();
	};

	const handleClearAll = async () => {
		if (
			window.confirm(
				"Clear chat history for this mailbox? This cannot be undone.",
			)
		) {
			await chat.clearHistory();
			await fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/agent-files?sessionId=${encodeURIComponent(mailboxId)}`, {
				method: "DELETE",
			}).catch(() => undefined);
			setUploadedFiles([]);
			setUploadError(null);
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
							const createdAt = (msg as MessageWithCreatedAt).createdAt;
							const keyCreatedAt = createdAt ? new Date(createdAt).getTime() : "pending";
							return (
								<MessageBubble
									key={`${agentId}-${msg.id}-${keyCreatedAt}`}
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
				{uploadError && (
					<div className="mb-2 text-[11px] text-kumo-error">{uploadError}</div>
				)}
				{uploadedFiles.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-1.5">
						{uploadedFiles.map((file) => (
							<span
								key={file.id}
								className="inline-flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-fill px-2 py-1 text-[11px] text-kumo-default"
							>
								<PaperclipIcon size={12} />
								<span className="max-w-[160px] truncate">{file.filename}</span>
								<span className="text-kumo-subtle">{formatFileSize(file.size)}</span>
								<button
									type="button"
									className="ml-0.5 border-0 bg-transparent text-kumo-subtle cursor-pointer"
									onClick={() => setUploadedFiles((current) => current.filter((item) => item.id !== file.id))}
									aria-label={`Remove ${file.filename}`}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
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
					<div className="flex items-end gap-1.5">
						<input
							ref={fileInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={(event) => void handleFilesSelected(event.currentTarget.files)}
						/>
						<Tooltip content="Upload files for this chat" asChild>
							<Button
								variant="secondary"
								shape="square"
								size="sm"
								disabled={uploading || uploadedFiles.length >= CHAT_FILE_MAX_ATTACHMENTS}
								icon={uploading ? <Loader size="sm" /> : <PaperclipIcon size={14} />}
								onClick={() => fileInputRef.current?.click()}
								aria-label="Upload files"
							/>
						</Tooltip>
						<div className="min-w-0 flex-1">
							<MentionAutocomplete
								value={inputValue}
								onChange={setInputValue}
								onSubmit={handleSend}
								pendingAgent={pendingAgent}
								onPendingAgentChange={setPendingAgent}
								canSubmit={!!inputValue.trim()}
								placeholder={placeholder}
							/>
						</div>
					</div>
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
