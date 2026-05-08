// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clearHistory = vi.fn();
const setMessages = vi.fn();

vi.mock("agents/react", () => ({
	useAgent: () => ({}),
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
	useAgentChat: () => ({
		messages: [
			{
				id: "msg-1",
				role: "user",
				createdAt: new Date("2026-05-08T10:00:00Z"),
				parts: [{ type: "text", text: "hello" }],
			},
		],
		sendMessage: vi.fn(),
		status: "idle",
		setMessages,
		clearHistory,
		stop: vi.fn(),
	}),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPanel() {
	const { default: UnifiedAgentPanel } = await import(
		"../app/components/UnifiedAgentPanel"
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);

	const router = createMemoryRouter(
		[
			{
				path: "/mailbox/:mailboxId",
				element: React.createElement(UnifiedAgentPanel),
			},
		],
		{ initialEntries: ["/mailbox/test-mailbox"] },
	);

	await act(async () => {
		root?.render(React.createElement(RouterProvider, { router }));
	});

	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});

	const button = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Clear chat"]',
	);
	if (!button) throw new Error("Clear chat button not found");
	return button;
}

beforeEach(() => {
	clearHistory.mockReset();
	clearHistory.mockResolvedValue(undefined);
	setMessages.mockReset();
	vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
	if (root) {
		act(() => root?.unmount());
	}
	container?.remove();
	root = null;
	container = null;
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("UnifiedAgentPanel clear history", () => {
	it("calls clearHistory (not setMessages) when user confirms", async () => {
		const button = await renderPanel();

		await act(async () => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(window.confirm).toHaveBeenCalledWith(
			"Clear chat history for this mailbox? This cannot be undone.",
		);
		expect(clearHistory).toHaveBeenCalledTimes(1);
		expect(setMessages).not.toHaveBeenCalled();
	});

	it("does nothing when user cancels confirm", async () => {
		vi.mocked(window.confirm).mockReturnValue(false);
		const button = await renderPanel();

		await act(async () => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(clearHistory).not.toHaveBeenCalled();
		expect(setMessages).not.toHaveBeenCalled();
	});
});
