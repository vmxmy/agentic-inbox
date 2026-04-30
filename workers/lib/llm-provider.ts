// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
	DEFAULT_EMAIL_AGENT_MODEL_ID,
	type AgentProfile,
} from "./agent-profile";
import type { Env } from "../types";

export type AgentModelProvider = "openai-compatible" | "workers-ai";

export interface ResolvedAgentModel {
	model: LanguageModel;
	modelId: string;
	provider: AgentModelProvider;
}

type LlmEnv = Env & {
	LLM_BASE_URL?: string;
	LLM_DEFAULT_MODEL?: string;
	LLM_API_KEY?: string;
};

const OPENAI_COMPATIBLE_PROVIDER_NAME = "openai-compatible";
const UNAUTHENTICATED_PROXY_API_KEY = "not-needed";

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function isDefaultWorkersAiModel(modelId: string): boolean {
	return modelId === DEFAULT_EMAIL_AGENT_MODEL_ID;
}

export function resolveAgentModelId(
	env: Env,
	agentProfile: AgentProfile,
	provider: AgentModelProvider,
): string {
	const llmEnv = env as LlmEnv;
	if (provider === "openai-compatible") {
		const defaultModel = readNonEmptyString(llmEnv.LLM_DEFAULT_MODEL);
		if (defaultModel && isDefaultWorkersAiModel(agentProfile.modelId)) {
			return defaultModel;
		}
	}
	return agentProfile.modelId;
}

export function resolveAgentModel(
	env: Env,
	agentProfile: AgentProfile,
): ResolvedAgentModel {
	const llmEnv = env as LlmEnv;
	const baseURL = readNonEmptyString(llmEnv.LLM_BASE_URL);

	if (baseURL) {
		const modelId = resolveAgentModelId(
			env,
			agentProfile,
			"openai-compatible",
		);
		const provider = createOpenAI({
			baseURL,
			apiKey:
				readNonEmptyString(llmEnv.LLM_API_KEY) ??
				UNAUTHENTICATED_PROXY_API_KEY,
			name: OPENAI_COMPATIBLE_PROVIDER_NAME,
		});
		return {
			model: provider.chat(modelId),
			modelId,
			provider: "openai-compatible",
		};
	}

	const workersai = createWorkersAI({ binding: env.AI });
	const modelId = resolveAgentModelId(env, agentProfile, "workers-ai");
	return {
		model: workersai(
			modelId as Parameters<typeof workersai>[0],
		) as LanguageModel,
		modelId,
		provider: "workers-ai",
	};
}
