// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for Agent LLM provider selection.
 *
 * This file is intentionally NOT imported by production code. It keeps the
 * LLM_BASE_URL / LLM_DEFAULT_MODEL compatibility rules covered by `tsc -b`
 * without touching the network or Cloudflare bindings.
 */
import {
	DEFAULT_EMAIL_AGENT_MODEL_ID,
	DEFAULT_EMAIL_AGENT_PROFILE,
	type AgentProfile,
} from "./agent-profile";
import {
	resolveAgentModel,
	resolveAgentModelId,
	resolveSafetyModel,
	resolveSafetyModelId,
	type AgentModelProvider,
	type ResolvedAgentModel,
	type ResolvedSafetyModel,
	type SafetyModelPurpose,
} from "./llm-provider";
import type { Env } from "../types";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

type _ProviderShape = Expect<
	Equal<AgentModelProvider, "openai-compatible" | "workers-ai">
>;

type _ResolvedShape = Expect<
	Equal<keyof ResolvedAgentModel, "model" | "modelId" | "provider">
>;

type _SafetyPurposeShape = Expect<
	Equal<SafetyModelPurpose, "prompt-injection" | "draft-verifier">
>;

type _ResolvedSafetyShape = Expect<
	Equal<keyof ResolvedSafetyModel, "model" | "modelId" | "provider" | "purpose">
>;

// --- Inert fixtures --------------------------------------------------------

const FAKE_ENV = {} as unknown as Env;

function makeAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		...DEFAULT_EMAIL_AGENT_PROFILE,
		...overrides,
	};
}

// --- Case 1: Workers AI fallback preserves the default profile model -------

export function verifyWorkersAiFallbackKeepsDefaultModel(): string {
	const modelId = resolveAgentModelId(
		FAKE_ENV,
		makeAgent(),
		"workers-ai",
	);
	if (modelId !== DEFAULT_EMAIL_AGENT_MODEL_ID) {
		throw new Error("Workers AI fallback should keep the default @cf model");
	}
	return modelId;
}

// --- Case 2: OpenAI-compatible default uses env.LLM_DEFAULT_MODEL ----------

export function verifyOpenAiCompatibleDefaultModelOverride(): string {
	const modelId = resolveAgentModelId(
		{
			LLM_DEFAULT_MODEL: "glm-5.1",
		} as unknown as Env,
		makeAgent(),
		"openai-compatible",
	);
	if (modelId !== "glm-5.1") {
		throw new Error("LLM_DEFAULT_MODEL should override the default @cf model");
	}
	return modelId;
}

// --- Case 3: Custom pinned AgentProfile model wins over env default --------

export function verifyCustomAgentModelWins(): string {
	const modelId = resolveAgentModelId(
		{
			LLM_DEFAULT_MODEL: "glm-5.1",
		} as unknown as Env,
		makeAgent({ modelId: "custom-profile-model" }),
		"openai-compatible",
	);
	if (modelId !== "custom-profile-model") {
		throw new Error("custom AgentProfile modelId should remain pinned");
	}
	return modelId;
}

// --- Case 4: LLM_BASE_URL selects the OpenAI-compatible provider -----------

export function verifyOpenAiCompatibleProviderSelection(): ResolvedAgentModel {
	const resolved = resolveAgentModel(
		{
			LLM_BASE_URL: "https://llm.example.test/v1",
			LLM_DEFAULT_MODEL: "glm-5.1",
			LLM_API_KEY: "test-key",
		} as unknown as Env,
		makeAgent(),
	);
	if (resolved.provider !== "openai-compatible") {
		throw new Error("LLM_BASE_URL should select the OpenAI-compatible provider");
	}
	if (resolved.modelId !== "glm-5.1") {
		throw new Error("OpenAI-compatible provider should use LLM_DEFAULT_MODEL");
	}
	return resolved;
}

// --- Case 5: Safety models use Workers AI defaults without LLM_BASE_URL ----

export function verifyWorkersAiSafetyModels(): string[] {
	const injectionModel = resolveSafetyModelId(
		FAKE_ENV,
		"prompt-injection",
		"workers-ai",
	);
	const verifierModel = resolveSafetyModelId(
		FAKE_ENV,
		"draft-verifier",
		"workers-ai",
	);
	if (injectionModel !== "@cf/meta/llama-3.1-8b-instruct-fast") {
		throw new Error("prompt-injection Workers AI model drift");
	}
	if (verifierModel !== "@cf/meta/llama-4-scout-17b-16e-instruct") {
		throw new Error("draft-verifier Workers AI model drift");
	}
	return [injectionModel, verifierModel];
}

// --- Case 6: LLM_SAFETY_MODEL overrides the default OpenAI-compatible model -

export function verifyOpenAiCompatibleSafetyModelOverride(): ResolvedSafetyModel {
	const resolved = resolveSafetyModel(
		{
			LLM_BASE_URL: "https://llm.example.test/v1",
			LLM_DEFAULT_MODEL: "glm-5.1",
			LLM_SAFETY_MODEL: "safety-specialist",
		} as unknown as Env,
		"draft-verifier",
	);
	if (resolved.provider !== "openai-compatible") {
		throw new Error("LLM_BASE_URL should select OpenAI-compatible safety model");
	}
	if (resolved.modelId !== "safety-specialist") {
		throw new Error("LLM_SAFETY_MODEL should override LLM_DEFAULT_MODEL");
	}
	if (resolved.purpose !== "draft-verifier") {
		throw new Error("safety model purpose was not preserved");
	}
	return resolved;
}

export type LlmProviderVerificationCases = {
	providerShape: _ProviderShape;
	resolvedShape: _ResolvedShape;
	safetyPurposeShape: _SafetyPurposeShape;
	resolvedSafetyShape: _ResolvedSafetyShape;
};
