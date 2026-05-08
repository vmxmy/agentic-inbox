// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type MessageWithCreatedAt = {
	createdAt?: Date | string | number | null;
};

function readCreatedAt(msg: unknown): Date | string | number | null | undefined {
	return (msg as MessageWithCreatedAt | null | undefined)?.createdAt;
}

/**
 * Sort key for chat messages.
 * - Messages with a real createdAt sort by that timestamp ascending.
 * - Messages without createdAt fall to the end so optimistic or partial
 *   messages never invert against real persisted history.
 */
export function messageSortKey(msg: unknown): number {
	const createdAt = readCreatedAt(msg);
	if (!createdAt) return Number.MAX_SAFE_INTEGER;
	const timestamp = createdAt instanceof Date
		? createdAt.getTime()
		: new Date(createdAt).getTime();
	return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

export function compareByCreatedAt(
	a: unknown,
	b: unknown,
): number {
	return messageSortKey(a) - messageSortKey(b);
}

export function sortMessagesByCreatedAt<T>(
	messages: readonly T[],
): T[] {
	return [...messages].sort(compareByCreatedAt);
}
