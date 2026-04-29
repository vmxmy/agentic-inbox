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
