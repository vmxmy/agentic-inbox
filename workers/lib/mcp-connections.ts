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
import type { EnvelopeV1 } from "./mcp-token-crypto";
import {
	type BearerKekEnv,
	encryptBearerToken,
	decryptBearerToken,
} from "./mcp-token-crypto";

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
 * L4 P8 authentication mode. `oauth` uses the SDK's OAuth provider flow;
 * `bearer` carries an encrypted static token whose plaintext is injected
 * into outbound requests via a `transport.fetch` closure that never
 * crosses the SDK's `JSON.stringify(server_options)` persistence path.
 *
 * Migration 19 sets `auth_type` to `'oauth'` for every row that existed
 * before the cutover, so the union below stays exhaustive without a
 * separate "unknown" branch. Phase 2 will gate the `'bearer'` branch
 * behind `L4_MCP_BEARER_ENABLED`.
 */
export const MCP_AUTH_TYPES = ["oauth", "bearer"] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

const McpAuthTypeSchema = z.enum(MCP_AUTH_TYPES);

/**
 * Plaintext provider metadata stored in `server_config_json`.
 * Provider-specific branches keep known config narrow while allowing
 * forward-compatible display/routing fields.
 */
export type ServerConfig =
	| { providerType: "google-contacts"; scopes?: string[]; [k: string]: unknown }
	| {
			providerType: "microsoft-graph";
			scopes?: string[];
			tenantId?: string;
			[k: string]: unknown;
		}
	| { providerType: "generic"; [k: string]: unknown };

export const ServerConfigSchema = z.discriminatedUnion("providerType", [
	z.object({
		providerType: z.literal("google-contacts"),
		scopes: z.array(z.string()).optional(),
	}).passthrough(),
	z.object({
		providerType: z.literal("microsoft-graph"),
		scopes: z.array(z.string()).optional(),
		tenantId: z.string().optional(),
	}).passthrough(),
	z.object({
		providerType: z.literal("generic"),
	}).passthrough(),
]);

export const PROVIDER_CREDENTIAL_REGISTRY: Record<
	string,
	{ envPrefix: string; defaultScopes: string[] }
> = {
	"google-contacts": {
		envPrefix: "GOOGLE_CONTACTS",
		defaultScopes: ["https://www.googleapis.com/auth/contacts.readonly"],
	},
	"microsoft-graph": {
		envPrefix: "MICROSOFT_GRAPH",
		defaultScopes: ["Contacts.Read"],
	},
};

export const EnterpriseCredentialsSchema = z.object({
	clientId: z.string(),
	clientSecret: z.string(),
	scopes: z.array(z.string()).optional(),
});

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
	// Flexible config (migration 21). `server_config_json` is plaintext;
	// `enterprise_credentials_encrypted_json` is an encrypted JSON envelope.
	server_config_json: string | null;
	enterprise_credentials_encrypted_json: string | null;
	// L4 P8 — Bearer auth (migration 19). The five encrypted-blob columns
	// are NULL for `oauth` rows. For `bearer` rows they together form an
	// `EnvelopeV1` (see `workers/lib/mcp-token-crypto.ts`).
	auth_type: McpAuthType;
	encrypted_token_b64: string | null;
	token_iv_b64: string | null;
	token_salt_b64: string | null;
	token_envelope_version: number | null;
	token_kek_version: number | null;
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
	authType: McpAuthType;
	/** Plaintext provider-specific config, parsed from `server_config_json`. */
	serverConfig: ServerConfig | null;
	/** Encrypted enterprise credentials blob, NULL when using platform credentials. */
	enterpriseCredentialsEncryptedJson: string | null;
	/** Encrypted bearer token blob, NULL for `oauth` rows. */
	encryptedTokenB64: string | null;
	tokenIvB64: string | null;
	tokenSaltB64: string | null;
	tokenEnvelopeVersion: number | null;
	tokenKekVersion: number | null;
}

type McpConnectionSecretFields =
	| "encryptedTokenB64"
	| "tokenIvB64"
	| "tokenSaltB64"
	| "tokenEnvelopeVersion"
	| "tokenKekVersion"
	| "enterpriseCredentialsEncryptedJson";

/**
 * Public / cross-DO DTO for connection lists and route responses. The
 * encrypted Bearer envelope is intentionally absent: only the MailboxDO row
 * writer and the future Phase 3 rehydrate RPC may handle those columns.
 */
export interface PublicMcpConnection {
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
	authType: McpAuthType;
	serverConfig: ServerConfig | null;
}

/**
 * Patch shape used when upserting. `lastError` is optional so the common
 * "happy path" upsert (state=ready) can omit it; everything else is
 * mandatory because the table has matching `NOT NULL` constraints.
 */
export type McpConnectionInput = Omit<McpConnection, "lastError"> & {
	lastError?: string | null;
	/** Plaintext enterprise credentials — encrypted at write time. */
	enterpriseCredentials?: object;
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

function parseServerConfig(json: string | null): ServerConfig | null {
	if (json === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const result = ServerConfigSchema.safeParse(parsed);
	return result.success ? (result.data as ServerConfig) : null;
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
		authType: row.auth_type,
		serverConfig: parseServerConfig(row.server_config_json),
		enterpriseCredentialsEncryptedJson: row.enterprise_credentials_encrypted_json,
		encryptedTokenB64: row.encrypted_token_b64,
		tokenIvB64: row.token_iv_b64,
		tokenSaltB64: row.token_salt_b64,
		tokenEnvelopeVersion: row.token_envelope_version,
		tokenKekVersion: row.token_kek_version,
	};
}

export function toPublicMcpConnection(
	connection: McpConnection,
): PublicMcpConnection {
	return {
		id: connection.id,
		serverName: connection.serverName,
		displayName: connection.displayName,
		serverUrl: connection.serverUrl,
		transportType: connection.transportType,
		addedByUserId: connection.addedByUserId,
		addedAt: connection.addedAt,
		lastState: connection.lastState,
		lastError: connection.lastError,
		enabledTools: connection.enabledTools,
		authType: connection.authType,
		serverConfig: connection.serverConfig,
	};
}

export function bearerEnvelopeFromConnection(
	connection: McpConnection,
): EnvelopeV1 | null {
	if (connection.authType !== "bearer") return null;
	if (
		connection.encryptedTokenB64 === null ||
		connection.tokenIvB64 === null ||
		connection.tokenSaltB64 === null ||
		connection.tokenEnvelopeVersion !== 1 ||
		connection.tokenKekVersion === null
	) {
		throw new McpConnectionSerializationError(
			`Bearer connection ${connection.id} is missing encrypted token envelope fields`,
		);
	}
	return {
		version: 1,
		kekVersion: connection.tokenKekVersion,
		ivB64: connection.tokenIvB64,
		saltB64: connection.tokenSaltB64,
		ciphertextB64: connection.encryptedTokenB64,
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
		server_config_json: input.serverConfig ? JSON.stringify(input.serverConfig) : null,
		enterprise_credentials_encrypted_json: input.enterpriseCredentialsEncryptedJson ?? null,
		auth_type: input.authType,
		encrypted_token_b64: input.encryptedTokenB64,
		token_iv_b64: input.tokenIvB64,
		token_salt_b64: input.tokenSaltB64,
		token_envelope_version: input.tokenEnvelopeVersion,
		token_kek_version: input.tokenKekVersion,
	};
}

// ── Encryption helpers (ZII-185 / ZII-189) ─────────────────────────────────

/**
 * Generic JSON encryption that reuses the bearer-token DEK+KEK three-layer
 * envelope. `payload` is JSON-stringified before encryption; the returned
 * string is a JSON-serialised {@link EnvelopeV1} ready for column storage.
 */
export async function encryptJson(
	env: BearerKekEnv,
	payload: object,
): Promise<string> {
	const plaintext = JSON.stringify(payload);
	const envelope = await encryptBearerToken(env, plaintext);
	return JSON.stringify(envelope);
}

/**
 * Decrypt a ciphertext produced by {@link encryptJson}. Validates the
 * envelope then JSON-parses the plaintext back to `T`.
 */
export async function decryptJson<T>(
	env: BearerKekEnv,
	ciphertext: string,
): Promise<T> {
	const envelope = JSON.parse(ciphertext) as EnvelopeV1;
	const plaintext = await decryptBearerToken(env, envelope);
	return JSON.parse(plaintext) as T;
}

/**
 * Convenience helper for reading `enterprise_credentials_encrypted_json`.
 * Returns `null` when the column is NULL; otherwise decrypts and parses.
 */
export async function decryptEnterpriseCredentials(
	env: BearerKekEnv,
	connection: Pick<McpConnection, "enterpriseCredentialsEncryptedJson">,
): Promise<Record<string, unknown> | null> {
	if (connection.enterpriseCredentialsEncryptedJson === null) return null;
	return decryptJson<Record<string, unknown>>(env, connection.enterpriseCredentialsEncryptedJson);
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

/** Type-narrowing helper for `auth_type` strings (Migration 19+). */
export function isMcpAuthType(value: unknown): value is McpAuthType {
	return McpAuthTypeSchema.safeParse(value).success;
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
 * Sub-flag for the static Bearer path. It is only considered enabled when
 * the rollout flag is exactly `"true"` AND the active KEK is present, so
 * external code paths never call the encrypt/decrypt helpers with an unset
 * secret at runtime.
 */
export function isL4BearerEnabled(env: {
	L4_MCP_BEARER_ENABLED?: string;
	MCP_BEARER_KEK_CURRENT?: string;
}): boolean {
	return (
		String(env.L4_MCP_BEARER_ENABLED) === "true" &&
		typeof env.MCP_BEARER_KEK_CURRENT === "string" &&
		env.MCP_BEARER_KEK_CURRENT.length > 0
	);
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

type BuildConnectionBaseArgs = {
	serverName: string;
	serverUrl: string;
	displayName?: string;
	addedByUserId: string;
	addedAt: number;
	sdk: SdkAddResult;
	transportType?: McpTransportType | null;
	serverConfig?: ServerConfig | null;
	enterpriseCredentialsEncryptedJson?: string | null;
	enterpriseCredentials?: {
		clientId: string;
		clientSecret?: string;
		scopes?: string[];
	};
};

type BuildConnectionArgs =
	| (BuildConnectionBaseArgs & {
			authType?: "oauth";
			encryptedBlob?: undefined;
		})
	| (BuildConnectionBaseArgs & {
			authType: "bearer";
			encryptedBlob: EnvelopeV1;
		});

/**
 * Translate a successful `Agent.addMcpServer` response plus owner metadata
 * into an {@link McpConnectionInput} ready for `MailboxDO.upsertMcpConnection`.
 *
 * Splitting the add flow into "SDK call → build input → DO upsert" keeps
 * the build step a pure function unit-testable in Node. Unknown SDK state
 * strings collapse to `"error"` so the metadata layer never persists a state
 * value the rest of the codebase cannot narrow.
 */
export function buildConnectionFromSdkResult(
	args: BuildConnectionArgs,
): McpConnectionInput {
	const authType = args.authType ?? "oauth";
	const encryptedBlob = authType === "bearer" ? args.encryptedBlob : null;
	return {
		id: args.sdk.id,
		serverName: args.serverName,
		displayName: args.displayName ?? args.serverName,
		serverUrl: args.serverUrl,
		transportType:
			args.transportType ?? (authType === "bearer" ? "streamable-http" : null),
		addedByUserId: args.addedByUserId,
		addedAt: args.addedAt,
		lastState: isMcpConnectionState(args.sdk.state) ? args.sdk.state : "error",
		enabledTools: null,
		authType,
		serverConfig: args.serverConfig ?? null,
		enterpriseCredentialsEncryptedJson: args.enterpriseCredentialsEncryptedJson ?? null,
		encryptedTokenB64: encryptedBlob?.ciphertextB64 ?? null,
		tokenIvB64: encryptedBlob?.ivB64 ?? null,
		tokenSaltB64: encryptedBlob?.saltB64 ?? null,
		tokenEnvelopeVersion: encryptedBlob?.version ?? null,
		tokenKekVersion: encryptedBlob?.kekVersion ?? null,
	};
}

type AddExternalMcpServerBaseInput = {
	serverName: string;
	url: string;
	displayName?: string;
	addedByUserId: string;
	serverConfig?: ServerConfig | null;
	enterpriseCredentialsEncryptedJson?: string | null;
	enterpriseCredentials?: {
		clientId: string;
		clientSecret?: string;
		scopes?: string[];
	};
};

export type AddExternalMcpServerInput =
	| (AddExternalMcpServerBaseInput & {
			authType: "oauth";
			/** Origin used to construct the OAuth callback URL. */
			callbackHost: string;
		})
	| (AddExternalMcpServerBaseInput & {
			authType: "bearer";
			bearerToken: string;
		});

/**
 * Discriminated outcome of `EmailAgent.addExternalMcpServer`.
 *
 * Phase 3 routes consume the `authenticating` variant to redirect the
 * browser to `authUrl`, and the `ready` variant to confirm immediate
 * success. Both variants carry the persisted {@link McpConnection} so the
 * UI can render the row before live state catches up.
 */
export type AddExternalMcpServerResult =
	| { state: "ready"; connection: PublicMcpConnection }
	| {
			state: "authenticating";
			connection: PublicMcpConnection;
			authUrl: string;
		};

// ── Phase 3 ─────────────────────────────────────────────────────────────────

/**
 * Storage row written by the SDK base `state()` then augmented by
 * {@link MailboxBoundOAuthProvider}. The SDK base persists `nonce`,
 * `serverId`, and `createdAt`; the subclass writes `mailboxId` and
 * `userId` on top.
 *
 * Persisted under `OAuthProvider.stateKey(nonce)` in the EmailAgent's
 * DO storage. Lifetime is bounded by the SDK's `STATE_EXPIRATION_MS`
 * constant — we never delete bound rows ourselves; SDK's
 * `consumeState()` does.
 */
export interface BoundStateRow {
	nonce: string;
	serverId: string;
	createdAt: number;
	mailboxId: string;
	userId: string;
}

/**
 * Pure builder used by {@link MailboxBoundOAuthProvider#state} to layer
 * the binding fields on top of the SDK-written storage row. Pulled out
 * of the subclass so the augmentation contract is unit-testable in
 * Node without a `DurableObjectStorage`.
 *
 * Returns a NEW object — never mutates `stored` — so callers may freely
 * reuse the input.
 */
export function applyBoundFields<T extends Record<string, unknown>>(
	stored: T,
	binding: { mailboxId: string; userId: string },
): T & { mailboxId: string; userId: string } {
	return {
		...stored,
		mailboxId: binding.mailboxId,
		userId: binding.userId,
	};
}

/**
 * Pure validator used by {@link MailboxBoundOAuthProvider#checkState}
 * after the SDK base validation passes. Returns a discriminated result
 * with one of three failure reasons or `valid: true`.
 *
 * Phase 3 binding (Pre-mortem #1; plan §289).
 */
export type BoundStateValidationError =
	| "state row vanished"
	| "mailbox mismatch"
	| "user mismatch";

export function validateBoundState(
	stored:
		| Pick<BoundStateRow, "mailboxId" | "userId">
		| undefined
		| null,
	current: { mailboxId: string; userId: string },
):
	| { valid: true }
	| { valid: false; error: BoundStateValidationError } {
	if (!stored) return { valid: false, error: "state row vanished" };
	if (stored.mailboxId !== current.mailboxId) {
		return { valid: false, error: "mailbox mismatch" };
	}
	if (stored.userId !== current.userId) {
		return { valid: false, error: "user mismatch" };
	}
	return { valid: true };
}
