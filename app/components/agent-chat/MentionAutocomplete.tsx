// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { ArrowUpIcon, XIcon } from "@phosphor-icons/react";
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	AGENTS,
	AGENTS_BY_ID,
	type AgentDef,
	type AgentId,
} from "./agents";

interface MentionAutocompleteProps {
	/** Plain text body of the message, without the agent chip — chip is held
	 *  in `pendingAgent` and rendered as a separate DOM node. */
	value: string;
	onChange: (value: string) => void;
	/** Called when the user presses Enter (no shift) and the dropdown is
	 *  closed — i.e. the user is committing the message. */
	onSubmit: () => void;
	/** Currently-mentioned agent chip, or `null` for the default-routing
	 *  state where the message goes to `defaultAgentLabel`. */
	pendingAgent: AgentId | null;
	onPendingAgentChange: (agent: AgentId | null) => void;
	/** Disables the submit button. Caller computes (typically `!value.trim()`). */
	canSubmit: boolean;
	/** Placeholder text. Caller varies by default agent, e.g. "Ask @email...
	 *  type @ to switch". */
	placeholder: string;
}

/**
 * Detect whether the cursor is positioned at the end of an `@<letters>`
 * sequence that could be a mention trigger. The `@` must be preceded by
 * whitespace or be at the start of the string — otherwise occurrences like
 * `user@example.com` get accidentally matched.
 */
function parseMentionTrigger(
	text: string,
	cursor: number,
): { active: boolean; filter: string; startIndex: number } {
	if (cursor < 0) return { active: false, filter: "", startIndex: -1 };
	let i = cursor;
	while (i > 0 && /[a-zA-Z0-9_-]/.test(text[i - 1])) i--;
	// `i` now points to the first letter (or to cursor if no letters).
	// The `@` must be at position i-1.
	if (i === 0 || text[i - 1] !== "@") {
		return { active: false, filter: "", startIndex: -1 };
	}
	const atIdx = i - 1;
	if (atIdx > 0 && !/\s/.test(text[atIdx - 1])) {
		return { active: false, filter: "", startIndex: -1 };
	}
	return { active: true, filter: text.slice(i, cursor), startIndex: atIdx };
}

/**
 * Composer with `@`-mention agent picker. Tracks a chip (`pendingAgent`)
 * separately from the textarea body — chip is its own state, held by the
 * parent, never rendered into the textarea text.
 *
 * Keyboard behaviour:
 *   - Type `@` after whitespace (or at start)  → dropdown opens
 *   - Continue typing                          → filter narrows
 *   - ↑ / ↓                                    → navigate dropdown
 *   - Enter (or Tab) on dropdown               → select highlighted agent
 *   - Esc on dropdown                          → close without selecting
 *   - Enter (no shift) outside dropdown        → onSubmit
 *   - Backspace at pos 0 with chip set         → clears chip
 */
export default function MentionAutocomplete({
	value,
	onChange,
	onSubmit,
	pendingAgent,
	onPendingAgentChange,
	canSubmit,
	placeholder,
}: MentionAutocompleteProps) {
	const [trigger, setTrigger] = useState<{
		active: boolean;
		filter: string;
		startIndex: number;
	}>({ active: false, filter: "", startIndex: -1 });
	const [highlighted, setHighlighted] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const filteredAgents: AgentDef[] = useMemo(() => {
		if (!trigger.active) return AGENTS;
		const f = trigger.filter.toLowerCase();
		return AGENTS.filter((a) => a.label.toLowerCase().startsWith(f));
	}, [trigger]);

	// Reset highlight when the filter list changes shape
	useEffect(() => {
		setHighlighted(0);
	}, [filteredAgents.length, trigger.active]);

	const dropdownOpen = trigger.active && filteredAgents.length > 0;

	const closeTrigger = () =>
		setTrigger({ active: false, filter: "", startIndex: -1 });

	const selectAgent = (id: AgentId) => {
		if (trigger.active) {
			const before = value.slice(0, trigger.startIndex);
			const after = value.slice(trigger.startIndex + 1 + trigger.filter.length);
			// Trim a single leading whitespace so chip + body don't accumulate
			// stray spaces from "send to @inv|" → "send to|"
			onChange((before + after).replace(/^[ \t]+/, ""));
		}
		onPendingAgentChange(id);
		closeTrigger();
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	const handleChange = (next: string, cursor: number | null) => {
		onChange(next);
		setTrigger(parseMentionTrigger(next, cursor ?? next.length));
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (dropdownOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlighted((i) => (i + 1) % filteredAgents.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlighted(
					(i) => (i - 1 + filteredAgents.length) % filteredAgents.length,
				);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				selectAgent(filteredAgents[highlighted].id);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				closeTrigger();
				return;
			}
			// Other keys fall through to default textarea behaviour; trigger
			// state updates via the next onChange.
			return;
		}
		// Dropdown is closed.
		if (e.key === "Backspace") {
			const target = e.currentTarget;
			if (
				target.selectionStart === 0 &&
				target.selectionEnd === 0 &&
				pendingAgent
			) {
				e.preventDefault();
				onPendingAgentChange(null);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSubmit();
		}
	};

	return (
		<div className="relative">
			{dropdownOpen && (
				<div
					ref={dropdownRef}
					className="absolute bottom-full left-0 right-0 mb-1 bg-kumo-elevated border border-kumo-line rounded-lg shadow-lg overflow-hidden z-10 max-h-60 overflow-y-auto"
					role="listbox"
					aria-label="Mention agent"
				>
					{filteredAgents.map((a, idx) => (
						<button
							type="button"
							key={a.id}
							role="option"
							aria-selected={highlighted === idx}
							// onMouseDown prevents textarea blur, so onClick still fires
							// while the textarea retains focus through the selection.
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => selectAgent(a.id)}
							onMouseEnter={() => setHighlighted(idx)}
							className={`w-full flex items-center gap-2 px-3 py-2 text-left bg-transparent cursor-pointer ${
								highlighted === idx
									? "bg-kumo-fill"
									: "hover:bg-kumo-fill/50"
							}`}
						>
							<span className="text-kumo-brand shrink-0">{a.icon}</span>
							<span className="text-xs font-semibold text-kumo-default shrink-0">
								@{a.label}
							</span>
							<span className="text-xs text-kumo-subtle truncate min-w-0">
								{a.description}
							</span>
						</button>
					))}
				</div>
			)}

			<div className="flex items-end gap-1.5">
				<div className="flex-1 flex items-stretch gap-1 rounded-lg border border-kumo-line bg-kumo-control px-1 focus-within:ring-1 focus-within:ring-kumo-ring min-w-0">
					{pendingAgent && (
						<div className="flex items-center gap-1 self-center my-1.5 ml-1.5 px-2 py-1 rounded-md bg-kumo-brand/10 text-kumo-brand shrink-0">
							<span className="shrink-0">
								{AGENTS_BY_ID[pendingAgent].icon}
							</span>
							<span className="text-[11px] font-semibold leading-none">
								@{AGENTS_BY_ID[pendingAgent].label}
							</span>
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => onPendingAgentChange(null)}
								className="ml-0.5 -mr-0.5 cursor-pointer flex items-center justify-center rounded hover:bg-kumo-brand/20 p-0.5 bg-transparent border-0"
								aria-label="Remove agent mention"
							>
								<XIcon size={10} weight="bold" />
							</button>
						</div>
					)}
					<textarea
						ref={textareaRef}
						id="unified-chat-input"
						name="unified-chat-input"
						value={value}
						onChange={(e) => handleChange(e.target.value, e.target.selectionStart)}
						onKeyDown={handleKeyDown}
						onSelect={(e) => {
							const t = e.target as HTMLTextAreaElement;
							setTrigger(parseMentionTrigger(t.value, t.selectionStart ?? t.value.length));
						}}
						placeholder={placeholder}
						rows={1}
						aria-label="Chat message input"
						className="flex-1 resize-none bg-transparent px-2 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none min-h-[36px] max-h-[100px] min-w-0"
						style={{ height: "auto", overflow: "hidden" }}
						onInput={(e) => {
							const t = e.target as HTMLTextAreaElement;
							t.style.height = "auto";
							t.style.height = `${Math.min(t.scrollHeight, 100)}px`;
							t.style.overflow = t.scrollHeight > 100 ? "auto" : "hidden";
						}}
					/>
				</div>
				<Button
					variant="primary"
					shape="square"
					size="sm"
					disabled={!canSubmit}
					icon={<ArrowUpIcon size={14} weight="bold" />}
					onClick={onSubmit}
					aria-label="Send message"
				/>
			</div>
		</div>
	);
}
