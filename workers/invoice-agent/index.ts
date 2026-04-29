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
import {
	toolProcessEmailInvoices,
	toolListInvoices,
	toolGetInvoice,
	toolListBundles,
	toolGetBundle,
	toolCreateBundle,
	toolUpdateBundle,
	toolDeleteBundle,
	toolAddInvoiceToBundle,
	toolRemoveInvoiceFromBundle,
} from "../lib/invoice-tools";
import { getMailboxStub } from "../lib/email-helpers";
import { isL4McpEnabled } from "../lib/mcp-connections";
import { parseSdkToolKey, namespaceTool } from "../lib/mcp-tool-namespace";
import type { Env } from "../types";

interface OnNewEmailPayload {
	mailboxId: string;
	emailId: string;
	sender?: string;
	subject?: string;
	threadId?: string;
}

// AI SDK v6 changed tool() overloads significantly. Define tools as plain
// objects matching the Tool type to avoid overload resolution issues. Mirrors
// the same shim in workers/agent/index.ts.
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

const DEFAULT_SYSTEM_PROMPT = `You are the invoice and reimbursement assistant for this mailbox. You help the operator search invoices, manage reimbursement bundles, and re-run extraction on specific emails. You do not draft emails — that is a separate agent.

## Available data
- Invoices are extracted automatically from inbound emails. Each row carries invoice_number, issue_date, seller / buyer (name + tax_id), amounts (excl/incl tax), line items, and a reference back to the source email.
- Bundles are reimbursement packets the operator builds by grouping invoices.

## Tools
- process_email_invoices — re-run the deterministic extraction pipeline on one email. Use only when the user explicitly asks to re-process or fix-and-retry.
- list_invoices — search with filters (date range, seller / buyer name, invoice number, amount range). Returns paginated rows.
- get_invoice — fetch one invoice with line items.
- list_bundles, get_bundle — view bundles.
- create_bundle, update_bundle, delete_bundle — bundle CRUD.
- add_invoice_to_bundle, remove_invoice_from_bundle — manage membership.

## Behavior
- Answer queries directly. Do not narrate plans before calling tools.
- After a tool call, report results concisely (counts, totals, IDs). Do not re-list every row unless the user asks.
- The user may speak Chinese or English. Match their language.
- Display invoice numbers (发票号码) and IDs verbatim — never reformat them.
- Money amounts: display as numbers; currency is CNY unless stated otherwise.
- Voided invoices (\`is_voided=1\`) and red-credit invoices (rows with \`original_invoice_number\` set) cannot be added to bundles. If a tool returns this rejection, explain why.
- Never invent invoice fields. If a value is not in a tool result, say so — do not guess.`;

function resolveSystemPrompt(customPrompt: string | null): string {
	return customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
}

function createInvoiceTools(env: Env, mailboxId: string) {
	return {
		process_email_invoices: defineTool({
			description:
				"Re-run the deterministic invoice-extraction pipeline against an email. Idempotent — reuses existing derived attachments and dedupes by invoice_number. Returns { saved, skipped }.",
			parameters: z.object({
				emailId: z.string().describe("The email ID to re-process"),
			}),
			execute: async ({ emailId }): Promise<unknown> =>
				toolProcessEmailInvoices(env, mailboxId, emailId),
		}),

		list_invoices: defineTool({
			description:
				"Search invoices with optional filters. All filters AND together. dateFrom / dateTo are YYYY-MM-DD strings; sellerContains / buyerContains / itemContains are substring matches; invoiceNumber is exact match.",
			parameters: z.object({
				dateFrom: z.string().optional(),
				dateTo: z.string().optional(),
				sellerContains: z.string().optional(),
				buyerContains: z.string().optional(),
				invoiceNumber: z.string().optional(),
				minAmount: z.number().optional(),
				maxAmount: z.number().optional(),
				itemContains: z.string().optional(),
				limit: z
					.number()
					.min(1)
					.max(200)
					.optional()
					.describe("Default 50, capped at 200."),
				page: z.number().min(1).optional().describe("Default 1."),
			}),
			execute: async (args): Promise<unknown> =>
				toolListInvoices(env, mailboxId, args),
		}),

		get_invoice: defineTool({
			description:
				"Fetch a single invoice by id, including its line items.",
			parameters: z.object({
				invoiceId: z.string().describe("The invoice id"),
			}),
			execute: async ({ invoiceId }): Promise<unknown> =>
				toolGetInvoice(env, mailboxId, invoiceId),
		}),

		list_bundles: defineTool({
			description:
				"List all reimbursement bundles for this mailbox with invoice count and total amount per bundle.",
			parameters: z.object({}),
			execute: async (): Promise<unknown> =>
				toolListBundles(env, mailboxId),
		}),

		get_bundle: defineTool({
			description:
				"Fetch a bundle's metadata together with its full invoice list (ordered by position then issue_date).",
			parameters: z.object({
				bundleId: z.string().describe("The bundle id"),
			}),
			execute: async ({ bundleId }): Promise<unknown> =>
				toolGetBundle(env, mailboxId, bundleId),
		}),

		create_bundle: defineTool({
			description:
				"Create a new reimbursement bundle in 'draft' status.",
			parameters: z.object({
				name: z.string().describe("Bundle display name"),
				note: z
					.string()
					.nullable()
					.optional()
					.describe("Optional free-form note"),
			}),
			execute: async ({ name, note }): Promise<unknown> =>
				toolCreateBundle(env, mailboxId, { name, note: note ?? null }),
		}),

		update_bundle: defineTool({
			description:
				"Patch a bundle's name / note / status. Omit a field to leave it unchanged. Status values: 'draft', 'submitted', 'approved'.",
			parameters: z.object({
				bundleId: z.string(),
				name: z.string().optional(),
				note: z.string().nullable().optional(),
				status: z.string().optional(),
			}),
			execute: async ({ bundleId, name, note, status }): Promise<unknown> => {
				const patch: { name?: string; note?: string | null; status?: string } = {};
				if (name !== undefined) patch.name = name;
				if (note !== undefined) patch.note = note;
				if (status !== undefined) patch.status = status;
				return toolUpdateBundle(env, mailboxId, bundleId, patch);
			},
		}),

		delete_bundle: defineTool({
			description:
				"Delete a bundle. Bundle membership rows are cascade-deleted; the underlying invoices are not touched.",
			parameters: z.object({
				bundleId: z.string(),
			}),
			execute: async ({ bundleId }): Promise<unknown> =>
				toolDeleteBundle(env, mailboxId, bundleId),
		}),

		add_invoice_to_bundle: defineTool({
			description:
				"Add an invoice to a bundle. Refuses voided invoices and red-credit (negative-correction) invoices — neither is reimbursable.",
			parameters: z.object({
				bundleId: z.string(),
				invoiceId: z.string(),
			}),
			execute: async ({ bundleId, invoiceId }): Promise<unknown> =>
				toolAddInvoiceToBundle(env, mailboxId, bundleId, invoiceId),
		}),

		remove_invoice_from_bundle: defineTool({
			description:
				"Remove an invoice from a bundle. Idempotent (no error if not in bundle).",
			parameters: z.object({
				bundleId: z.string(),
				invoiceId: z.string(),
			}),
			execute: async ({ bundleId, invoiceId }): Promise<unknown> =>
				toolRemoveInvoiceFromBundle(env, mailboxId, bundleId, invoiceId),
		}),
	};
}

/**
 * InvoiceAgent — per-mailbox DO that handles invoice extraction (auto-triggered
 * from receiveEmail) and exposes a chat surface for invoice / bundle queries.
 *
 * Status:
 *   - PR1: skeleton + binding ✓
 *   - PR2: workers/lib/invoice-tools.ts tool wrappers ✓
 *   - PR3: receiveEmail → ctx.waitUntil(INVOICE_AGENT.fetch("/onNewEmail")) ✓
 *   - PR4: onChatMessage with invoice + bundle tool surface ✓
 *   - PR5: front-end InvoicePanel (pending)
 */
export class InvoiceAgent extends AIChatAgent<any> {
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/onNewEmail" && request.method === "POST") {
			try {
				const payload = (await request.json()) as OnNewEmailPayload;
				await this.handleNewEmail(payload);
				return new Response(null, { status: 204 });
			} catch (e) {
				console.error(
					"InvoiceAgent.onNewEmail failed:",
					(e as Error).message,
				);
				return new Response(
					JSON.stringify({ error: (e as Error).message }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}
		return super.onRequest(request);
	}

	/**
	 * Auto-triggered when a new email arrives. Delegates to the shared tool
	 * which resolves the per-mailbox allowed-domains config and calls
	 * MailboxDO.reprocessInvoicesForEmail — the canonical pipeline entrypoint
	 * shared with the manual reprocess path. Idempotent.
	 */
	async handleNewEmail(payload: OnNewEmailPayload): Promise<void> {
		const env = this.env as Env;
		try {
			const result = await toolProcessEmailInvoices(
				env,
				payload.mailboxId,
				payload.emailId,
			);
			if (result.saved.length || result.skipped.length) {
				console.log(
					`Invoice pipeline for ${payload.emailId}: saved=${result.saved.length} skipped=${result.skipped.length}`,
				);
			}
		} catch (e) {
			console.error(
				`Invoice pipeline failed for ${payload.emailId}:`,
				(e as Error).message,
			);
		}
	}

	/**
	 * Chat surface for invoice + bundle queries. Streams a model response with
	 * the full tool surface from workers/lib/invoice-tools.ts wired in.
	 */
	async onChatMessage(onFinish: any) {
		const env = this.env as Env;
		const mailboxId = this.name;
		const internalTools = createInvoiceTools(env, mailboxId);
		const config = await getAgentConfig(env, mailboxId);
		const systemPrompt = resolveSystemPrompt(config.invoiceAgentSystemPrompt);
		const cfg = await resolveLlmConfig(env);
		const provider = getLlmProvider(env, cfg);
		const catalog = await listLlmModels(env, { cfg });
		const modelId = pickModel(catalog, config.invoiceModel ?? config.model, cfg.defaultModel);

		// MIRROR: workers/agent/index.ts onChatMessage external-MCP merge.
		// If you change either site, change both.
		let externalNamespaced: ToolSet = {};
		if (isL4McpEnabled(env)) {
			const externalRaw = this.mcp.getAITools();
			const conns = await getMailboxStub(env, this.name).listMcpConnections();
			const knownConnIds = conns.map((c) => c.id);
			for (const [sdkKey, tool] of Object.entries(externalRaw)) {
				const parsed = parseSdkToolKey(sdkKey, knownConnIds);
				if (!parsed) continue;
				externalNamespaced[namespaceTool(parsed.connId, parsed.toolName)] = tool;
			}
		}
		const tools: ToolSet = { ...internalTools, ...externalNamespaced };

		const result = streamText({
			model: provider(modelId),
			system: systemPrompt,
			messages: await convertToModelMessages(this.messages),
			tools,
			stopWhen: stepCountIs(5),
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}
}
