// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolDraftEmail } from "../../tools";

const Input = z.object({
	to: z.string().email().describe("Recipient email address"),
	subject: z.string().min(1).describe("Subject line"),
	body: z
		.string()
		.min(1)
		.describe("The plain text body of the email. No HTML — just write normally."),
	/** When true (default for agent surface) the body is treated as plain text
	 *  and HTML-escaped for the saved draft. MCP callers can pass HTML by
	 *  setting this false. */
	isPlainText: z.boolean().default(true),
	runVerifyDraft: z.boolean().optional(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
});

register({
	id: "core:draft-email",
	displayName: "Draft a new email",
	description:
		"Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review. Use this for composing new outbound emails. Write the body as plain text — no HTML tags.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.write"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		// Agent surface always treats body as plain text — matches today's
		// hardcoded `isPlainText: true` in `createEmailTools.draft_email`.
		const isPlainText = ctx.triggeredBy === "agent-tool" ? true : input.isPlainText;
		return toolDraftEmail(ctx.env, ctx.mailboxId, { ...input, isPlainText });
	},
});
