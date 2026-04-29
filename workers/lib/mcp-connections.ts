// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Row helpers + TS types for the per-mailbox `mcp_connections` table.
 *
 * The DB row shape is the snake_case `McpConnectionRow`, matching the
 * SQLite column layout in `workers/durableObject/migrations.ts` migration
 * `17_add_mcp_connections` and the Drizzle declaration in
 * `workers/db/schema.ts#mcpConnections`. The application layer prefers a
 * camelCase `McpConnection` plus a parsed `enabledTools` allowlist —
 * conversion is mechanical via {@link rowToMcpConnection} /
 * {@link mcpConnectionToRow}.
 *
 * Phase 1 (this file) ships the helpers + tests only. Phase 2 wires them
 * into MailboxDO RPC; Phase 4 reads them while merging external MCP tools
 * into the LLM tool set; Phase 5 reads `enabledTools` to gate the audit
 * wrapper. Keep this module pure: no DO bindings, no `env`, no I/O —
 * everything must remain unit-testable inside the `tests/` Node runtime.
 */

import { z } from "zod";

/**
 * The three states our metadata layer records for a connection at the
 * moment of the last user-initiated mutation. The SDK's MCPConnectionState
 * has more values (e.g. `failed`, `connected`); we collapse them into this
 * narrower set because the metadata table is only consulted for UI display
 * and audit. Live state must always be read from `Agent.getMcpServers()`.
 */
export const MCP_CONNECTION_STATES = [
	"authenticating",
	"ready",
	"error",
] as const;
export type McpConnectionState = (typeof MCP_CONNECTION_STATES)[number];

const McpConnectionStateSchema = z.enum(MCP_CONNECTION_STATES);

/** Transport types accepted by Cloudflare's `Agent.addMcpServer`. */
export const MCP_TRANSPORT_TYPES = ["streamable-http", "sse"] as const;
export type McpTransportType = (typeof MCP_TRANSPORT_TYPES)[number];

const McpTransportTypeSchema = z.enum(MCP_TRANSPORT_TYPES);

/**
 * Per-server tool allowlist. `null` means "no allowlist — every tool
 * published by the server flows into the LLM". An empty array is the
 * kill-switch: the connection stays healthy but no tools reach the model.
 */
const EnabledToolsSchema = z.array(z.string().min(1));
export type EnabledTools = readonly string[];

/** Snake_case row shape, matching the SQLite columns 1:1. */
export interface McpConnectionRow {
	id: string;
	server_name: string;
	display_name: string | null;
	server_url: string;
	transport_type: McpTransportType | null;
	added_by_user_id: string;
	added_at: number;
	last_state: McpConnectionState;
	last_error: string | null;
	enabled_tools_json: string | null;
}

/** Application-layer TS shape consumed by the rest of the codebase. */
export interface McpConnection {
	id: string;
	serverName: string;
	displayName: string | null;
	serverUrl: string;
	transportType: McpTransportType | null;
	addedByUserId: string;
	addedAt: number;
	lastState: McpConnectionState;
	lastError: string | null;
	enabledTools: EnabledTools | null;
}

/**
 * Patch shape used when upserting. `lastError` is optional so the common
 * "happy path" upsert (state=ready) can omit it; everything else is
 * mandatory because the table has matching `NOT NULL` constraints.
 */
export type McpConnectionInput = Omit<McpConnection, "lastError"> & {
	lastError?: string | null;
};

/**
 * Thrown when {@link parseEnabledTools} encounters non-JSON or
 * non-string-array content. We keep this as a distinct class so callers
 * can catch serialisation issues separately from genuine validation
 * problems higher up the stack.
 */
export class McpConnectionSerializationError extends Error {
	override readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "McpConnectionSerializationError";
		this.cause = cause;
	}
}

export function parseEnabledTools(
	json: string | null,
): EnabledTools | null {
	if (json === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new McpConnectionSerializationError(
			`enabled_tools_json is not valid JSON (first 60 chars: ${json.slice(
				0,
				60,
			)})`,
			err,
		);
	}
	const result = EnabledToolsSchema.safeParse(parsed);
	if (!result.success) {
		throw new McpConnectionSerializationError(
			"enabled_tools_json must be a JSON array of non-empty strings",
			result.error,
		);
	}
	return result.data;
}

export function serializeEnabledTools(
	tools: EnabledTools | null,
): string | null {
	if (tools === null) return null;
	return JSON.stringify(tools);
}

export function rowToMcpConnection(row: McpConnectionRow): McpConnection {
	return {
		id: row.id,
		serverName: row.server_name,
		displayName: row.display_name,
		serverUrl: row.server_url,
		transportType: row.transport_type,
		addedByUserId: row.added_by_user_id,
		addedAt: row.added_at,
		lastState: row.last_state,
		lastError: row.last_error,
		enabledTools: parseEnabledTools(row.enabled_tools_json),
	};
}

export function mcpConnectionToRow(
	input: McpConnectionInput,
): McpConnectionRow {
	return {
		id: input.id,
		server_name: input.serverName,
		display_name: input.displayName,
		server_url: input.serverUrl,
		transport_type: input.transportType,
		added_by_user_id: input.addedByUserId,
		added_at: input.addedAt,
		last_state: input.lastState,
		last_error: input.lastError ?? null,
		enabled_tools_json: serializeEnabledTools(input.enabledTools),
	};
}

/**
 * Type-narrowing helper for state strings coming from external sources
 * (HTTP request bodies, SDK return values). Use {@link McpConnectionStateSchema}
 * directly if you want a structured Zod parse result.
 */
export function isMcpConnectionState(
	value: unknown,
): value is McpConnectionState {
	return McpConnectionStateSchema.safeParse(value).success;
}

/** Type-narrowing helper for transport strings. */
export function isMcpTransportType(value: unknown): value is McpTransportType {
	return McpTransportTypeSchema.safeParse(value).success;
}

// ── Phase 2 ─────────────────────────────────────────────────────────────────

/**
 * Compile-time-safe check for the `L4_MCP_ENABLED` feature flag.
 *
 * Once the flag is declared in `wrangler.jsonc` vars, the wrangler-generated
 * `Cloudflare.Env` type narrows it to its literal default value (e.g.
 * `"false"`), which would trip `TS2367` on a direct `=== "true"` comparison.
 * Wrapping the read in `String(...)` widens the result to `string`, so the
 * helper survives every possible flag state across deploys without an
 * `as` cast or `@ts-expect-error`.
 *
 * Plan reference: §118-138 ("Feature Flag Strategy"). Phase 1 is unconditional;
 * Phase 2-5 every externally-reachable code path must guard with this helper;
 * Phase 6 flips the wrangler default to `"true"`.
 */
export function isL4McpEnabled(env: { L4_MCP_ENABLED?: string }): boolean {
	return String(env.L4_MCP_ENABLED) === "true";
}

/**
 * Narrowed shape of `Agent.addMcpServer` return values consumed by Phase 2's
 * EmailAgent RPC. The Cloudflare SDK actually returns one of two discriminated
 * objects; we type-erase the discriminant to a plain `string` so
 * {@link buildConnectionFromSdkResult} stays a pure function testable in the
 * Node runtime without re-importing the SDK enum.
 */
export interface SdkAddResult {
	id: string;
	state: string;
	authUrl?: string;
}

/**
 * Translate a successful `Agent.addMcpServer` response plus owner metadata
 * into an {@link McpConnectionInput} ready for `MailboxDO.upsertMcpConnection`.
 *
 * Splitting the add flow into "SDK call → build input → DO upsert" keeps
 * the build step a pure function unit-testable in Node. Unknown SDK state
 * strings collapse to `"error"` so the metadata layer never persists a state
 * value the rest of the codebase cannot narrow.
 */
export function buildConnectionFromSdkResult(args: {
	serverName: string;
	serverUrl: string;
	displayName?: string;
	addedByUserId: string;
	addedAt: number;
	sdk: SdkAddResult;
}): McpConnectionInput {
	return {
		id: args.sdk.id,
		serverName: args.serverName,
		displayName: args.displayName ?? args.serverName,
		serverUrl: args.serverUrl,
		transportType: null,
		addedByUserId: args.addedByUserId,
		addedAt: args.addedAt,
		lastState: isMcpConnectionState(args.sdk.state) ? args.sdk.state : "error",
		enabledTools: null,
	};
}

/**
 * Discriminated outcome of `EmailAgent.addExternalMcpServer`.
 *
 * Phase 3 routes consume the `authenticating` variant to redirect the
 * browser to `authUrl`, and the `ready` variant to confirm immediate
 * success. Both variants carry the persisted {@link McpConnection} so the
 * UI can render the row before live state catches up.
 */
export type AddExternalMcpServerResult =
	| { state: "ready"; connection: McpConnection }
	| { state: "authenticating"; connection: McpConnection; authUrl: string };
