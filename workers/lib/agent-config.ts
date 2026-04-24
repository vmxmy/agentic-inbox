// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-level Agent configuration, read from the R2 settings blob.
 * Single source of truth for: auto-draft flag, model, system prompt, rules.
 */
import type { Env } from "../types";
import { parseRulesLoose, type Rule } from "./rules";

/** Supported models. Keep this list in sync with the Settings dropdown. */
export const ALLOWED_AGENT_MODELS = [
	"@cf/moonshotai/kimi-k2.5",
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/qwen/qwen2.5-coder-32b-instruct",
] as const;

export type AgentModel = typeof ALLOWED_AGENT_MODELS[number];

export const DEFAULT_AGENT_MODEL: AgentModel = "@cf/moonshotai/kimi-k2.5";

export interface AgentConfig {
	autoDraft: boolean;
	model: AgentModel;
	customSystemPrompt: string | null;
	rules: Rule[];
}

function coerceModel(raw: unknown): AgentModel {
	if (typeof raw === "string" && (ALLOWED_AGENT_MODELS as readonly string[]).includes(raw)) {
		return raw as AgentModel;
	}
	return DEFAULT_AGENT_MODEL;
}

export async function getAgentConfig(env: Env, mailboxId: string): Promise<AgentConfig> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return defaults();
		const settings = (await obj.json()) as Record<string, unknown>;
		return {
			// Default TRUE for backward compatibility with mailboxes created
			// before the flag existed.
			autoDraft: settings.autoDraft !== false,
			model: coerceModel(settings.agentModel),
			customSystemPrompt:
				typeof settings.agentSystemPrompt === "string" && settings.agentSystemPrompt.trim()
					? settings.agentSystemPrompt
					: null,
			rules: parseRulesLoose(settings),
		};
	} catch {
		return defaults();
	}
}

function defaults(): AgentConfig {
	return {
		autoDraft: true,
		model: DEFAULT_AGENT_MODEL,
		customSystemPrompt: null,
		rules: [],
	};
}
