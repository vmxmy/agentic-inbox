import { defineConfig } from "vitest/config";

// Pure-function unit tests for the worker codebase. Tests live next to the
// code under `tests/` and exercise modules that do not need a real Cloudflare
// runtime (auth-context JWT round-trip, agent-config patch helpers, etc.).
//
// Tests that require DO/D1 bindings are deferred — when added, layer
// `@cloudflare/vitest-pool-workers` on top of this config rather than
// replacing it, so the pure tests stay fast.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		globals: false,
	},
});
