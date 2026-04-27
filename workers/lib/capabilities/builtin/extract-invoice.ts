// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { INTERNAL_SYSTEM_HEADER } from "../../auth";

const Input = z.object({
	emailId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Email to extract invoices from. Defaults to ctx.emailId (set by the rule executor on inbound mail).",
		),
});

register({
	id: "core:extract-invoice",
	displayName: "Extract invoice",
	description:
		"Parse Chinese 全电/增值税发票 XML attachments and persist header + line items to the mailbox database. Runs alongside Skip auto-draft.",
	surfaces: ["rule-action"],
	scopes: ["mailbox.write"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input): Promise<{ scheduled: boolean }> {
		const emailId = input.emailId ?? ctx.emailId;
		if (!emailId) {
			// No email in context — quiet no-op, matches the contract used by
			// other rule-only capabilities (e.g. extract-attachment-text).
			return { scheduled: false };
		}
		const stub = ctx.env.INVOICE_AGENT.get(
			ctx.env.INVOICE_AGENT.idFromName(ctx.mailboxId),
		);
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		// receiveEmail's worker-to-worker call carries this so the agent's
		// ACL-aware handlers recognise it as system-originated and bypass
		// user checks. Same model here.
		if (ctx.env.INTERNAL_SECRET) headers[INTERNAL_SYSTEM_HEADER] = ctx.env.INTERNAL_SECRET;

		const dispatch = stub.fetch(
			new Request("https://agents/onNewEmail", {
				method: "POST",
				headers,
				body: JSON.stringify({ mailboxId: ctx.mailboxId, emailId }),
			}),
		);

		// Prefer fire-and-forget: the InvoiceAgent does its own R2 / DO work
		// and `receiveEmail` should not wait for it. When invoked from the
		// rule executor we have ExecutionContext.waitUntil; agent-tool /
		// mcp paths (none today, but possible) fall back to awaiting so
		// the response is at least synchronous.
		if (ctx.waitUntil) {
			ctx.waitUntil(dispatch);
			return { scheduled: true };
		}
		await dispatch;
		return { scheduled: true };
	},
});
