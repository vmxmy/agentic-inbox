// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * PBKDF2-SHA256 password hashing using the Workers-native Web Crypto API.
 * Argon2/scrypt would be preferable but require WASM; PBKDF2 with a high
 * iteration count is acceptable for an internal app and adds zero deps.
 *
 * Stored format: `pbkdf2$<iterations>$<saltB64>$<hashB64>`
 */

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const ALGO = "PBKDF2";
const HASH_ALGO = "SHA-256";

function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function deriveBits(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const enc = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		enc.encode(password),
		ALGO,
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: ALGO, hash: HASH_ALGO, salt: salt as BufferSource, iterations },
		keyMaterial,
		HASH_BYTES * 8,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	if (!password || password.length < 8) {
		throw new Error("Password must be at least 8 characters");
	}
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await deriveBits(password, salt, ITERATIONS);
	return `pbkdf2$${ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	if (!stored) return false;
	const parts = stored.split("$");
	if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
	const iterations = Number(parts[1]);
	if (!Number.isFinite(iterations) || iterations < 1) return false;
	const salt = b64ToBytes(parts[2]);
	const expected = b64ToBytes(parts[3]);
	const actual = await deriveBits(password, salt, iterations);
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
	return diff === 0;
}
