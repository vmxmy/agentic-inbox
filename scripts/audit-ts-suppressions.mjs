#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Static audit for TypeScript error-suppression directives. Run in CI /
// pre-deploy to catch suppression regressions — a companion to `tsc --noEmit`
// which only flags *stale* `@ts-expect-error`; this script flags the shape of
// the suppression itself.
//
// Exit codes:
//   0 → clean
//   1 → findings (prints file:line)
//
// Rules:
//   1. `@ts-ignore`                       — FORBIDDEN always; use `@ts-expect-error`.
//   2. `@ts-expect-error` without reason  — must be followed on the same or
//                                           preceding line by a `// Reason:` or
//                                           a block comment whose first content
//                                           line starts with `Reason:`.
//
// Scope: workers/ + app/ + shared/, skips node_modules, dist, build, .react-router.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const TARGETS = ["workers", "app", "shared"];
const EXTS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".react-router",
	".wrangler",
	".cache",
]);

/** Recursively walk, collecting files under TARGETS. */
function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			walk(full, out);
		} else {
			const dot = name.lastIndexOf(".");
			const ext = dot < 0 ? "" : name.slice(dot);
			if (EXTS.has(ext)) out.push(full);
		}
	}
}

const files = [];
for (const dir of TARGETS) {
	try {
		walk(join(ROOT, dir), files);
	} catch (e) {
		if (e && e.code === "ENOENT") continue;
		throw e;
	}
}

const findings = [];
const TS_IGNORE = /(^|\s)\/\/\s*@ts-ignore\b|\/\*[\s\S]*?@ts-ignore\b/;
const TS_EXPECT = /(^|\s)\/\/\s*@ts-expect-error\b(.*)$/;

for (const file of files) {
	const src = readFileSync(file, "utf8");
	const lines = src.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (TS_IGNORE.test(line)) {
			findings.push({
				file,
				line: i + 1,
				kind: "ts-ignore",
				msg: "@ts-ignore is forbidden — use @ts-expect-error with a // Reason: comment",
			});
			continue;
		}
		const m = TS_EXPECT.exec(line);
		if (!m) continue;
		// Accept inline trailing reason: `// @ts-expect-error Reason: xyz`
		const trailing = (m[2] ?? "").trim();
		if (/^\s*:?\s*Reason:/i.test(trailing) || /^\s*—\s*Reason:/i.test(trailing)) continue;
		// Otherwise require a preceding or following `// Reason:` line.
		const prev = lines[i - 1] ?? "";
		const next = lines[i + 1] ?? "";
		const reasonRe = /\/\/\s*Reason:|\/\*\s*Reason:/i;
		if (reasonRe.test(prev) || reasonRe.test(next)) continue;
		findings.push({
			file,
			line: i + 1,
			kind: "ts-expect-error-unreasoned",
			msg: "@ts-expect-error without a `// Reason:` comment on the same or adjacent line",
		});
	}
}

if (findings.length === 0) {
	console.log(`audit-ts-suppressions: clean (${files.length} files scanned)`);
	process.exit(0);
}

for (const f of findings) {
	console.error(`${relative(ROOT, f.file)}:${f.line} [${f.kind}] ${f.msg}`);
}
console.error(`\n${findings.length} finding${findings.length === 1 ? "" : "s"}.`);
process.exit(1);
