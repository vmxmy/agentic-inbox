// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Encryption-at-rest helpers for L4 P8 Bearer tokens. The plaintext token
 * NEVER touches the SDK's persistence path (`cf_agents_mcp_servers.server_options`
 * is a JSON.stringify boundary that silently drops function values — see
 * Phase 2 in `.omc/plans/l4-p8-bearer-auth.md`). Instead, the token is
 * encrypted at the metadata layer (`mcp_connections` row) and decrypted
 * on-demand into a heap-only cache that lives only inside the live DO
 * instance.
 *
 * Crypto choices (verified against `MAJOR_KEK` family of plans + SDK
 * source notes):
 *
 *   - **HKDF-SHA256** as the key-derivation primitive. Per-row 32-byte salt
 *     gives every row an independent AES-GCM key even when the same KEK
 *     is reused across millions of rows; the `info` parameter binds the
 *     derivation to a stable label so future scheme upgrades (e.g.
 *     mTLS-derived KEKs) cannot be confused with the v1 layout.
 *   - **AES-GCM 256** with a 12-byte random IV, the NIST-standard nonce
 *     length for GCM. The auth tag (16 bytes) is appended to the
 *     ciphertext by Web Crypto and validated implicitly on decrypt — any
 *     tampering surfaces as a generic decrypt failure.
 *   - **Versioned envelope** so the row layout can evolve without a
 *     re-encryption migration. `version: 1` is the only currently
 *     supported value; future scheme bumps would extend this discriminator.
 *   - **Dual-KEK rotation** via `MCP_BEARER_KEK_CURRENT` +
 *     `MCP_BEARER_KEK_PREVIOUS`. Each blob carries the `kekVersion` that
 *     stamped it; decrypt tries CURRENT first, falls back to PREVIOUS
 *     when stamps don't match. Operators can rotate without bricking
 *     existing rows — see ADR §418 in the plan.
 *
 * Pure module: takes `env` (or its KEK fields) as parameters, never
 * imports a binding directly. Keeps tests in the Node `tests/` runtime
 * trivial — no DO context needed.
 *
 * Plan reference: §71-78 (Phase 1 deliverables).
 */

/** Stable label baked into HKDF derivation; `info` for HKDF-SHA256. */
const HKDF_INFO_PREFIX = "mcp-bearer-v";

/** AES-GCM key size in bytes (256-bit key). */
const AES_KEY_LEN_BITS = 256;

/** AES-GCM IV size in bytes — NIST-recommended 96-bit nonce. */
const IV_LEN = 12;

/** Per-row salt size for HKDF; 256-bit gives ample collision margin. */
const SALT_LEN = 32;

/**
 * Whitelist of audit-safe error category codes. Any SDK error that does
 * not match one of these patterns is collapsed to `external_mcp_error`
 * before persistence — the heuristic redactor in iteration 1 of the plan
 * was rejected for leaking PAT- and JWT-shaped substrings, so this
 * iteration enforces a closed set.
 *
 * Phase 5 (`mcp-audit.ts`) imports this constant to populate the
 * `mcp_audit_log.error` column.
 */
export const CATEGORIES = [
	"connect_failed",
	"unauthorized",
	"timeout",
	"transport_error",
	"injection_blocked",
	"decrypt_failed",
	"discovery_failed",
] as const;
export type ErrorCategory = (typeof CATEGORIES)[number];

/** Sentinel returned when no whitelist pattern matches. */
export const FALLBACK_CATEGORY = "external_mcp_error" as const;

/**
 * Persisted row layout for a Bearer-typed `mcp_connections` row. All
 * fields except `version` and `kekVersion` are base64 strings. The blob
 * is split across five SQLite columns (`encrypted_token_b64`,
 * `token_iv_b64`, `token_salt_b64`, `token_envelope_version`,
 * `token_kek_version`) rather than one JSON column so each piece can be
 * indexed or migrated independently if the layout ever needs to change.
 */
export interface EnvelopeV1 {
	version: 1;
	kekVersion: number;
	ivB64: string;
	saltB64: string;
	ciphertextB64: string;
}

/** Stable error class so callers can catch decrypt failures distinctly. */
export class BearerDecryptError extends Error {
	override readonly cause?: unknown;

	constructor(cause?: unknown) {
		super("decrypt_failed");
		this.name = "BearerDecryptError";
		this.cause = cause;
	}
}

/** Stable error class for missing-KEK at encrypt time. */
export class MissingKekError extends Error {
	constructor() {
		super("MCP_BEARER_KEK_CURRENT not configured");
		this.name = "MissingKekError";
	}
}

/** Subset of `Env` the crypto helpers actually read. */
export interface BearerKekEnv {
	MCP_BEARER_KEK_CURRENT?: string;
	MCP_BEARER_KEK_PREVIOUS?: string;
	MCP_BEARER_KEK_VERSION?: string;
}

// ── base64 helpers ──────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const len = binary.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// ── KDF + cipher ────────────────────────────────────────────────────────────

/**
 * Derive a per-row AES-GCM key from a base64-encoded KEK and a per-row
 * base64-encoded salt. `version` is stamped into the HKDF `info` field
 * so future envelope schemes cannot cross-decrypt v1 blobs.
 */
export async function deriveBearerKey(
	kekB64: string,
	saltB64: string,
	version: 1,
): Promise<CryptoKey> {
	const kekBytes = base64ToBytes(kekB64);
	const saltBytes = base64ToBytes(saltB64);
	const baseKey = await crypto.subtle.importKey(
		"raw",
		kekBytes as BufferSource,
		{ name: "HKDF" },
		false,
		["deriveKey"],
	);
	const info = new TextEncoder().encode(`${HKDF_INFO_PREFIX}${version}`);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: saltBytes as BufferSource,
			info: info as BufferSource,
		},
		baseKey,
		{ name: "AES-GCM", length: AES_KEY_LEN_BITS },
		false,
		["encrypt", "decrypt"],
	);
}

function readKekVersion(env: BearerKekEnv): number {
	const raw = env.MCP_BEARER_KEK_VERSION ?? "1";
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(
			`MCP_BEARER_KEK_VERSION must be a positive integer string, got ${JSON.stringify(raw)}`,
		);
	}
	return parsed;
}

/**
 * Encrypt `plaintext` using `env.MCP_BEARER_KEK_CURRENT` and stamp the
 * blob with the current `MCP_BEARER_KEK_VERSION` (defaults to 1). Throws
 * {@link MissingKekError} if no current KEK is configured.
 */
export async function encryptBearerToken(
	env: BearerKekEnv,
	plaintext: string,
): Promise<EnvelopeV1> {
	const kekB64 = env.MCP_BEARER_KEK_CURRENT;
	if (!kekB64) throw new MissingKekError();
	const kekVersion = readKekVersion(env);
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const saltB64 = bytesToBase64(salt);
	const key = await deriveBearerKey(kekB64, saltB64, 1);
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource },
			key,
			plaintextBytes as BufferSource,
		),
	);
	return {
		version: 1,
		kekVersion,
		ivB64: bytesToBase64(iv),
		saltB64,
		ciphertextB64: bytesToBase64(ciphertext),
	};
}

async function tryDecrypt(
	kekB64: string,
	blob: EnvelopeV1,
): Promise<string> {
	const key = await deriveBearerKey(kekB64, blob.saltB64, blob.version);
	const ivBytes = base64ToBytes(blob.ivB64);
	const ciphertextBytes = base64ToBytes(blob.ciphertextB64);
	const plaintextBytes = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: ivBytes as BufferSource },
			key,
			ciphertextBytes as BufferSource,
		),
	);
	return new TextDecoder().decode(plaintextBytes);
}

/**
 * Decrypt an {@link EnvelopeV1}. Tries `MCP_BEARER_KEK_CURRENT` first;
 * if the blob's `kekVersion` predates rotation, falls back to
 * `MCP_BEARER_KEK_PREVIOUS`. Any decryption failure surfaces as
 * {@link BearerDecryptError} with no detail leaked beyond the stable
 * `"decrypt_failed"` message — the underlying error is preserved on
 * `.cause` for local debugging only.
 */
export async function decryptBearerToken(
	env: BearerKekEnv,
	blob: EnvelopeV1,
): Promise<string> {
	const errors: unknown[] = [];
	const current = env.MCP_BEARER_KEK_CURRENT;
	const previous = env.MCP_BEARER_KEK_PREVIOUS;
	if (current) {
		try {
			return await tryDecrypt(current, blob);
		} catch (err) {
			errors.push(err);
		}
	}
	if (previous) {
		try {
			return await tryDecrypt(previous, blob);
		} catch (err) {
			errors.push(err);
		}
	}
	throw new BearerDecryptError(errors.length === 1 ? errors[0] : errors);
}

// ── redaction + categorisation ──────────────────────────────────────────────

/**
 * Stable redaction string for a plaintext token. Returns a fixed shape
 * `<bearer:redacted:len=N>` so audit logs are scannable but never
 * include any substring of the input. The length leak (`N`) is
 * intentional — operators need it to distinguish PAT-shape from
 * JWT-shape leakage attempts during incident review, and it does not
 * help an attacker recover the secret.
 */
export function redactToken(plaintext: string): string {
	return `<bearer:redacted:len=${plaintext.length}>`;
}

/**
 * Map an unknown SDK / network / decryption error to one of the
 * {@link CATEGORIES} codes, falling back to {@link FALLBACK_CATEGORY}
 * when no pattern matches. The whitelist is closed: any new category
 * must be added explicitly to the list above and to a matcher below,
 * which forces reviewers to consider whether the new category could
 * carry secret material in its message.
 */
export function categoriseError(
	err: unknown,
): ErrorCategory | typeof FALLBACK_CATEGORY {
	if (err instanceof BearerDecryptError) return "decrypt_failed";
	const message =
		typeof err === "string"
			? err
			: err instanceof Error
				? err.message
				: "";
	const name = err instanceof Error ? err.name : "";
	const blob = `${name}: ${message}`;
	if (/Failed to connect to MCP server|connect ECONNREFUSED|fetch failed/i.test(blob)) {
		return "connect_failed";
	}
	if (/UnauthorizedError|401|invalid_token|forbidden|403/i.test(blob)) {
		return "unauthorized";
	}
	if (/timeout|timed out|ETIMEDOUT/i.test(blob)) {
		return "timeout";
	}
	if (/SSE error|streamable[- ]http|transport/i.test(blob)) {
		return "transport_error";
	}
	if (/prompt[ _-]?injection|injection_blocked|content_blocked/i.test(blob)) {
		return "injection_blocked";
	}
	if (/decrypt_failed|BearerDecryptError|cipher|GCM/i.test(blob)) {
		return "decrypt_failed";
	}
	if (/discovery|capabilities|listTools|capability/i.test(blob)) {
		return "discovery_failed";
	}
	return FALLBACK_CATEGORY;
}
