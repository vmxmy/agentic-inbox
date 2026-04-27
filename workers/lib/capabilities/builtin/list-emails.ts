// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolListEmails } from "../../tools";
import { Folders, FOLDER_TOOL_DESCRIPTION } from "../../../../shared/folders";

const Input = z.object({
	folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
	limit: z.number().default(20).describe("Maximum number of emails to return"),
	page: z.number().default(1).describe("Page number for pagination"),
});

register({
	id: "core:list-emails",
	displayName: "List emails",
	description:
		"List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id). Use folder='inbox' for received emails, 'sent' for sent emails.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.read"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		return toolListEmails(ctx.env, ctx.mailboxId, {
			folder: input.folder ?? Folders.INBOX,
			limit: input.limit ?? 20,
			page: input.page ?? 1,
		});
	},
});
