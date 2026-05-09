// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolDraftEmail } from "../../tools";

const AttachmentRef = z.object({
	fileId: z.string().optional(),
	filename: z.string().optional(),
	ordinal: z.number().int().positive().optional(),
	reference: z.string().optional(),
});

const Input = z.object({
	to: z.string().email().describe("Recipient email address"),
	subject: z.string().min(1).describe("Subject line"),
	body: z
		.string()
		.min(1)
		.describe(
			"Email body. By default this is plain text. To preserve HTML formatting, pass a safe HTML fragment and set isPlainText to false. Do not wrap HTML in markdown code fences or escape tags.",
		),
	/** When true (default) the body is treated as plain text and HTML-escaped for
	 *  the saved draft. Set false to preserve a safe HTML fragment. */
	isPlainText: z.boolean().default(true),
	runVerifyDraft: z.boolean().optional(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	attachments: z.array(AttachmentRef).max(5).optional().describe("Files from the current chat to attach. Use fileId when available; otherwise filename, ordinal, or reference text."),
});

register({
	id: "core:draft-email",
	displayName: "Draft a new email",
	description:
		"Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review. Use this for composing new outbound emails. Body defaults to plain text; set isPlainText to false only when passing a safe HTML fragment that should render as formatted email content.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.write"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		return toolDraftEmail(ctx.env, ctx.mailboxId, {
				...input,
				isPlainText: input.isPlainText,
				chatFiles: ctx.chatFiles,
			});
	},
});
