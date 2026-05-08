// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Run a delegated sub-agent task with the parent's AbortSignal forwarded
 * to a remote `cancelTask(taskId)` RPC. When the user clicks stop on the
 * RouterAgent chat, the SDK aborts the parent stream — without this hook
 * the sub-agent's `generateText` would keep running on its own DO. The
 * abort listener is removed in `finally` so a completed task does not
 * leave a lingering reference to the AbortSignal.
 *
 * Lives in its own module (no `cloudflare:workers` / `agents` SDK imports)
 * so it can be unit-tested in vitest without spinning up a DO runtime.
 */
export function runAbortable<T>(
	signal: AbortSignal | undefined,
	taskId: string,
	cancel: (id: string) => Promise<void>,
	run: () => Promise<T>,
): Promise<T> {
	if (!signal) return run();
	const onAbort = () => {
		cancel(taskId).catch(() => undefined);
	};
	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return run().finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}
