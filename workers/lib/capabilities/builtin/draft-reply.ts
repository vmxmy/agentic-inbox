// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolDraftReply } from "../../tools";

const Input = z.object({
	originalEmailId: z.string().min(1).describe("The ID of the email being replied to"),
	to: z.string().email().describe("Recipient email address"),
	subject: z.string().min(1).describe("Subject line (usually 'Re: ...')"),
	body: z
		.string()
		.min(1)
		.describe("The plain text body of the reply. No HTML — just write normally."),
	/** When true (default for agent surface) the body is HTML-escaped before
	 *  save. MCP callers can pass HTML by setting this false. */
	isPlainText: z.boolean().default(true),
	runVerifyDraft: z.boolean().optional(),
});

register({
	id: "core:draft-reply",
	displayName: "Draft a reply",
	description:
		"Draft a reply to an existing email and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review and send from the UI. Write the body as plain text — no HTML tags.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.write"],
	inputSchema: Input,
	async run(ctx, input) {
		// Agent surface forces plain-text + AI safety verify — matches today's
		// hardcoded `isPlainText: true, runVerifyDraft: true` in
		// `createEmailTools.draft_reply`.
		const isPlainText = ctx.triggeredBy === "agent-tool" ? true : input.isPlainText;
		const runVerifyDraft =
			ctx.triggeredBy === "agent-tool" ? true : input.runVerifyDraft;
		return toolDraftReply(ctx.env, ctx.mailboxId, {
			...input,
			isPlainText,
			runVerifyDraft,
		});
	},
});
