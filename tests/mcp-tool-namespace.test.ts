import { describe, it, expect } from "vitest";
import {
	namespaceTool,
	parseNamespacedKey,
	parseSdkToolKey,
} from "../workers/lib/mcp-tool-namespace";

describe("parseSdkToolKey", () => {
	it("returns null for empty input", () => {
		// #given an empty string
		// #then no parse is possible
		expect(parseSdkToolKey("", ["abc-123"])).toBeNull();
	});

	it("returns null when the SDK 'tool_' prefix is missing", () => {
		// #given a key the SDK could not have produced
		// #then we refuse to invent a namespace
		expect(parseSdkToolKey("abc123_search", ["abc-123"])).toBeNull();
	});

	it("extracts a toolName containing a single underscore", () => {
		// #given the SDK produced `tool_${stripped}_${toolName}` with a multi-word tool
		// #when parsed against the matching connId
		const result = parseSdkToolKey("tool_abc123_create_issue", ["abc-123"]);
		// #then the connId reconstructs (dashes restored from known list) and toolName preserves underscores
		expect(result).toEqual({ connId: "abc-123", toolName: "create_issue" });
	});

	it("extracts a toolName containing multiple underscores", () => {
		// #given a tool whose name itself contains many underscores
		const result = parseSdkToolKey("tool_abc123_a_b_c", ["abc-123"]);
		// #then the toolName slice preserves every separator past the first
		expect(result).toEqual({ connId: "abc-123", toolName: "a_b_c" });
	});

	it("greedy-prefix: picks the longest stripped-connId match (regression)", () => {
		// #given two connIds where one stripped form is a prefix of the other
		const knownConnIds = ["abc", "abcdef"];
		// #when the SDK key starts with the longer stripped form
		const result = parseSdkToolKey("tool_abcdef_search", knownConnIds);
		// #then the longer connId wins — first-match would have produced
		// {connId:"abc", toolName:"def_search"}, which is wrong attribution
		expect(result).toEqual({ connId: "abcdef", toolName: "search" });
	});

	it("returns null when no known connId matches (race: connection deleted)", () => {
		// #given the connection list no longer contains the connId the SDK key encodes
		// #when parsed
		const result = parseSdkToolKey("tool_xyz999_search", ["abc-123"]);
		// #then we drop the tool rather than misattribute it
		expect(result).toBeNull();
	});

	it("reconstructs a connId that originally contained dashes", () => {
		// #given the SDK strips dashes when building tool keys
		const result = parseSdkToolKey("tool_abc123_search", ["abc-123"]);
		// #then the parser recovers the original dashed id from the known list
		expect(result?.connId).toBe("abc-123");
	});
});

describe("namespaceTool", () => {
	it("produces the canonical mcp__<connId>__<toolName> shape", () => {
		// #given a connection id and tool name
		// #when namespaced for the LLM tool map
		// #then the literal prefix and double-underscore separator are used
		expect(namespaceTool("abc-123", "search")).toBe("mcp__abc-123__search");
	});

	it("preserves dashes in connId verbatim", () => {
		// #given an id with multiple dashes
		// #then dashes are NOT stripped — only the SDK side does that
		expect(namespaceTool("abc-def-123", "search")).toBe(
			"mcp__abc-def-123__search",
		);
	});
});

describe("parseNamespacedKey", () => {
	it("returns null when the mcp__ prefix is missing", () => {
		// #given a key not produced by namespaceTool
		expect(parseNamespacedKey("foo__bar")).toBeNull();
	});

	it("returns null when there is no __ separator after the prefix", () => {
		// #given a malformed key with the prefix but no separator
		expect(parseNamespacedKey("mcp__no-separator-here")).toBeNull();
	});

	it("splits on the first __ separator", () => {
		// #given a normal namespaced key
		const result = parseNamespacedKey("mcp__abc-123__search");
		// #then connId comes before, toolName after
		expect(result).toEqual({ connId: "abc-123", toolName: "search" });
	});

	it("preserves underscores in toolName", () => {
		// #given a tool name with single underscores
		const result = parseNamespacedKey("mcp__abc-123__create_issue");
		// #then the toolName retains its single underscores
		expect(result).toEqual({ connId: "abc-123", toolName: "create_issue" });
	});
});

describe("namespaceTool round-trips with parseNamespacedKey", () => {
	it("round-trips an ascii tool name", () => {
		// #given simple ascii inputs
		const key = namespaceTool("abc-123", "search");
		// #when parsed back
		const parsed = parseNamespacedKey(key);
		// #then we recover the originals
		expect(parsed).toEqual({ connId: "abc-123", toolName: "search" });
	});

	it("round-trips a tool name containing underscores", () => {
		// #given a tool name with underscores
		const key = namespaceTool("abc-123", "create_issue");
		// #when parsed back
		const parsed = parseNamespacedKey(key);
		// #then underscores in toolName survive the round-trip
		expect(parsed).toEqual({ connId: "abc-123", toolName: "create_issue" });
	});

	it("round-trips a connId that contains dashes", () => {
		// #given an id with dashes — must NOT be collapsed by namespaceTool
		const key = namespaceTool("abc-def-123", "search");
		// #then the namespaced key still encodes the dashed form verbatim
		expect(key).toContain("abc-def-123");
		// #and the parse step recovers it intact
		const parsed = parseNamespacedKey(key);
		expect(parsed).toEqual({ connId: "abc-def-123", toolName: "search" });
	});
});
