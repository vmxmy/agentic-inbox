import { describe, it, expect } from "vitest";
import {
	MCP_CONNECTION_STATES,
	MCP_TRANSPORT_TYPES,
	McpConnectionSerializationError,
	buildConnectionFromSdkResult,
	isL4McpEnabled,
	isMcpConnectionState,
	isMcpTransportType,
	mcpConnectionToRow,
	parseEnabledTools,
	rowToMcpConnection,
	serializeEnabledTools,
	type McpConnection,
	type McpConnectionInput,
	type McpConnectionRow,
} from "../workers/lib/mcp-connections";

const sampleRow: McpConnectionRow = {
	id: "abc-123",
	server_name: "github",
	display_name: "GitHub Issues",
	server_url: "https://mcp.github.com/sse",
	transport_type: "sse",
	added_by_user_id: "user-42",
	added_at: 1714389600000,
	last_state: "ready",
	last_error: null,
	enabled_tools_json: JSON.stringify(["create_issue"]),
};

const sampleConn: McpConnection = {
	id: "abc-123",
	serverName: "github",
	displayName: "GitHub Issues",
	serverUrl: "https://mcp.github.com/sse",
	transportType: "sse",
	addedByUserId: "user-42",
	addedAt: 1714389600000,
	lastState: "ready",
	lastError: null,
	enabledTools: ["create_issue"],
};

describe("constants", () => {
	it("MCP_CONNECTION_STATES enumerates the application-visible states", () => {
		// #given the closed set of states the metadata layer records
		// #then they match the Phase 1 schema design exactly
		expect(MCP_CONNECTION_STATES).toEqual([
			"authenticating",
			"ready",
			"error",
		]);
	});

	it("MCP_TRANSPORT_TYPES matches Cloudflare addMcpServer overloads", () => {
		expect(MCP_TRANSPORT_TYPES).toEqual(["streamable-http", "sse"]);
	});
});

describe("parseEnabledTools", () => {
	it("returns null when input is null (= every tool exposed)", () => {
		// #given a NULL allowlist column
		// #when parsed
		const result = parseEnabledTools(null);
		// #then the application shape is also null
		expect(result).toBeNull();
	});

	it("returns an empty array when JSON is `[]` (= kill-switch)", () => {
		// #given the kill-switch row
		const result = parseEnabledTools("[]");
		// #then we get an empty array (NOT null) so callers can distinguish
		expect(result).toEqual([]);
	});

	it("parses a non-empty allowlist preserving order", () => {
		// #given a normal allowlist
		const result = parseEnabledTools(JSON.stringify(["search", "read"]));
		// #then the array round-trips intact
		expect(result).toEqual(["search", "read"]);
	});

	it("throws McpConnectionSerializationError on invalid JSON", () => {
		// #given a corrupt row (e.g. truncated write)
		// #when parsed
		// #then a typed error surfaces — generic SyntaxError must not leak
		expect(() => parseEnabledTools("{not json")).toThrow(
			McpConnectionSerializationError,
		);
	});

	it("throws when JSON is not a string array (object)", () => {
		// #given a row whose JSON is structured but wrong-typed
		// #then the typed error fires before downstream code can crash
		expect(() =>
			parseEnabledTools(JSON.stringify({ wrong: "shape" })),
		).toThrow(McpConnectionSerializationError);
	});

	it("throws when JSON contains non-string elements", () => {
		// #given a row with a numeric tool name slipped in
		// #then we reject before the LLM tool merge can be confused
		expect(() => parseEnabledTools(JSON.stringify(["ok", 42]))).toThrow(
			McpConnectionSerializationError,
		);
	});

	it("throws when JSON contains an empty string", () => {
		// #given a row where someone serialised an empty tool name
		// #then we reject — empty tool name has no meaning in the SDK key shape
		expect(() => parseEnabledTools(JSON.stringify([""]))).toThrow(
			McpConnectionSerializationError,
		);
	});

	it("attaches the original error as `cause`", () => {
		// #given an invalid JSON input
		// #when caught
		// #then the original parse error is preserved for diagnostics
		try {
			parseEnabledTools("not json");
			expect.unreachable("parseEnabledTools should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(McpConnectionSerializationError);
			expect((err as McpConnectionSerializationError).cause).toBeDefined();
		}
	});
});

describe("serializeEnabledTools", () => {
	it("returns null for null", () => {
		expect(serializeEnabledTools(null)).toBeNull();
	});

	it("serialises an empty array as `[]`", () => {
		// #given the kill-switch shape
		// #then serialisation preserves it (NULL is reserved for "no allowlist")
		expect(serializeEnabledTools([])).toBe("[]");
	});

	it("round-trips with parseEnabledTools", () => {
		// #given an arbitrary allowlist
		const original = ["create_issue", "list_repos"];
		// #when serialised then re-parsed
		const reparsed = parseEnabledTools(serializeEnabledTools(original));
		// #then the data is identical
		expect(reparsed).toEqual(original);
	});
});

describe("rowToMcpConnection", () => {
	it("maps every snake_case column to its camelCase counterpart", () => {
		// #given a fully-populated row
		const result = rowToMcpConnection(sampleRow);
		// #then every field is wired correctly
		expect(result).toEqual(sampleConn);
	});

	it("preserves null nullable fields verbatim", () => {
		// #given a row where every nullable column is NULL
		const result = rowToMcpConnection({
			...sampleRow,
			display_name: null,
			transport_type: null,
			last_error: null,
			enabled_tools_json: null,
		});
		// #then nulls propagate untouched (no implicit defaults)
		expect(result.displayName).toBeNull();
		expect(result.transportType).toBeNull();
		expect(result.lastError).toBeNull();
		expect(result.enabledTools).toBeNull();
	});

	it("handles the kill-switch (empty allowlist) without converting to null", () => {
		// #given a row where the owner explicitly disabled every tool
		const result = rowToMcpConnection({
			...sampleRow,
			enabled_tools_json: "[]",
		});
		// #then enabledTools is `[]` not `null` — kill-switch must be observable
		expect(result.enabledTools).toEqual([]);
	});
});

describe("mcpConnectionToRow", () => {
	it("maps every camelCase field to its snake_case column", () => {
		const row = mcpConnectionToRow(sampleConn);
		expect(row).toEqual(sampleRow);
	});

	it("treats omitted lastError as null (happy-path upsert)", () => {
		// #given an upsert payload without a lastError
		const minimal: McpConnectionInput = {
			id: "x",
			serverName: "y",
			displayName: null,
			serverUrl: "https://example.test/mcp",
			transportType: null,
			addedByUserId: "user-1",
			addedAt: 0,
			lastState: "ready",
			enabledTools: null,
			// lastError intentionally omitted
		};
		// #when serialised
		const row = mcpConnectionToRow(minimal);
		// #then the column is NULL — required because the column allows NULL
		expect(row.last_error).toBeNull();
	});

	it("round-trips through rowToMcpConnection without loss", () => {
		// #given the canonical sample
		// #when serialised then deserialised
		const back = rowToMcpConnection(mcpConnectionToRow(sampleConn));
		// #then nothing changed
		expect(back).toEqual(sampleConn);
	});

	it("round-trips a record with a kill-switch allowlist", () => {
		// #given a connection in kill-switch mode
		const conn = { ...sampleConn, enabledTools: [] };
		// #when round-tripped
		const back = rowToMcpConnection(mcpConnectionToRow(conn));
		// #then empty array is preserved (NOT collapsed to null)
		expect(back.enabledTools).toEqual([]);
	});
});

describe("isMcpConnectionState", () => {
	it("accepts every value in MCP_CONNECTION_STATES", () => {
		for (const state of MCP_CONNECTION_STATES) {
			expect(isMcpConnectionState(state)).toBe(true);
		}
	});

	it("rejects unknown strings", () => {
		// #given an SDK state we deliberately do not surface
		expect(isMcpConnectionState("disconnected")).toBe(false);
	});

	it("rejects non-string inputs", () => {
		expect(isMcpConnectionState(null)).toBe(false);
		expect(isMcpConnectionState(undefined)).toBe(false);
		expect(isMcpConnectionState(123)).toBe(false);
		expect(isMcpConnectionState({})).toBe(false);
	});
});

describe("isMcpTransportType", () => {
	it("accepts every value in MCP_TRANSPORT_TYPES", () => {
		for (const t of MCP_TRANSPORT_TYPES) {
			expect(isMcpTransportType(t)).toBe(true);
		}
	});

	it("rejects unknown transports", () => {
		// #given a transport the SDK does not support today
		expect(isMcpTransportType("ws")).toBe(false);
	});

	it("rejects non-string inputs", () => {
		expect(isMcpTransportType(undefined)).toBe(false);
		expect(isMcpTransportType(null)).toBe(false);
	});
});

describe("isL4McpEnabled (Phase 2)", () => {
	it("returns true only for the literal string 'true'", () => {
		// #given the flag explicitly enabled
		expect(isL4McpEnabled({ L4_MCP_ENABLED: "true" })).toBe(true);
	});

	it("returns false when the flag is missing entirely", () => {
		// #given an env where wrangler.jsonc has not declared the var yet
		// #when checked
		// #then the helper defaults to disabled (matching plan §123 default)
		expect(isL4McpEnabled({})).toBe(false);
	});

	it("returns false for the literal string 'false'", () => {
		expect(isL4McpEnabled({ L4_MCP_ENABLED: "false" })).toBe(false);
	});

	it("returns false for truthy-looking but non-'true' values", () => {
		// #given runtime nonsense that string-coerces awkwardly
		// #then we never let the flag flip on by accident
		expect(isL4McpEnabled({ L4_MCP_ENABLED: "TRUE" })).toBe(false);
		expect(isL4McpEnabled({ L4_MCP_ENABLED: "1" })).toBe(false);
		expect(isL4McpEnabled({ L4_MCP_ENABLED: "" })).toBe(false);
	});

	it("returns false when the value is undefined", () => {
		// `String(undefined)` produces 'undefined' — must not equal 'true'
		expect(isL4McpEnabled({ L4_MCP_ENABLED: undefined })).toBe(false);
	});
});

describe("buildConnectionFromSdkResult (Phase 2)", () => {
	const baseArgs = {
		serverName: "github",
		serverUrl: "https://mcp.github.com/sse",
		addedByUserId: "user-42",
		addedAt: 1714389600000,
	} as const;

	it("maps a 'ready' SDK response to McpConnectionInput", () => {
		// #given a successful immediate connection
		const input = buildConnectionFromSdkResult({
			...baseArgs,
			sdk: { id: "abc-123", state: "ready" },
		});
		// #then every field is wired and lastState narrows to 'ready'
		expect(input.id).toBe("abc-123");
		expect(input.serverName).toBe("github");
		expect(input.serverUrl).toBe("https://mcp.github.com/sse");
		expect(input.lastState).toBe("ready");
		expect(input.addedByUserId).toBe("user-42");
		expect(input.addedAt).toBe(1714389600000);
		expect(input.transportType).toBeNull();
		expect(input.enabledTools).toBeNull();
	});

	it("maps an 'authenticating' SDK response with authUrl present", () => {
		// #given an OAuth-required connection (authUrl ignored by the input shape)
		const input = buildConnectionFromSdkResult({
			...baseArgs,
			sdk: {
				id: "def-456",
				state: "authenticating",
				authUrl: "https://github.com/login/oauth/authorize?...",
			},
		});
		expect(input.lastState).toBe("authenticating");
		// authUrl is consumed by EmailAgent's discriminated return type, not by
		// the McpConnectionInput; ensure the build helper does not leak it
		expect(input).not.toHaveProperty("authUrl");
	});

	it("collapses unknown SDK state strings to 'error'", () => {
		// #given an SDK that returns a state outside our narrowed enum
		const input = buildConnectionFromSdkResult({
			...baseArgs,
			sdk: { id: "ghi-789", state: "connecting" },
		});
		// #then we persist 'error' rather than a string the rest of the
		// codebase cannot narrow — fail-safe principle
		expect(input.lastState).toBe("error");
	});

	it("defaults displayName to serverName when omitted", () => {
		const input = buildConnectionFromSdkResult({
			...baseArgs,
			sdk: { id: "x", state: "ready" },
		});
		expect(input.displayName).toBe("github");
	});

	it("uses an explicit displayName when provided", () => {
		const input = buildConnectionFromSdkResult({
			...baseArgs,
			displayName: "GitHub Issues (Org)",
			sdk: { id: "x", state: "ready" },
		});
		expect(input.displayName).toBe("GitHub Issues (Org)");
	});

	it("round-trips through mcpConnectionToRow + rowToMcpConnection", () => {
		// #given the helper output is consumed by the existing P1 helpers
		const input = buildConnectionFromSdkResult({
			...baseArgs,
			sdk: { id: "abc-123", state: "ready" },
		});
		// #when serialised and re-read
		const back = rowToMcpConnection(mcpConnectionToRow(input));
		// #then nothing is lost (lastError defaults to null on the input shape)
		expect(back).toEqual({
			...input,
			lastError: null,
		} satisfies McpConnection);
	});
});
