// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import MentionAutocomplete from "../app/components/agent-chat/MentionAutocomplete";
import type { AgentId } from "../app/components/agent-chat/agents";

let roots: Root[] = [];
let containers: HTMLDivElement[] = [];

function renderMentionAutocomplete({
	value = "",
	onChange = vi.fn(),
	onSubmit = vi.fn(),
	pendingAgent = null,
	onPendingAgentChange = vi.fn(),
	canSubmit = true,
	placeholder = "Ask @email... type @ to switch",
}: {
	value?: string;
	onChange?: (value: string) => void;
	onSubmit?: () => void;
	pendingAgent?: AgentId | null;
	onPendingAgentChange?: (agent: AgentId | null) => void;
	canSubmit?: boolean;
	placeholder?: string;
} = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	containers.push(container);

	const root = createRoot(container);
	roots.push(root);

	act(() => {
		root.render(
			React.createElement(MentionAutocomplete, {
				value,
				onChange,
				onSubmit,
				pendingAgent,
				onPendingAgentChange,
				canSubmit,
				placeholder,
			}),
		);
	});

	const textarea = container.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Chat message input"]',
	);
	if (!textarea) throw new Error("MentionAutocomplete textarea not found");

	return { textarea, onChange, onSubmit, onPendingAgentChange };
}

function dispatchKeyDown(
	target: HTMLTextAreaElement,
	options: KeyboardEventInit & { isComposing?: boolean } = {},
) {
	const event = new KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		...options,
	});

	if ("isComposing" in options) {
		Object.defineProperty(event, "isComposing", {
			configurable: true,
			value: options.isComposing,
		});
	}

	act(() => {
		target.dispatchEvent(event);
	});

	return event;
}

afterEach(() => {
	for (const root of roots) {
		act(() => root.unmount());
	}
	for (const container of containers) {
		container.remove();
	}
	roots = [];
	containers = [];
	vi.restoreAllMocks();
});

describe("MentionAutocomplete IME composition guard", () => {
	it("does not call onSubmit when Enter pressed during IME composition", () => {
		const onSubmit = vi.fn();
		const { textarea } = renderMentionAutocomplete({ onSubmit });

		act(() => {
			textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		});
		dispatchKeyDown(textarea, {
			key: "Enter",
			code: "Enter",
			isComposing: true,
		});

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("calls onSubmit when Enter pressed after composition ended", () => {
		const onSubmit = vi.fn();
		const { textarea } = renderMentionAutocomplete({ value: "你好", onSubmit });

		act(() => {
			textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
			textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
		});
		dispatchKeyDown(textarea, {
			key: "Enter",
			code: "Enter",
			isComposing: false,
		});

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("ignores keyCode 229 even if isComposing is false (legacy IME signal)", () => {
		const onSubmit = vi.fn();
		const { textarea } = renderMentionAutocomplete({ onSubmit });

		dispatchKeyDown(textarea, {
			key: "Enter",
			code: "Enter",
			keyCode: 229,
			isComposing: false,
		});

		expect(onSubmit).not.toHaveBeenCalled();
	});
});
