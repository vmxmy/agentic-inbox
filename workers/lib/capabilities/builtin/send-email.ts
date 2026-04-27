// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import { toolSendEmail } from "../../tools";
import { textToHtml } from "../../email-helpers";

const Input = z.object({
	to: z.string().email(),
	subject: z.string().min(1),
	body: z.string().min(1),
	/** When true (default) the body is plain text and HTML-escaped before send. */
	isPlainText: z.boolean().default(true),
});

register({
	id: "core:send-email",
	displayName: "Send email",
	description:
		"Send a brand-new email via the mailbox's outbound binding. Deliberately not exposed to agents — agents only draft.",
	surfaces: ["mcp-tool"],
	scopes: ["email.send"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		const bodyHtml = input.isPlainText ? textToHtml(input.body) : input.body;
		return toolSendEmail(ctx.env, ctx.mailboxId, {
			to: input.to,
			subject: input.subject,
			bodyHtml,
		});
	},
});
