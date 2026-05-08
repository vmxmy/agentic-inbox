import { describe, it, expect } from "vitest";
import {
	MCP_AUTH_TYPES,
	isMcpAuthType,
	mcpConnectionToRow,
	rowToMcpConnection,
	type McpConnection,
	type McpConnectionRow,
} from "../workers/lib/mcp-connections";

const bearerRow: McpConnectionRow = {
	id: "bearer-1",
	server_name: "linear",
	display_name: "Linear (PAT)",
	server_url: "https://mcp.linear.app/sse",
	transport_type: null,
	added_by_user_id: "user-99",
	added_at: 1714389600000,
	last_state: "ready",
	last_error: null,
	enabled_tools_json: null,
	server_config_json: null,
	enterprise_credentials_encrypted_json: null,
	auth_type: "bearer",
	encrypted_token_b64: "AABBCC=",
	token_iv_b64: "DDEEFF==",
	token_salt_b64: "GGHHII==",
	token_envelope_version: 1,
	token_kek_version: 1,
};

const bearerConn: McpConnection = {
	id: "bearer-1",
	serverName: "linear",
	displayName: "Linear (PAT)",
	serverUrl: "https://mcp.linear.app/sse",
	transportType: null,
	addedByUserId: "user-99",
	addedAt: 1714389600000,
	lastState: "ready",
	lastError: null,
	enabledTools: null,
	authType: "bearer",
	serverConfig: null,
	enterpriseCredentialsEncryptedJson: null,
	encryptedTokenB64: "AABBCC=",
	tokenIvB64: "DDEEFF==",
	tokenSaltB64: "GGHHII==",
	tokenEnvelopeVersion: 1,
	tokenKekVersion: 1,
};

describe("MCP_AUTH_TYPES", () => {
	it("enumerates exactly the two supported auth modes", () => {
		expect(MCP_AUTH_TYPES).toEqual(["oauth", "bearer"]);
	});
});

describe("isMcpAuthType", () => {
	it("accepts every value in MCP_AUTH_TYPES", () => {
		for (const t of MCP_AUTH_TYPES) {
			expect(isMcpAuthType(t)).toBe(true);
		}
	});

	it("rejects unknown auth strings", () => {
		expect(isMcpAuthType("api_key")).toBe(false);
		expect(isMcpAuthType("none")).toBe(false);
		expect(isMcpAuthType("OAuth")).toBe(false); // case sensitive
	});

	it("rejects non-string inputs", () => {
		expect(isMcpAuthType(null)).toBe(false);
		expect(isMcpAuthType(undefined)).toBe(false);
		expect(isMcpAuthType(42)).toBe(false);
		expect(isMcpAuthType({})).toBe(false);
	});
});

describe("rowToMcpConnection — bearer row", () => {
	it("hoists every encrypted-blob column into the camelCase shape", () => {
		// #given a bearer row with all encrypted-blob columns populated
		// #when converted to the application shape
		const result = rowToMcpConnection(bearerRow);
		// #then the camelCase shape mirrors the snake_case row 1:1
		expect(result).toEqual(bearerConn);
	});

	it("preserves authType when the row's auth_type is 'bearer'", () => {
		const result = rowToMcpConnection(bearerRow);
		expect(result.authType).toBe("bearer");
	});

	it("preserves null encrypted-blob fields on an oauth row", () => {
		// #given an oauth row where every encrypted-blob column is NULL
		const oauthRow: McpConnectionRow = {
			...bearerRow,
			auth_type: "oauth",
			encrypted_token_b64: null,
			token_iv_b64: null,
			token_salt_b64: null,
			token_envelope_version: null,
			token_kek_version: null,
		};
		// #when converted
		const result = rowToMcpConnection(oauthRow);
		// #then every encrypted-blob field is null on the output
		expect(result.authType).toBe("oauth");
		expect(result.encryptedTokenB64).toBeNull();
		expect(result.tokenIvB64).toBeNull();
		expect(result.tokenSaltB64).toBeNull();
		expect(result.tokenEnvelopeVersion).toBeNull();
		expect(result.tokenKekVersion).toBeNull();
	});
});

describe("mcpConnectionToRow — bearer connection", () => {
	it("maps every camelCase field to its snake_case column", () => {
		// #given a bearer connection in the app shape
		// #when serialised to a row
		const row = mcpConnectionToRow(bearerConn);
		// #then the row matches the canonical snake_case fixture
		expect(row).toEqual(bearerRow);
	});

	it("round-trips a bearer connection through serialise + deserialise", () => {
		// #given the bearer fixture
		// #when round-tripped
		const back = rowToMcpConnection(mcpConnectionToRow(bearerConn));
		// #then nothing is lost
		expect(back).toEqual(bearerConn);
	});

	it("round-trips an oauth connection identically (regression for migration 19)", () => {
		// #given an oauth connection (encrypted-blob fields all null)
		const oauthConn: McpConnection = {
			...bearerConn,
			authType: "oauth",
			encryptedTokenB64: null,
			tokenIvB64: null,
			tokenSaltB64: null,
			tokenEnvelopeVersion: null,
			tokenKekVersion: null,
		};
		// #when round-tripped
		const back = rowToMcpConnection(mcpConnectionToRow(oauthConn));
		// #then nothing is lost — bearer migration must not corrupt oauth rows
		expect(back).toEqual(oauthConn);
	});
});
