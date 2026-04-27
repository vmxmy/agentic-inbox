// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolDiscardDraft } from "../../tools";

const Input = z.object({
	draftId: z.string().min(1).describe("The ID of the draft to delete"),
});

register({
	id: "core:discard-draft",
	displayName: "Discard a draft",
	description:
		"Delete a draft email. Use this to discard drafts that are no longer needed or were rejected by the operator.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.write"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		return toolDiscardDraft(ctx.env, ctx.mailboxId, input.draftId);
	},
});
