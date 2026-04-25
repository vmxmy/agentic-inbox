// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	ArrowUpIcon,
	ArrowsClockwiseIcon,
	EyeIcon,
	FoldersIcon,
	MagnifyingGlassIcon,
	MinusIcon,
	PencilSimpleIcon,
	PlusIcon,
	ReceiptIcon,
	RobotIcon,
	StopIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { MessageBubble } from "./chat/MessageBubble";
import { StreamingIndicator } from "./chat/StreamingIndicator";
import type { ToolLabels } from "./chat/ToolCallBadge";

const INVOICE_TOOL_LABELS: ToolLabels = {
	process_email_invoices: {
		label: "Re-extracting invoices",
		icon: <ArrowsClockwiseIcon size={14} weight="bold" />,
	},
	list_invoices: {
		label: "Searching invoices",
		icon: <MagnifyingGlassIcon size={14} weight="bold" />,
	},
	get_invoice: {
		label: "Reading invoice",
		icon: <ReceiptIcon size={14} weight="bold" />,
	},
	list_bundles: {
		label: "Listing bundles",
		icon: <FoldersIcon size={14} weight="bold" />,
	},
	get_bundle: {
		label: "Reading bundle",
		icon: <EyeIcon size={14} weight="bold" />,
	},
	create_bundle: {
		label: "Creating bundle",
		icon: <PlusIcon size={14} weight="bold" />,
	},
	update_bundle: {
		label: "Updating bundle",
		icon: <PencilSimpleIcon size={14} weight="bold" />,
	},
	delete_bundle: {
		label: "Deleting bundle",
		icon: <TrashIcon size={14} weight="bold" />,
	},
	add_invoice_to_bundle: {
		label: "Adding to bundle",
		icon: <PlusIcon size={14} weight="bold" />,
	},
	remove_invoice_from_bundle: {
		label: "Removing from bundle",
		icon: <MinusIcon size={14} weight="bold" />,
	},
};

function InvoiceChatConnected({
	mailboxId,
	useAgent,
	useAgentChat,
}: {
	mailboxId: string;
	useAgent: typeof import("agents/react").useAgent;
	useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [inputValue, setInputValue] = useState("");

	const agent = useAgent({ agent: "InvoiceAgent", name: mailboxId });
	const { messages, sendMessage, status, setMessages, stop } = useAgentChat({
		agent,
	});
	const isStreaming = status === "streaming" || status === "submitted";

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = () => {
		const text = inputValue.trim();
		if (!text || isStreaming) return;
		setInputValue("");
		sendMessage({ text });
		if (inputRef.current) inputRef.current.style.height = "auto";
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const suggestedPrompts = [
		"Show the latest invoices",
		"List reimbursement bundles",
		"How many invoices need review?",
	];

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-kumo-line shrink-0">
				<div className="flex items-center gap-2">
					<Badge variant="beta">AI</Badge>
					<span className="text-xs text-kumo-subtle">Invoice Agent</span>
				</div>
				<div className="flex items-center gap-1">
					{isStreaming && <Loader size="sm" />}
					{messages.length > 0 && (
						<Tooltip content="Clear chat" asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={() => {
									if (window.confirm("Clear chat history?")) {
										setMessages([]);
									}
								}}
								aria-label="Clear chat"
							/>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Messages */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
				{messages.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full gap-4">
						<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kumo-brand/10">
							<ReceiptIcon
								size={24}
								weight="duotone"
								className="text-kumo-brand"
							/>
						</div>
						<p className="text-xs text-kumo-subtle text-center leading-relaxed px-4">
							I can search invoices, manage reimbursement bundles, and re-run
							extraction on specific emails.
						</p>
						<div className="flex flex-col gap-1.5 w-full">
							{suggestedPrompts.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() => sendMessage({ text: prompt })}
									className="text-left px-3 py-2 rounded-lg border border-kumo-line text-xs text-kumo-strong hover:bg-kumo-tint hover:border-kumo-fill-hover transition-colors cursor-pointer bg-transparent"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						{messages.map((msg) => (
							<MessageBubble
								key={msg.id}
								message={msg}
								avatarIcon={{ assistant: ReceiptIcon }}
								toolLabels={INVOICE_TOOL_LABELS}
							/>
						))}
						{isStreaming && <StreamingIndicator avatarIcon={RobotIcon} />}
					</div>
				)}
			</div>

			{/* Input */}
			<div className="shrink-0 border-t border-kumo-line px-3 py-2">
				{isStreaming ? (
					<div className="flex justify-center">
						<Button
							variant="secondary"
							size="sm"
							icon={<StopIcon size={14} weight="fill" />}
							onClick={() => stop()}
						>
							Stop generating
						</Button>
					</div>
				) : (
					<div className="flex items-end gap-1.5">
						<textarea
							ref={inputRef}
							id="invoice-chat-input"
							name="invoice-chat-input"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask the invoice agent..."
							rows={1}
							aria-label="Chat message input"
							className="flex-1 resize-none rounded-lg border border-kumo-line bg-kumo-control px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring min-h-[36px] max-h-[100px]"
							style={{ height: "auto", overflow: "hidden" }}
							onInput={(e) => {
								const t = e.target as HTMLTextAreaElement;
								t.style.height = "auto";
								t.style.height = `${Math.min(t.scrollHeight, 100)}px`;
								t.style.overflow = t.scrollHeight > 100 ? "auto" : "hidden";
							}}
						/>
						<Button
							variant="primary"
							shape="square"
							size="sm"
							disabled={!inputValue.trim()}
							icon={<ArrowUpIcon size={14} weight="bold" />}
							onClick={handleSend}
							aria-label="Send message"
						/>
					</div>
				)}
			</div>
		</div>
	);
}

export default function InvoicePanel() {
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
				console.error("Failed to load invoice agent modules:", err);
				setLoadError("Failed to connect to invoice agent. Reload to retry.");
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
		<InvoiceChatConnected
			mailboxId={mailboxId ?? "default"}
			useAgent={hooks.useAgent}
			useAgentChat={hooks.useAgentChat}
		/>
	);
}
