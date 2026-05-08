// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
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
You are a routing assistant for an email and invoice management system.
You coordinate two specialized agents:
- EmailAgent: inbox search, reading emails, drafting replies, thread management
- InvoiceAgent: invoice search, bundle creation and management, reimbursement workflows

Rules:
1. If the user's message starts with [→email], route to EmailAgent.
2. If the user's message starts with [→invoice], route to InvoiceAgent.
3. Otherwise, infer the intent and route to the most appropriate agent.
4. Pass a concise context_summary to the sub-agent when prior conversation is relevant.
5. Return the sub-agent's response directly without paraphrasing.
6. The user may speak Chinese or English. Match their language.`;

export class RouterAgent extends AIChatAgent<any> {
	async onChatMessage(onFinish: any) {
		const env = this.env as Env;
		const mailboxId = this.name;
		const config = await getAgentConfig(env, mailboxId);
		const cfg = await resolveLlmConfig(env);
		const provider = getLlmProvider(env, cfg);
		const catalog = await listLlmModels(env, { cfg });
		const modelId = pickModel(catalog, config.model, cfg.defaultModel);

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
					const stub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
					return stub.executeTask(task, context_summary ?? "");
				},
			}),

			ask_invoice_agent: defineTool({
				description:
					"Delegate to InvoiceAgent: invoice search, bundle management, reimbursement workflows",
				parameters: z.object({
					task: z.string().describe("Task for the invoice agent"),
					context_summary: z
						.string()
						.optional()
						.describe("Relevant context from prior conversation turns"),
				}),
				execute: async ({ task, context_summary }: { task: string; context_summary?: string }) => {
					const stub = env.INVOICE_AGENT.get(env.INVOICE_AGENT.idFromName(mailboxId));
					return stub.executeTask(task, context_summary ?? "");
				},
			}),
		};

		const result = streamText({
			model: provider(modelId),
			system: ROUTER_SYSTEM_PROMPT,
			messages: await convertToModelMessages(this.messages),
			tools,
			stopWhen: stepCountIs(4),
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}
}
