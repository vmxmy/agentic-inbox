// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { isL4BearerEnabled } from "../workers/lib/mcp-connections";

function readWranglerVars(): Record<string, string | undefined> {
	const json = readFileSync("wrangler.jsonc", "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n")
		.replace(/,\s*([}\]])/g, "$1");
	const parsed = JSON.parse(json) as {
		vars: Record<string, string | undefined>;
	};
	return parsed.vars;
}

describe("L4 P8 Bearer cutover config", () => {
	it("ships the Bearer sub-flag enabled in wrangler vars", () => {
		const vars = readWranglerVars();

		expect(vars.L4_MCP_ENABLED).toBe("true");
		expect(vars.L4_MCP_BEARER_ENABLED).toBe("true");
	});

	it("still fail-closes when the KEK secret is absent", () => {
		const vars = readWranglerVars();

		expect(isL4BearerEnabled(vars)).toBe(false);
		expect(
			isL4BearerEnabled({
				...vars,
				MCP_BEARER_KEK_CURRENT: "base64-kek-placeholder",
			}),
		).toBe(true);
	});
});
