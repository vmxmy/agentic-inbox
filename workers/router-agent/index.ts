// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import {
	streamText,
	convertToModelMessages,
	stepCountIs,
	type ToolSet,
} from "ai";
import { z } from "zod";
import { getAgentConfig } from "../lib/agent-config";
import { getLlmProvider, listLlmModels, pickModel, resolveLlmConfig } from "../lib/llm-models";
import type { Env } from "../types";
import { sortMessagesByCreatedAt } from "../../shared/messageOrdering";
import { runAbortable } from "./abortable";

function defineTool(def: {
	description: string;
	parameters: z.ZodType<any>;
	execute: (...args: any[]) => Promise<any>;
}) {
	return {
		description: def.description,
		inputSchema: def.parameters,
		execute: def.execute,
	};
}

const ROUTER_SYSTEM_PROMPT = `\
You are a routing assistant for an email management system. Today the
only registered specialist is the EmailAgent (inbox search, reading
emails, drafting replies, thread management). Future external agents
will register through the agent-register interface.

Rules:
1. If the user's message starts with [→email], route to EmailAgent.
2. Otherwise, infer the intent and route to the most appropriate agent
   that is currently registered.
3. Pass a concise context_summary to the sub-agent when prior conversation is relevant.
4. Return the sub-agent's response directly without paraphrasing.
5. The user may speak Chinese or English. Match their language.`;

export class RouterAgent extends AIChatAgent<any> {
	async onChatMessage(
		onFinish: any,
		options?: { abortSignal?: AbortSignal },
	) {
		const env = this.env as Env;
		const mailboxId = this.name;
		const config = await getAgentConfig(env, mailboxId);
		const cfg = await resolveLlmConfig(env);
		const provider = getLlmProvider(env, cfg);
		const catalog = await listLlmModels(env, { cfg });
		const modelId = pickModel(catalog, config.model, cfg.defaultModel);
		const abortSignal = options?.abortSignal;

		const tools: ToolSet = {
			ask_email_agent: defineTool({
				description:
					"Delegate to EmailAgent: inbox search, reading emails, drafting replies, thread management",
				parameters: z.object({
					task: z.string().describe("Task for the email agent"),
					context_summary: z
						.string()
						.optional()
						.describe("Relevant context from prior conversation turns"),
				}),
				execute: async ({ task, context_summary }: { task: string; context_summary?: string }) => {
					const stub = await getAgentByName(env.EMAIL_AGENT, mailboxId);
					const taskId = crypto.randomUUID();
					return runAbortable(
						abortSignal,
						taskId,
						(id) => stub.cancelTask(id),
						() => stub.executeTask(task, context_summary ?? "", taskId),
					);
				},
			}),
		};

		const result = streamText({
			model: provider(modelId),
			system: ROUTER_SYSTEM_PROMPT,
			messages: await convertToModelMessages(sortMessagesByCreatedAt(this.messages)),
			tools,
			stopWhen: stepCountIs(4),
			onFinish,
			// Forward the SDK-supplied abortSignal so a stop() from the client
			// halts both the router's own stream AND any in-flight delegated
			// sub-task (via runAbortable above).
			abortSignal,
		});

		return result.toUIMessageStreamResponse();
	}
}
