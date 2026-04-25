// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";

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
 * PR1 is a skeleton: the DO class, binding, and migration tag exist so the
 * runtime is wired up, but handleNewEmail and onChatMessage are stubs. Behaviour
 * lands in subsequent PRs:
 *   - PR2: workers/lib/invoice-tools.ts — extract pipeline steps into tools
 *   - PR3: receiveEmail → ctx.waitUntil(INVOICE_AGENT.fetch("/onNewEmail"))
 *   - PR4: onChatMessage with full invoice + bundle tool surface
 *   - PR5: front-end InvoicePanel (under /mailbox/:id/invoices and /bundles)
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
	 * Auto-triggered when a new email arrives. Stub in PR1; the deterministic
	 * invoice-pipeline orchestration moves here in PR3.
	 */
	async handleNewEmail(_payload: OnNewEmailPayload): Promise<void> {
		// PR3 will orchestrate detect → parse → save via invoice-tools.
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
