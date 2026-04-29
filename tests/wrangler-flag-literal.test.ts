// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cutover guard for the L4 MCP feature flag.
 *
 *   `wrangler.jsonc` MUST declare `L4_MCP_ENABLED` as a string literal
 *   ("true" or "false") under `vars`. The flag is read by
 *   `isL4McpEnabled(env)` as `String(env.L4_MCP_ENABLED) === "true"`,
 *   so a missing field, a boolean literal, or any non-"true"/"false"
 *   string would silently disable the feature on every deploy and
 *   break the single-SHA rollback contract documented in the L4
 *   Phase 6 plan (§492-570).
 *
 *   This test parses the file as JSONC (strips // and /-style comments
 *   plus trailing commas before JSON.parse) so a typo in the comment
 *   block above the flag does not disturb the assertion.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_PATH = resolve(HERE, "..", "wrangler.jsonc");

/**
 * Minimal JSONC stripper. Removes `//` line comments outside strings,
 * `/* ... *\/` block comments, and trailing commas before `}` / `]`.
 * Sufficient for the small `wrangler.jsonc` surface area; not a
 * general-purpose parser.
 */
function jsoncToJson(input: string): string {
	let out = "";
	let i = 0;
	let inString = false;
	let stringQuote = "";
	while (i < input.length) {
		const ch = input[i]!;
		const next = input[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\" && next !== undefined) {
				out += next;
				i += 2;
				continue;
			}
			if (ch === stringQuote) inString = false;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

describe("wrangler.jsonc — L4 feature-flag literal guard", () => {
	const raw = readFileSync(WRANGLER_PATH, "utf8");
	const parsed = JSON.parse(jsoncToJson(raw)) as {
		vars?: Record<string, unknown>;
	};

	it("declares L4_MCP_ENABLED inside vars", () => {
		expect(parsed.vars).toBeDefined();
		expect(parsed.vars).toHaveProperty("L4_MCP_ENABLED");
	});

	it("uses a string literal, not a boolean or other type", () => {
		const value = parsed.vars?.L4_MCP_ENABLED;
		expect(typeof value).toBe("string");
	});

	it("is set to either \"true\" or \"false\" exactly", () => {
		const value = parsed.vars?.L4_MCP_ENABLED as string;
		expect(["true", "false"]).toContain(value);
	});
});
