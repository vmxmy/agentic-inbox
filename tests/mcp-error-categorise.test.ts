import { describe, it, expect } from "vitest";
import {
	BearerDecryptError,
	CATEGORIES,
	FALLBACK_CATEGORY,
	categoriseError,
} from "../workers/lib/mcp-token-crypto";

// Plan §93 acceptance: 30 fixture inputs cover real-world SDK / network /
// cryptographic error shapes. The whitelist is closed — any string that
// does not match a known category MUST collapse to FALLBACK_CATEGORY so
// the audit log never persists a raw token-shaped substring.

interface Fixture {
	label: string;
	error: unknown;
	expected: (typeof CATEGORIES)[number] | typeof FALLBACK_CATEGORY;
}

// 30 fixtures spanning every CATEGORIES entry plus the FALLBACK path.
// Token-shaped strings (PAT, JWT, AWS keys, raw bearer prefixes) are
// scattered across the inputs to verify they never trip a category they
// shouldn't.
const fixtures: Fixture[] = [
	// connect_failed (5)
	{
		label: "SDK 'Failed to connect' message",
		error: new Error("Failed to connect to MCP server at https://example.com"),
		expected: "connect_failed",
	},
	{
		label: "TCP ECONNREFUSED",
		error: new Error("connect ECONNREFUSED 127.0.0.1:9000"),
		expected: "connect_failed",
	},
	{
		label: "fetch failed (Node TypeError)",
		error: new TypeError("fetch failed"),
		expected: "connect_failed",
	},
	{
		label: "SDK with token prefix in connect message",
		error: new Error(
			"Failed to connect to MCP server: ghp_abc123def456GHIJ should not leak",
		),
		expected: "connect_failed",
	},
	{
		label: "SDK connect failed with JWT in URL",
		error: new Error(
			"Failed to connect to MCP server at https://x?token=eyJhbGciOiJIUzI1NiJ9.foo.bar",
		),
		expected: "connect_failed",
	},
	// unauthorized (5)
	{
		label: "UnauthorizedError class shape",
		error: Object.assign(new Error("session expired"), {
			name: "UnauthorizedError",
		}),
		expected: "unauthorized",
	},
	{ label: "raw 401 string", error: "401 Unauthorized", expected: "unauthorized" },
	{
		label: "OAuth invalid_token error code",
		error: new Error("invalid_token: scope insufficient"),
		expected: "unauthorized",
	},
	{ label: "forbidden 403", error: new Error("forbidden"), expected: "unauthorized" },
	{
		label: "401 with PAT-shape leak attempt",
		error: new Error(
			"401 Unauthorized — token sk-aBcDeFgHiJ0123456789 rejected",
		),
		expected: "unauthorized",
	},
	// timeout (3)
	{
		label: "operation timed out",
		error: new Error("operation timed out after 30s"),
		expected: "timeout",
	},
	{
		label: "ETIMEDOUT",
		error: new Error("ETIMEDOUT 1.2.3.4:443"),
		expected: "timeout",
	},
	{
		label: "request timeout",
		error: new Error("request timeout"),
		expected: "timeout",
	},
	// transport_error (4)
	{
		label: "SSE error: Non-200 status code (410)",
		error: new Error("SSE error: Non-200 status code (410)"),
		expected: "transport_error",
	},
	{
		label: "streamable-http negotiation failed",
		error: new Error("streamable-http negotiation failed"),
		expected: "transport_error",
	},
	{
		label: "transport closed unexpectedly",
		error: new Error("transport closed unexpectedly"),
		expected: "transport_error",
	},
	{
		label: "SSE error containing AKIA-shape leak",
		error: new Error("SSE error: AKIAIOSFODNN7EXAMPLE in upstream payload"),
		expected: "transport_error",
	},
	// injection_blocked (3)
	{
		label: "prompt injection blocked",
		error: new Error("prompt-injection screen blocked the response"),
		expected: "injection_blocked",
	},
	{
		label: "snake_case injection_blocked code",
		error: new Error("injection_blocked"),
		expected: "injection_blocked",
	},
	{
		label: "content blocked policy code",
		error: new Error("content_blocked: policy violation"),
		expected: "injection_blocked",
	},
	// decrypt_failed (3)
	{
		label: "BearerDecryptError class",
		error: new BearerDecryptError(),
		expected: "decrypt_failed",
	},
	{
		label: "AES-GCM auth failure",
		error: new Error("OperationError: AES-GCM tag check failed"),
		expected: "decrypt_failed",
	},
	{
		label: "decrypt_failed string",
		error: new Error("decrypt_failed"),
		expected: "decrypt_failed",
	},
	// discovery_failed (3)
	{
		label: "capability discovery failed",
		error: new Error("capability discovery failed"),
		expected: "discovery_failed",
	},
	{
		label: "listTools error",
		error: new Error("listTools returned an empty list unexpectedly"),
		expected: "discovery_failed",
	},
	{
		label: "discovery 503 from upstream",
		error: new Error("discovery 503 from upstream MCP server"),
		expected: "discovery_failed",
	},
	// FALLBACK (4)
	{
		label: "raw token without category context",
		error: new Error("ghp_abcdef1234567890GHIJKLMNOP"),
		expected: FALLBACK_CATEGORY,
	},
	{
		label: "JWT without category context",
		error: new Error(
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
		),
		expected: FALLBACK_CATEGORY,
	},
	{
		label: "AWS key shape without category context",
		error: new Error("AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG"),
		expected: FALLBACK_CATEGORY,
	},
	{
		label: "raw `Bearer X` prefix without category context",
		error: new Error("Authorization: Bearer abc123def456ghi789"),
		expected: FALLBACK_CATEGORY,
	},
];

describe("categoriseError — 30 fixtures cover every category plus FALLBACK", () => {
	it("has at least 30 fixtures", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(30);
	});

	it.each(fixtures)("$label", ({ error, expected }) => {
		// #given a real-world error shape
		// #when categorised
		const result = categoriseError(error);
		// #then the result matches the expected whitelist code (or FALLBACK)
		expect(result).toBe(expected);
	});

	it("never returns a value outside CATEGORIES ∪ FALLBACK", () => {
		const allowed = new Set<string>([...CATEGORIES, FALLBACK_CATEGORY]);
		for (const f of fixtures) {
			expect(allowed.has(categoriseError(f.error))).toBe(true);
		}
	});

	it("the categorised output is itself token-free for every fixture", () => {
		// #given fixtures where the input deliberately includes token-shaped substrings
		const tokenSubstrings = [
			"ghp_abcdef1234567890GHIJKLMNOP",
			"sk-aBcDeFgHiJ0123456789",
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
			"AKIAIOSFODNN7EXAMPLE",
			"abc123def456ghi789",
		];
		// #when categorised
		// #then no fixture's output contains any of the known token shapes
		for (const f of fixtures) {
			const out = categoriseError(f.error);
			for (const tok of tokenSubstrings) {
				expect(out.includes(tok)).toBe(false);
			}
		}
	});

	it("returns FALLBACK_CATEGORY for completely unknown errors", () => {
		expect(categoriseError(new Error("completely unrelated"))).toBe(
			FALLBACK_CATEGORY,
		);
		expect(categoriseError(undefined)).toBe(FALLBACK_CATEGORY);
		expect(categoriseError(null)).toBe(FALLBACK_CATEGORY);
		expect(categoriseError(42)).toBe(FALLBACK_CATEGORY);
		expect(categoriseError({})).toBe(FALLBACK_CATEGORY);
	});
});
