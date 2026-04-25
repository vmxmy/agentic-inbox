// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { CheckCircleIcon, UserIcon, WrenchIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";

export interface ToolLabel {
	label: string;
	icon: ReactNode;
}

export type ToolLabelsMap = Record<string, ToolLabel>;

/**
 * Extract a callable tool name from a UI message part. AI SDK v6 uses
 * `dynamic-tool` (with a `toolName` field) and `tool-<name>` part shapes.
 * Exported so per-agent helpers (e.g. `hasDraftReplyTool` in AgentPanel)
 * can reuse the same parsing.
 */
export function getToolNameFromPart(
	part: UIMessage["parts"][number],
): string | null {
	if (part.type === "dynamic-tool") return (part as any).toolName ?? null;
	if (part.type.startsWith("tool-")) return part.type.replace("tool-", "");
	return null;
}

interface ToolCallBadgeProps {
	toolName: string;
	state: string;
	toolLabels: ToolLabelsMap;
}

function ToolCallBadge({ toolName, state, toolLabels }: ToolCallBadgeProps) {
	const info = toolLabels[toolName] ?? {
		label: toolName,
		icon: <WrenchIcon size={14} weight="bold" />,
	};
	const isDone =
		state === "output-available" ||
		state === "result" ||
		state === "output-error";

	return (
		<div className="flex items-center gap-1.5 py-1 px-2 rounded bg-kumo-fill/50 text-xs">
			<span className="text-kumo-brand">{info.icon}</span>
			<span className="text-kumo-strong">{info.label}</span>
			{isDone ? (
				<CheckCircleIcon
					size={12}
					weight="fill"
					className="text-kumo-success ml-auto"
				/>
			) : (
				<Loader size="sm" className="ml-auto" />
			)}
		</div>
	);
}

const markdownComponents = {
	a: ({ href, children }: any) => (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			style={{
				color: "var(--color-link)",
				textDecoration: "underline",
			}}
		>
			{children}
		</a>
	),
	p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
	strong: ({ children }: any) => (
		<strong className="font-semibold">{children}</strong>
	),
	ul: ({ children }: any) => (
		<ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ul>
	),
	ol: ({ children }: any) => (
		<ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ol>
	),
	li: ({ children }: any) => <li>{children}</li>,
	h1: ({ children }: any) => (
		<h3 className="font-semibold text-sm mb-1">{children}</h3>
	),
	h2: ({ children }: any) => (
		<h4 className="font-semibold text-[13px] mb-1">{children}</h4>
	),
	h3: ({ children }: any) => (
		<h5 className="font-semibold text-[13px] mb-0.5">{children}</h5>
	),
	code: ({ children }: any) => (
		<code className="bg-kumo-fill px-1 py-0.5 rounded text-[12px]">
			{children}
		</code>
	),
	table: ({ children }: any) => (
		<div className="overflow-x-auto my-2">
			<table className="w-full text-xs border-collapse">{children}</table>
		</div>
	),
	thead: ({ children }: any) => (
		<thead className="border-b border-kumo-line bg-kumo-fill/30">
			{children}
		</thead>
	),
	th: ({ children }: any) => (
		<th className="text-left px-2 py-1 font-semibold text-kumo-strong">
			{children}
		</th>
	),
	td: ({ children }: any) => (
		<td className="px-2 py-1 border-b border-kumo-line/50">{children}</td>
	),
};

export interface MessageBubbleProps {
	message: UIMessage;
	/** Tool name → { label, icon } map for rendering tool-call badges. */
	toolLabels: ToolLabelsMap;
	/** Avatar shown for the assistant role. User avatar is always UserIcon. */
	assistantIcon: ReactNode;
	/**
	 * Optional renderer for per-message action buttons (e.g. "Edit & send in
	 * composer" for draft replies). Receives the assistant message and returns
	 * a node to render below the bubble — return null / undefined to skip.
	 */
	renderActions?: (message: UIMessage) => ReactNode;
}

/**
 * Generic chat bubble shared by AgentPanel (EmailAgent) and InvoicePanel
 * (InvoiceAgent). Handles user / assistant layout, streaming text via
 * react-markdown + GFM, tool-call badges via the supplied `toolLabels` map,
 * and an optional per-message action footer for draft buttons etc.
 */
export function MessageBubble({
	message,
	toolLabels,
	assistantIcon,
	renderActions,
}: MessageBubbleProps) {
	const isUser = message.role === "user";

	return (
		<div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
			<div
				className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
					isUser
						? "bg-kumo-brand text-kumo-inverse"
						: "bg-kumo-fill text-kumo-default"
				}`}
			>
				{isUser ? <UserIcon size={12} weight="bold" /> : assistantIcon}
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
										components={markdownComponents as any}
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
								state={(part as any).state ?? "running"}
								toolLabels={toolLabels}
							/>
						);
					}
					return null;
				})}
				{!isUser && renderActions?.(message)}
			</div>
		</div>
	);
}
