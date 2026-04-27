// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolMarkEmailRead } from "../../tools";

const Input = z.object({
	emailId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The email ID. Optional when invoked from a rule on inbound mail (defaults to the matched email).",
		),
	read: z.boolean().default(true).describe("true to mark as read, false for unread"),
});

register({
	id: "core:mark-email-read",
	displayName: "Mark email read/unread",
	description: "Mark an email as read or unread.",
	surfaces: ["rule-action", "agent-tool", "mcp-tool"],
	scopes: ["mailbox.write"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		const emailId = input.emailId ?? ctx.emailId;
		if (!emailId) return { error: "emailId required" };
		return toolMarkEmailRead(ctx.env, ctx.mailboxId, emailId, input.read ?? true);
	},
});
