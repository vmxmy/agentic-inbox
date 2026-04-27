// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";
import type { CapabilityPromptContribution } from "../types";
import { extractAttachmentsInline, looksLikeXml } from "../../attachment-extract";

const Input = z.object({
	emailId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Email to extract attachments from. Defaults to ctx.emailId (set by the rule executor on inbound mail).",
		),
	filterExts: z
		.array(z.string())
		.optional()
		.describe(
			"Optional case-insensitive whitelist of file extensions (no leading dot). When omitted, every extractable format is processed.",
		),
});

register({
	id: "core:extract-attachment-text",
	displayName: "Extract attachment text",
	description:
		"Parse text-based attachments (XML inline; PDF deferred to async OCR) and feed the extracted block into the auto-draft agent's prompt.",
	surfaces: ["rule-action"],
	scopes: ["mailbox.read"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input): Promise<CapabilityPromptContribution> {
		const emailId = input.emailId ?? ctx.emailId;
		if (!emailId) {
			// No email in context — quiet no-op. A rule with multiple actions
			// should not blow up the rest of the sequence just because this
			// capability had nothing to operate on.
			return { promptText: "", deferredPdfs: [] };
		}
		const stub = ctx.env.MAILBOX.get(ctx.env.MAILBOX.idFromName(ctx.mailboxId));
		const email = await stub.getEmail(emailId);
		if (!email || !email.attachments?.length) {
			return { promptText: "", deferredPdfs: [] };
		}

		// Filter on metadata before paying for R2 GETs — extractor only handles
		// XML synchronously, and PDFs go through deferred OCR. Anything else
		// (images, archives, office docs) is silently skipped today.
		const extractable = email.attachments.filter((att) => {
			if (looksLikeXml({ filename: att.filename, mimetype: att.mimetype })) return true;
			const isPdfMime = (att.mimetype || "").toLowerCase() === "application/pdf";
			const isPdfExt = att.filename.toLowerCase().endsWith(".pdf");
			return isPdfMime || isPdfExt;
		});
		if (extractable.length === 0) {
			return { promptText: "", deferredPdfs: [] };
		}

		// Attachments live at `attachments/<emailId>/<id>/<filename>` (see
		// workers/lib/attachments.ts). Fetch all in parallel — the parsed
		// content is in memory only briefly per attachment, then dropped.
		const fetched = await Promise.all(
			extractable.map(async (att) => {
				const key = `attachments/${emailId}/${att.id}/${att.filename}`;
				const obj = await ctx.env.BUCKET.get(key);
				if (!obj) return null;
				const content = await obj.arrayBuffer();
				return {
					filename: att.filename,
					mimetype: att.mimetype,
					content,
				};
			}),
		);
		const ready = fetched.filter((a): a is NonNullable<typeof a> => a !== null);

		const { text, skippedPdf } = extractAttachmentsInline(ready, {
			filterExts: input.filterExts,
		});
		return { promptText: text, deferredPdfs: skippedPdf };
	},
});
