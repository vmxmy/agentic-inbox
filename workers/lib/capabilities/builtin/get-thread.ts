// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolGetThread } from "../../tools";

const Input = z.object({
	threadId: z
		.string()
		.min(1)
		.describe(
			"The thread_id to retrieve all messages for. Get this from an email's thread_id field.",
		),
});

register({
	id: "core:get-thread",
	displayName: "Get email thread",
	description:
		"Get all emails in a conversation thread. This is essential for understanding the full context of a conversation before drafting a response. Returns all messages sorted chronologically.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.read"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		return toolGetThread(ctx.env, ctx.mailboxId, input.threadId);
	},
});
