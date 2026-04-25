// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Composer for the unified agent chat. Wraps a textarea with:
 *   - An optional "agent chip" prefix (e.g. [🧾 invoice]) — visual reminder of
 *     which agent the next send will route to. Backspace at cursor 0 clears it.
 *   - An @-mention dropdown — typing `@` opens a picker filtered by what the
 *     user types after; ↑/↓ navigate, Enter / Tab selects. Selecting strips
 *     the `@xyz` from the textarea and sets the chip.
 *
 * The chip / mention state is owned by the parent (UnifiedAgentPanel) so it
 * can reset after send.
 */

import { Button } from "@cloudflare/kumo";
import { ArrowUpIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, type AgentDef, type AgentId, getAgent } from "./agents";

interface MentionContext {
	start: number;
	query: string;
}

/**
 * Find the active @-mention context in `value` at the given cursor position.
 * Returns the start index of `@` and the query text following it, or null if
 * the cursor isn't inside a valid mention.
 *
 * Valid mentions: `@` is at start-of-string or preceded by whitespace, and
 * everything between `@` and cursor is `[\w-]*`.
 */
function findMentionContext(value: string, cursor: number): MentionContext | null {
	for (let i = cursor - 1; i >= 0; i--) {
		const c = value[i];
		if (c === "@") {
			const prev = i === 0 ? " " : value[i - 1];
			if (/\s/.test(prev) || i === 0) {
				return { start: i, query: value.slice(i + 1, cursor) };
			}
			return null;
		}
		if (/\s/.test(c)) return null;
		if (!/[\w-]/.test(c)) return null;
	}
	return null;
}

function filterAgents(query: string): AgentDef[] {
	if (!query) return [...AGENTS];
	const q = query.toLowerCase();
	return AGENTS.filter(
		(a) =>
			a.id.startsWith(q) ||
			a.label.startsWith(q) ||
			a.fullName.toLowerCase().includes(q),
	);
}

interface AgentChipProps {
	agent: AgentDef;
	onClear: () => void;
}

function AgentChip({ agent, onClear }: AgentChipProps) {
	return (
		<span
			className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 mr-1 rounded bg-kumo-brand/10 text-kumo-brand text-xs font-medium select-none"
			aria-label={`Mentioning ${agent.fullName}`}
		>
			<span className="flex items-center">{agent.icon}</span>
			<span>{agent.label}</span>
			<button
				type="button"
				onClick={onClear}
				className="flex items-center -mr-0.5 text-kumo-brand/60 hover:text-kumo-brand cursor-pointer bg-transparent"
				aria-label={`Remove ${agent.label} mention`}
				tabIndex={-1}
			>
				<XIcon size={10} weight="bold" />
			</button>
		</span>
	);
}

export interface MentionAutocompleteProps {
	value: string;
	onChange: (value: string) => void;
	pendingAgent: AgentId | null;
	onPendingAgentChange: (agent: AgentId | null) => void;
	onSubmit: () => void;
	disabled?: boolean;
	placeholder?: string;
	/** Hint shown to the right of the chip when no chip is set. */
	defaultAgentHint?: string;
}

export function MentionAutocomplete({
	value,
	onChange,
	pendingAgent,
	onPendingAgentChange,
	onSubmit,
	disabled,
	placeholder = "Ask anything — type @ to choose an agent...",
	defaultAgentHint,
}: MentionAutocompleteProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [mention, setMention] = useState<MentionContext | null>(null);
	const [highlighted, setHighlighted] = useState(0);

	const candidates = useMemo(
		() => (mention ? filterAgents(mention.query) : []),
		[mention],
	);

	// Reset highlight when candidate list changes shape.
	useEffect(() => {
		setHighlighted(0);
	}, [mention?.query]);

	const closeDropdown = () => setMention(null);

	const recomputeMention = (newValue: string, cursor: number) => {
		const ctx = findMentionContext(newValue, cursor);
		setMention(ctx);
	};

	const selectAgent = (agent: AgentDef) => {
		if (!mention) return;
		// Strip the `@xyz` substring; keep everything before and after.
		const before = value.slice(0, mention.start);
		const after = value.slice(mention.start + 1 + mention.query.length);
		const next = (before + after).replace(/\s+$/, "") + (after ? "" : "");
		onChange(next);
		onPendingAgentChange(agent.id);
		setMention(null);
		// Restore focus + cursor to the splice point.
		queueMicrotask(() => {
			const ta = textareaRef.current;
			if (!ta) return;
			ta.focus();
			const pos = before.length;
			ta.setSelectionRange(pos, pos);
		});
	};

	const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const next = e.target.value;
		const cursor = e.target.selectionStart ?? next.length;
		onChange(next);
		recomputeMention(next, cursor);
		// Auto-grow.
		const ta = e.target;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 100)}px`;
		ta.style.overflow = ta.scrollHeight > 100 ? "auto" : "hidden";
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Dropdown navigation takes priority when open.
		if (mention && candidates.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlighted((i) => (i + 1) % candidates.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlighted(
					(i) => (i - 1 + candidates.length) % candidates.length,
				);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				selectAgent(candidates[highlighted]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				closeDropdown();
				return;
			}
		}

		// Backspace at start of textarea while a chip is set: clear chip.
		if (
			e.key === "Backspace" &&
			pendingAgent &&
			textareaRef.current?.selectionStart === 0 &&
			textareaRef.current?.selectionEnd === 0
		) {
			e.preventDefault();
			onPendingAgentChange(null);
			return;
		}

		// Submit on Enter (no shift, no dropdown).
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSubmit();
		}
	};

	const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
		const ta = e.currentTarget;
		const cursor = ta.selectionStart ?? value.length;
		recomputeMention(value, cursor);
	};

	const chipAgent = pendingAgent ? getAgent(pendingAgent) : null;

	return (
		<div className="relative">
			{/* Dropdown — anchored above the input so it doesn't get clipped. */}
			{mention && candidates.length > 0 && (
				<div
					className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg overflow-hidden z-10"
					role="listbox"
					aria-label="Choose an agent"
				>
					{candidates.map((agent, i) => (
						<button
							key={agent.id}
							type="button"
							role="option"
							aria-selected={i === highlighted}
							onMouseDown={(e) => {
								// Prevent textarea blur before click registers.
								e.preventDefault();
								selectAgent(agent);
							}}
							onMouseEnter={() => setHighlighted(i)}
							className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs cursor-pointer bg-transparent border-0 ${
								i === highlighted
									? "bg-kumo-fill text-kumo-default"
									: "text-kumo-strong hover:bg-kumo-fill/50"
							}`}
						>
							<span className="flex items-center text-kumo-brand">
								{agent.icon}
							</span>
							<span className="font-medium">{agent.label}</span>
							<span className="text-kumo-subtle truncate">
								{agent.description}
							</span>
						</button>
					))}
				</div>
			)}

			{/* Composer row */}
			<div className="flex items-end gap-1.5">
				<div className="flex-1 flex items-start rounded-lg border border-kumo-line bg-kumo-control px-2 py-1 focus-within:ring-1 focus-within:ring-kumo-ring">
					{chipAgent && (
						<div className="flex items-center pt-1.5">
							<AgentChip
								agent={chipAgent}
								onClear={() => onPendingAgentChange(null)}
							/>
						</div>
					)}
					<textarea
						ref={textareaRef}
						id="unified-agent-chat-input"
						name="unified-agent-chat-input"
						value={value}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onSelect={handleSelect}
						placeholder={
							chipAgent
								? `Ask ${chipAgent.fullName}...`
								: defaultAgentHint
									? `${placeholder} (default: ${defaultAgentHint})`
									: placeholder
						}
						rows={1}
						aria-label="Chat message input"
						disabled={disabled}
						className="flex-1 resize-none bg-transparent border-0 px-1 py-1 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none min-h-[28px] max-h-[100px]"
						style={{ height: "auto", overflow: "hidden" }}
					/>
				</div>
				<Button
					variant="primary"
					shape="square"
					size="sm"
					disabled={disabled || !value.trim()}
					icon={<ArrowUpIcon size={14} weight="bold" />}
					onClick={onSubmit}
					aria-label="Send message"
				/>
			</div>
		</div>
	);
}
