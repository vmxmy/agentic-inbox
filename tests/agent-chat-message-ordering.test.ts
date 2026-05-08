// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	compareByCreatedAt,
	messageSortKey,
	sortMessagesByCreatedAt,
} from "../app/components/agent-chat/messageOrdering";

describe("messageOrdering helpers", () => {
	const t = (iso: string) => ({ createdAt: new Date(iso) });

	it("sorts strictly ascending by createdAt", () => {
		const out = sortMessagesByCreatedAt([
			t("2026-05-08T10:05:00Z"),
			t("2026-05-08T10:00:00Z"),
			t("2026-05-08T10:10:00Z"),
		]);

		expect(out.map((m) => m.createdAt.toISOString())).toEqual([
			"2026-05-08T10:00:00.000Z",
			"2026-05-08T10:05:00.000Z",
			"2026-05-08T10:10:00.000Z",
		]);
	});

	it("places messages without createdAt at the end", () => {
		const out = sortMessagesByCreatedAt([
			{ createdAt: undefined },
			t("2026-05-08T10:00:00Z"),
			{ createdAt: undefined },
			t("2026-05-08T10:01:00Z"),
		]);

		expect(out.slice(0, 2).every((m) => m.createdAt instanceof Date)).toBe(true);
		expect(out.slice(2).every((m) => m.createdAt === undefined)).toBe(true);
	});

	it("repro: snapshot-late-after-optimistic does not invert order after sort", () => {
		const optimisticNew = { id: "opt-1", createdAt: new Date("2026-05-08T10:30:00Z") };
		const history = [
			{ id: "h-1", createdAt: new Date("2026-05-08T09:00:00Z") },
			{ id: "h-2", createdAt: new Date("2026-05-08T09:05:00Z") },
			{ id: "h-3", createdAt: new Date("2026-05-08T09:10:00Z") },
		];
		const inputAsRenderedBySDK = [optimisticNew, ...history];

		const ordered = sortMessagesByCreatedAt(inputAsRenderedBySDK);

		expect(ordered.map((m) => m.id)).toEqual(["h-1", "h-2", "h-3", "opt-1"]);
	});

	it("compareByCreatedAt returns 0 for equal timestamps", () => {
		const a = t("2026-05-08T10:00:00Z");
		const b = t("2026-05-08T10:00:00Z");
		expect(compareByCreatedAt(a, b)).toBe(0);
	});

	it("messageSortKey returns MAX_SAFE_INTEGER for missing createdAt", () => {
		expect(messageSortKey({ createdAt: undefined })).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("does not mutate the input array", () => {
		const input = [
			{ id: "new", createdAt: new Date("2026-05-08T10:30:00Z") },
			{ id: "old", createdAt: new Date("2026-05-08T09:00:00Z") },
		];

		const ordered = sortMessagesByCreatedAt(input);

		expect(input.map((m) => m.id)).toEqual(["new", "old"]);
		expect(ordered.map((m) => m.id)).toEqual(["old", "new"]);
	});
});
