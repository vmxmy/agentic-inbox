// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dynamic model catalog. Hits the configured LLM endpoint's `/v1/models`
 * (OpenAI-compatible shape) and caches the response in-process for a short
 * TTL — so the agent + UI dropdown share the same source of truth without
 * paying for the round-trip on every request.
 *
 * On fetch failure (endpoint down, key missing, etc.) we fall back to a
 * hard-coded singleton list containing only the configured default model so
 * the worker never serves an empty dropdown that locks the user out.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getDefaultProvider } from "./llm-providers";
import type { Env } from "../types";

/**
 * Resolved LLM configuration in effect right now. Either the DB-stored
 * default provider (when one exists) or the env-var fallback.
 */
export interface ResolvedLlmConfig {
	source: "db" | "env";
	baseUrl: string;
	apiKey: string;
	defaultModel: string;
	/** Cache key — distinct per provider so /models cache stays correct when
	 *  admin swaps the active provider. */
	cacheKey: string;
}

export async function resolveLlmConfig(env: Env): Promise<ResolvedLlmConfig> {
	const provider = await getDefaultProvider(env).catch(() => null);
	if (provider) {
		return {
			source: "db",
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			defaultModel: provider.defaultModel,
			cacheKey: `db:${provider.id}:${provider.updatedAt}`,
		};
	}
	return {
		source: "env",
		baseUrl: (env.LLM_BASE_URL ?? "").trim(),
		apiKey: env.LLM_API_KEY ?? "",
		defaultModel: (env.LLM_DEFAULT_MODEL ?? "").trim(),
		cacheKey: `env:${(env.LLM_BASE_URL ?? "").trim()}`,
	};
}

/**
 * Strip trailing slashes AND a trailing `/v1` segment so we can safely append
 * our own `/v1/...` paths regardless of whether the admin typed
 * `https://litellm.example.com` or `https://litellm.example.com/v1`.
 */
function rootBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Construct an OpenAI-compatible AI SDK provider pointed at the resolved
 * LLM endpoint. Pass `cfg` if you've already resolved (avoids a redundant
 * D1 lookup); omit it to resolve internally.
 */
export function getLlmProvider(_env: Env, cfg: ResolvedLlmConfig) {
	return createOpenAICompatible({
		name: "agent-llm",
		baseURL: `${rootBase(cfg.baseUrl)}/v1`,
		apiKey: cfg.apiKey,
	});
}

export interface LlmModel {
	id: string;
	owned_by?: string;
	created?: number;
	object?: string;
}

interface CacheEntry {
	at: number;
	models: LlmModel[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function fallback(defaultModel: string): LlmModel[] {
	const id = defaultModel?.trim() || "default";
	return [{ id, object: "model" }];
}

/**
 * Fetch /v1/models from the resolved LLM endpoint and cache for `CACHE_TTL_MS`.
 * Cache key includes the resolved provider id (or env URL) so swapping the
 * active provider invalidates correctly.
 */
export async function listLlmModels(
	env: Env,
	opts: { force?: boolean; baseUrl?: string; apiKey?: string; cfg?: ResolvedLlmConfig } = {},
): Promise<LlmModel[]> {
	let baseUrl: string;
	let apiKey: string;
	let cacheKey: string;
	let defaultModel: string;
	if (opts.baseUrl) {
		baseUrl = opts.baseUrl;
		apiKey = opts.apiKey ?? "";
		cacheKey = `adhoc:${baseUrl}`;
		defaultModel = "";
	} else {
		const cfg = opts.cfg ?? (await resolveLlmConfig(env));
		baseUrl = cfg.baseUrl;
		apiKey = cfg.apiKey;
		cacheKey = cfg.cacheKey;
		defaultModel = cfg.defaultModel;
	}
	if (!baseUrl) return fallback(defaultModel);

	const hit = cache.get(cacheKey);
	if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
		return hit.models;
	}

	const url = `${rootBase(baseUrl)}/v1/models`;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	try {
		const res = await fetch(url, { headers });
		if (!res.ok) {
			console.warn(`[llm-models] ${url} → ${res.status}`);
			return fallback(defaultModel);
		}
		const body = (await res.json()) as { data?: unknown };
		const data = Array.isArray(body?.data) ? body.data : [];
		const models: LlmModel[] = [];
		for (const entry of data) {
			if (!entry || typeof entry !== "object") continue;
			const id = (entry as { id?: unknown }).id;
			if (typeof id !== "string" || !id) continue;
			models.push({
				id,
				object: typeof (entry as { object?: unknown }).object === "string"
					? ((entry as { object: string }).object)
					: undefined,
				owned_by: typeof (entry as { owned_by?: unknown }).owned_by === "string"
					? ((entry as { owned_by: string }).owned_by)
					: undefined,
				created: typeof (entry as { created?: unknown }).created === "number"
					? ((entry as { created: number }).created)
					: undefined,
			});
		}
		const sorted = models.sort((a, b) => a.id.localeCompare(b.id));
		cache.set(cacheKey, { at: Date.now(), models: sorted });
		return sorted;
	} catch (e) {
		console.warn(`[llm-models] fetch failed: ${(e as Error).message}`);
		return fallback(defaultModel);
	}
}

/** Best-effort lookup. Returns the requested id if it's in the catalog,
 *  otherwise the resolved-default model, otherwise the first available,
 *  otherwise the requested id verbatim (fail-open at the LLM call layer). */
export function pickModel(catalog: LlmModel[], requested: string | undefined, defaultModel: string): string {
	const want = requested?.trim();
	if (want && catalog.some((m) => m.id === want)) return want;
	const def = defaultModel?.trim();
	if (def && catalog.some((m) => m.id === def)) return def;
	if (catalog[0]) return catalog[0].id;
	return want || def || "default";
}
