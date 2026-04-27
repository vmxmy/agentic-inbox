// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolGetEmail } from "../../tools";

const Input = z.object({
	emailId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The email ID to retrieve. Optional when invoked from an inbound-email rule, where the matched email's ID is used by default.",
		),
});

register({
	id: "core:get-email",
	displayName: "Get email",
	description:
		"Get a single email with its full body content and attachments. Use this to read the actual content of an email.",
	surfaces: ["agent-tool", "mcp-tool"],
	scopes: ["mailbox.read"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		const emailId = input.emailId ?? ctx.emailId;
		if (!emailId) return { error: "emailId required" };
		return toolGetEmail(ctx.env, ctx.mailboxId, emailId);
	},
});
