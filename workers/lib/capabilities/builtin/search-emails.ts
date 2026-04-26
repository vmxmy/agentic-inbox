// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolSearchEmails } from "../../tools";

const Input = z.object({
	query: z.string().min(1).describe("Search query to match against subject and body"),
	folder: z.string().optional().describe("Optional folder to restrict search to"),
});

register({
	id: "core:search-emails",
	displayName: "Search emails",
	description: "Search for emails matching a query across subject and body fields.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.read"],
	inputSchema: Input,
	async run(ctx, input) {
		return toolSearchEmails(ctx.env, ctx.mailboxId, input);
	},
});
