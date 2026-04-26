// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * D1-backed LLM provider registry. Each row is one OpenAI-compatible endpoint
 * (LiteLLM, OpenRouter, official OpenAI, etc.). Exactly one row may carry
 * `isDefault = 1` and that's the provider EmailAgent/InvoiceAgent route to.
 *
 * If the table is empty we fall back to the env-var configuration
 * (`LLM_BASE_URL` + `LLM_API_KEY` + `LLM_DEFAULT_MODEL`) so production keeps
 * working before the first row is created.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { llmProviders, type LlmProviderRow } from "../db/llm-schema";
import type { Env } from "../types";

export interface LlmProvider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	enabled: boolean;
	isDefault: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface LlmProviderPublic {
	id: string;
	name: string;
	baseUrl: string;
	/** Last 4 chars only, prefixed with "•••". Empty string if api_key is empty. */
	apiKeyMasked: string;
	defaultModel: string;
	enabled: boolean;
	isDefault: boolean;
	createdAt: number;
	updatedAt: number;
}

function db(env: Env) {
	return drizzle(env.DB);
}

function rowToRecord(row: LlmProviderRow): LlmProvider {
	return {
		id: row.id,
		name: row.name,
		baseUrl: row.baseUrl,
		apiKey: row.apiKey,
		defaultModel: row.defaultModel,
		enabled: !!row.enabled,
		isDefault: !!row.isDefault,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function maskApiKey(key: string): string {
	if (!key) return "";
	const tail = key.slice(-4);
	return `•••${tail}`;
}

export function toPublic(provider: LlmProvider): LlmProviderPublic {
	return {
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl,
		apiKeyMasked: maskApiKey(provider.apiKey),
		defaultModel: provider.defaultModel,
		enabled: provider.enabled,
		isDefault: provider.isDefault,
		createdAt: provider.createdAt,
		updatedAt: provider.updatedAt,
	};
}

export async function listProviders(env: Env): Promise<LlmProvider[]> {
	const rows = await db(env).select().from(llmProviders);
	return rows.map(rowToRecord);
}

export async function getProvider(env: Env, id: string): Promise<LlmProvider | null> {
	const rows = await db(env)
		.select()
		.from(llmProviders)
		.where(eq(llmProviders.id, id))
		.limit(1);
	return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Resolve the provider currently in effect: the row with `enabled=1 AND
 * isDefault=1`. Returns null if no row qualifies — callers fall back to env
 * vars.
 */
export async function getDefaultProvider(env: Env): Promise<LlmProvider | null> {
	const rows = await db(env)
		.select()
		.from(llmProviders)
		.where(eq(llmProviders.isDefault, 1))
		.limit(1);
	const row = rows[0];
	if (!row || !row.enabled) return null;
	return rowToRecord(row);
}

export interface CreateProviderInput {
	name: string;
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	enabled?: boolean;
	makeDefault?: boolean;
}

export async function createProvider(
	env: Env,
	input: CreateProviderInput,
): Promise<LlmProvider> {
	const now = Date.now();
	const id = crypto.randomUUID();
	const enabled = input.enabled ?? true;
	const makeDefault = input.makeDefault ?? false;

	if (makeDefault) await clearDefault(env);

	await db(env).insert(llmProviders).values({
		id,
		name: input.name,
		baseUrl: normaliseBaseUrl(input.baseUrl),
		apiKey: input.apiKey,
		defaultModel: input.defaultModel,
		enabled: enabled ? 1 : 0,
		isDefault: makeDefault ? 1 : 0,
		createdAt: now,
		updatedAt: now,
	});

	return (await getProvider(env, id))!;
}

export interface UpdateProviderInput {
	name?: string;
	baseUrl?: string;
	/** Pass `null` to leave the existing key unchanged. Pass a non-empty
	 *  string to rotate. */
	apiKey?: string | null;
	defaultModel?: string;
	enabled?: boolean;
	makeDefault?: boolean;
}

export async function updateProvider(
	env: Env,
	id: string,
	patch: UpdateProviderInput,
): Promise<LlmProvider | null> {
	const existing = await getProvider(env, id);
	if (!existing) return null;

	const updates: Record<string, string | number> = { updated_at: Date.now() };
	if (patch.name !== undefined) updates.name = patch.name;
	if (patch.baseUrl !== undefined) updates.base_url = normaliseBaseUrl(patch.baseUrl);
	if (patch.apiKey !== undefined && patch.apiKey !== null) updates.api_key = patch.apiKey;
	if (patch.defaultModel !== undefined) updates.default_model = patch.defaultModel;
	if (patch.enabled !== undefined) updates.enabled = patch.enabled ? 1 : 0;

	if (patch.makeDefault === true) {
		await clearDefault(env);
		updates.is_default = 1;
	} else if (patch.makeDefault === false) {
		updates.is_default = 0;
	}

	// Drizzle's `update().set()` expects camelCase keys mapped to columns.
	// Build the equivalent payload here so callers don't have to know the
	// snake_case wire format.
	const setPayload: Record<string, unknown> = {};
	if ("name" in updates) setPayload.name = updates.name;
	if ("base_url" in updates) setPayload.baseUrl = updates.base_url;
	if ("api_key" in updates) setPayload.apiKey = updates.api_key;
	if ("default_model" in updates) setPayload.defaultModel = updates.default_model;
	if ("enabled" in updates) setPayload.enabled = updates.enabled;
	if ("is_default" in updates) setPayload.isDefault = updates.is_default;
	setPayload.updatedAt = updates.updated_at;

	await db(env).update(llmProviders).set(setPayload).where(eq(llmProviders.id, id));
	return getProvider(env, id);
}

export async function deleteProvider(env: Env, id: string): Promise<boolean> {
	const existing = await getProvider(env, id);
	if (!existing) return false;
	await db(env).delete(llmProviders).where(eq(llmProviders.id, id));
	return true;
}

/** Clear `is_default = 1` on every row. Called before promoting another row. */
async function clearDefault(env: Env): Promise<void> {
	await db(env).update(llmProviders).set({ isDefault: 0 }).where(eq(llmProviders.isDefault, 1));
}

function normaliseBaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}
