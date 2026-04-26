// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolMoveEmail } from "../../tools";
import { MOVE_FOLDER_TOOL_DESCRIPTION } from "../../../../shared/folders";

const Input = z.object({
	emailId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The email ID. Optional when invoked from a rule on inbound mail (defaults to the matched email).",
		),
	folderId: z.string().min(1).describe(MOVE_FOLDER_TOOL_DESCRIPTION),
});

register({
	id: "core:move-email",
	displayName: "Move email to folder",
	description: "Move an email to a different folder (inbox, sent, draft, archive, trash).",
	surfaces: ["rule-action", "agent-tool", "mcp-tool"],
	scopes: ["mailbox.write"],
	inputSchema: Input,
	async run(ctx, input) {
		const emailId = input.emailId ?? ctx.emailId;
		if (!emailId) return { error: "emailId required" };
		return toolMoveEmail(ctx.env, ctx.mailboxId, emailId, input.folderId);
	},
});
