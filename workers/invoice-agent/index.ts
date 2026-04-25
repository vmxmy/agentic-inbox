// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
import { toolProcessEmailInvoices } from "../lib/invoice-tools";
import type { Env } from "../types";

interface OnNewEmailPayload {
	mailboxId: string;
	emailId: string;
	sender?: string;
	subject?: string;
	threadId?: string;
}

/**
 * InvoiceAgent — per-mailbox DO that handles invoice extraction (auto-triggered
 * from receiveEmail) and exposes a chat surface for invoice / bundle queries.
 *
 * Status:
 *   - PR1: skeleton + binding ✓
 *   - PR2: workers/lib/invoice-tools.ts tool wrappers ✓
 *   - PR3: receiveEmail → ctx.waitUntil(INVOICE_AGENT.fetch("/onNewEmail")) ✓
 *   - PR4: onChatMessage with full invoice + bundle tool surface (pending)
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
	 * Chat surface for invoice + bundle queries. PR4 wires the full tool set
	 * (extraction tools, list/search invoices, create/manage bundles, reprocess).
	 */
	async onChatMessage(_onFinish: any): Promise<Response> {
		return new Response(
			JSON.stringify({ error: "InvoiceAgent chat not yet implemented" }),
			{
				status: 501,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}
