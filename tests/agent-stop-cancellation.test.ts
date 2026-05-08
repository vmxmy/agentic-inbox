// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { runAbortable } from "../workers/router-agent/abortable";

/**
 * Regression suite for the agent-stop chain:
 *   client stop()
 *     → useAgentChat aborts the request
 *     → SDK passes options.abortSignal into onChatMessage
 *     → onChatMessage forwards it to streamText AND to runAbortable for
 *       any in-flight delegated sub-task (`stub.executeTask` on EmailAgent)
 *     → runAbortable triggers `stub.cancelTask(taskId)` so the sub-agent's
 *       generateText loop is aborted instead of finishing in the
 *       background.
 *
 * The unit under test is `runAbortable` — the small piece of logic that
 * binds the parent AbortSignal to a remote cancelTask RPC. The DO RPC
 * surface is mocked so the test can run inside vitest without spinning
 * up a Worker runtime.
 */
describe("runAbortable", () => {
	it("calls cancel(taskId) when the parent signal aborts mid-flight", async () => {
		// #given a parent AbortController, a fake task that resolves after
		// the parent aborts, and a cancel spy.
		const controller = new AbortController();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const taskId = "task-1";

		let resolveTask: (v: string) => void = () => undefined;
		const taskPromise = new Promise<string>((r) => { resolveTask = r; });

		// #when we kick off runAbortable and abort before the task resolves.
		const result = runAbortable(controller.signal, taskId, cancel, () => taskPromise);
		controller.abort();

		// #then the cancel(taskId) RPC fires synchronously on abort.
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledWith(taskId);

		// And the original task still resolves through (cleanup happens in finally).
		resolveTask("done");
		await expect(result).resolves.toBe("done");
	});

	it("does not call cancel when the task completes before the signal aborts", async () => {
		// #given a parent signal that never aborts and a task that resolves promptly.
		const controller = new AbortController();
		const cancel = vi.fn().mockResolvedValue(undefined);

		// #when the task finishes before any abort.
		const result = await runAbortable(
			controller.signal,
			"task-2",
			cancel,
			async () => "ok",
		);

		// #then cancel was never invoked.
		expect(result).toBe("ok");
		expect(cancel).not.toHaveBeenCalled();
	});

	it("calls cancel synchronously when the signal is already aborted", async () => {
		// #given a controller that is aborted before runAbortable starts.
		const controller = new AbortController();
		controller.abort();
		const cancel = vi.fn().mockResolvedValue(undefined);

		// #when runAbortable runs against the pre-aborted signal.
		await runAbortable(controller.signal, "task-3", cancel, async () => "done");

		// #then cancel was still invoked exactly once for the supplied taskId.
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledWith("task-3");
	});

	it("removes the abort listener after the task settles", async () => {
		// #given a real AbortSignal — its addEventListener is observable.
		const controller = new AbortController();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		// #when the task finishes successfully.
		await runAbortable(controller.signal, "task-4", cancel, async () => "ok");

		// #then the abort listener was unregistered (no leak).
		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("falls through to the inner runner when no signal is supplied", async () => {
		// #given no AbortSignal (the call site is not abort-aware).
		const cancel = vi.fn().mockResolvedValue(undefined);

		// #when runAbortable runs with undefined signal.
		const result = await runAbortable(undefined, "task-5", cancel, async () => 42);

		// #then the inner function ran and cancel was never touched.
		expect(result).toBe(42);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("swallows errors from the cancel RPC so a flaky sub-agent does not break the parent", async () => {
		// #given a cancel RPC that rejects (e.g. sub-agent already gone).
		const controller = new AbortController();
		const cancel = vi.fn().mockRejectedValue(new Error("sub-agent unreachable"));

		let resolveTask: (v: string) => void = () => undefined;
		const taskPromise = new Promise<string>((r) => { resolveTask = r; });

		// #when the parent aborts — the cancel rejection should not surface.
		const result = runAbortable(controller.signal, "task-6", cancel, () => taskPromise);
		controller.abort();
		// allow the rejected cancel promise to settle
		await new Promise((r) => setTimeout(r, 0));
		resolveTask("done");

		// #then the parent task still resolves cleanly.
		await expect(result).resolves.toBe("done");
		expect(cancel).toHaveBeenCalledWith("task-6");
	});
});
