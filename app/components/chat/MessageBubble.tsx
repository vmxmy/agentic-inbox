// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared chat-message bubble used by every domain agent panel
 * (AgentPanel, InvoicePanel, future Search/Calendar agents …).
 *
 * Panels pass:
 *   - the assistant avatar icon (user avatar defaults to UserIcon)
 *   - their domain-specific tool label map (rendered in ToolCallBadge)
 *   - an optional `footer(message)` for assistant-only post-content actions
 *     (AgentPanel uses this to render its DraftActions edit button after a
 *     `draft_reply` tool call; InvoicePanel doesn't use it)
 *
 * Behavior is identical to the inlined versions previously copy-pasted into
 * AgentPanel and InvoicePanel — this is a refactor, not a UX change.
 */

import { type Icon, UserIcon } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import { markdownComponents } from "./markdown-components";
import { ToolCallBadge, type ToolLabels } from "./ToolCallBadge";

export interface AvatarIcons {
	/** Defaults to UserIcon — both panels currently use it; pass to override. */
	user?: Icon;
	assistant: Icon;
}

export interface MessageBubbleProps {
	message: UIMessage;
	avatarIcon: AvatarIcons;
	toolLabels: ToolLabels;
	/** Rendered under assistant messages only. AgentPanel returns
	 *  <DraftActions/> when a message contains a draft_reply tool call;
	 *  return null to render nothing. */
	footer?: (message: UIMessage) => ReactNode;
}

function getToolNameFromPart(part: UIMessage["parts"][number]): string | null {
	if (part.type === "dynamic-tool")
		return (part as { toolName?: string }).toolName ?? null;
	if (part.type.startsWith("tool-")) return part.type.replace("tool-", "");
	return null;
}

export function MessageBubble({
	message,
	avatarIcon,
	toolLabels,
	footer,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const UserAvatar: Icon = avatarIcon.user ?? UserIcon;
	const AssistantAvatar: Icon = avatarIcon.assistant;

	return (
		<div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
			<div
				className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
					isUser
						? "bg-kumo-brand text-kumo-inverse"
						: "bg-kumo-fill text-kumo-default"
				}`}
			>
				{isUser ? (
					<UserAvatar size={12} weight="bold" />
				) : (
					<AssistantAvatar size={12} weight="bold" />
				)}
			</div>
			<div
				className={`flex flex-col gap-1 max-w-[85%] min-w-0 ${
					isUser ? "items-end" : "items-start"
				}`}
			>
				{message.parts.map((part, i) => {
					const key = `${message.id}-part-${i}`;
					if (part.type === "text" && part.text.trim()) {
						return (
							<div
								key={key}
								className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed break-words overflow-wrap-anywhere ${
									isUser
										? "bg-kumo-brand text-kumo-inverse rounded-br-sm"
										: "bg-kumo-elevated text-kumo-default border border-kumo-line rounded-bl-sm overflow-hidden"
								}`}
							>
								{isUser ? (
									part.text
								) : (
									<Markdown
										remarkPlugins={[remarkGfm]}
										components={markdownComponents}
									>
										{part.text}
									</Markdown>
								)}
							</div>
						);
					}
					const toolName = getToolNameFromPart(part);
					if (toolName) {
						return (
							<ToolCallBadge
								key={key}
								toolName={toolName}
								state={(part as { state?: string }).state ?? "running"}
								toolLabels={toolLabels}
							/>
						);
					}
					return null;
				})}
				{!isUser && footer ? footer(message) : null}
			</div>
		</div>
	);
}
