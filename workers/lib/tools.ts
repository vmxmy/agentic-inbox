// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildThreadingHeaders,
} from "./email-helpers";
import { verifyDraft } from "./ai";
import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import type { InvoiceFilters } from "../durableObject";
import { submitAndWait, DeepReadError } from "./deepread";
import {
	CHINA_INVOICE_OCR_SCHEMA,
	ocrResultToParsedInvoice,
} from "./invoice-ocr";
import {
	uploadInvoiceFileAndExtract,
	type ManualUploadResult,
} from "./invoice-manual-upload";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || params.to,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
): Promise<
	| { status: string; draftId: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const sanitized = await verifyDraft(env.AI, processedBody);
		if (!sanitized) {
			return { error: "Draft verification failed — body could not be verified. Please try again." };
		}
		processedBody = sanitized;
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verifiedBody = await verifyDraft(env.AI, rawBody);

	if (!verifiedBody) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}

	await stub.deleteEmail(params.draftId);
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	await stub.deleteEmail(draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.deleteEmail(emailId);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	return { status: "deleted", emailId };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Verify and append quoted original message
	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references:
				references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

// ── forward_email ──────────────────────────────────────────────────

/**
 * Forward an existing email to a new recipient. Starts a new thread
 * (forward is a new conversation, not a continuation). Body is verified
 * via verifyDraft; the original email is appended as a quoted block.
 */
export async function toolForwardEmail(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) return { error: "Invalid mailbox email address" };
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const rawBody = params.bodyHtml ?? "";
	const sanitizedBody = rawBody
		? await verifyDraft(env.AI, rawBody)
		: "";
	if (rawBody && !sanitizedBody) {
		return { error: "Draft verification failed — refusing to forward unverified content. Please try again." };
	}

	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || "",
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = (sanitizedBody || "") + quotedBlock;

	const forwardSubject = params.subject
		?? (originalEmail.subject?.startsWith("Fwd:")
			? originalEmail.subject
			: `Fwd: ${originalEmail.subject ?? ""}`);

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: forwardSubject,
			html: fullBodyHtml,
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to forward email: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: forwardSubject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Forwarded to ${params.to}` };
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
	},
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const sanitizedBody = await verifyDraft(env.AI, params.bodyHtml);
	if (!sanitizedBody) {
		return { error: "Draft verification failed — refusing to send unverified content. Please try again." };
	}

	try {
		await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
		});
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			message_id: outgoingMessageId,
		},
		[],
	);

	return { status: "sent", messageId, message: `Email sent to ${params.to}` };
}

// ── invoices ───────────────────────────────────────────────────────

export async function toolListInvoices(
	env: Env,
	mailboxId: string,
	filters: InvoiceFilters = {},
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.listInvoices(filters);
}

export async function toolGetInvoice(
	env: Env,
	mailboxId: string,
	invoiceId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.getInvoice(invoiceId);
	if (!result) return { error: "Invoice not found" };
	return result;
}

export async function toolDeleteInvoice(
	env: Env,
	mailboxId: string,
	invoiceId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const ok = await stub.deleteInvoice(invoiceId);
	if (!ok) return { error: "Invoice not found" };
	return { status: "deleted", invoiceId };
}

export async function toolReprocessInvoicesForEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const { resolveInvoiceSourceDomains } = await import("./agent-config");
	const allowedDomains = await resolveInvoiceSourceDomains(env, mailboxId);
	const stub = getMailboxStub(env, mailboxId);
	return stub.reprocessInvoicesForEmail(emailId, { allowedDomains });
}

// ── PDF OCR via DeepRead ──────────────────────────────────────────

export interface ExtractInvoiceFromPdfResult {
	invoiceId?: string;
	invoice_number?: string;
	needs_review?: boolean;
	review_fields?: string[];
	error?: string;
}

/**
 * Manual PDF → invoice extraction for cases where no XML source is available
 * (the file format is PDF-only). Submits the PDF to DeepRead, polls, maps
 * the response into our ParsedInvoice shape, and persists with
 * `source_kind='pdf-ocr'`. The invoice row is flagged `needs_review` when
 * any extracted field carries DeepRead's `hil_flag`.
 */
export async function toolExtractInvoiceFromPdf(
	env: Env,
	mailboxId: string,
	attachmentId: string,
): Promise<ExtractInvoiceFromPdfResult> {
	if (!env.DEEPREAD_API_KEY) {
		return { error: "DEEPREAD_API_KEY is not configured on this Worker. Run `wrangler secret put DEEPREAD_API_KEY`." };
	}
	const stub = getMailboxStub(env, mailboxId);

	const att = await stub.findAttachmentById(attachmentId);
	if (!att) return { error: `Attachment ${attachmentId} not found in this mailbox` };
	const lowerName = att.filename.toLowerCase();
	const mt = (att.mimetype || "").toLowerCase();
	const looksLikePdf = lowerName.endsWith(".pdf") || mt === "application/pdf";
	if (!looksLikePdf) {
		return {
			error: `Attachment ${attachmentId} is not a PDF (filename=${att.filename}, mimetype=${att.mimetype})`,
		};
	}

	const r2Key = `attachments/${att.email_id}/${att.id}/${att.filename}`;
	const obj = await env.BUCKET.get(r2Key);
	if (!obj) return { error: `R2 object missing at ${r2Key}` };
	const bytes = new Uint8Array(await obj.arrayBuffer());

	// Submit + poll. DeepRead typically completes Chinese invoices in ~10-30s.
	let result;
	try {
		({ result } = await submitAndWait(env.DEEPREAD_API_KEY, {
			bytes,
			filename: att.filename,
			schema: CHINA_INVOICE_OCR_SCHEMA,
		}));
	} catch (e) {
		if (e instanceof DeepReadError) {
			return { error: `DeepRead ${e.code}: ${e.message}` };
		}
		return { error: (e as Error).message };
	}

	const mapped = ocrResultToParsedInvoice(result, { rawBytes: bytes });
	if (!mapped) {
		return {
			error:
				"DeepRead returned no usable invoice fields (missing invoice_number or issue_date)",
		};
	}

	// Dedupe by invoice_number per mailbox — same semantics as the XML
	// pipeline.
	const existing = await stub.listInvoices({
		invoiceNumber: mapped.parsed.invoice_number,
		limit: 1,
	});
	if (existing.totalCount > 0) {
		return {
			error: `duplicate invoice_number=${mapped.parsed.invoice_number} already saved in this mailbox`,
		};
	}

	const invoiceId = await stub.saveInvoice(
		att.email_id,
		att.id,
		mapped.parsed,
		{ sourceKind: "pdf-ocr", needsReview: mapped.needsReview },
	);
	return {
		invoiceId,
		invoice_number: mapped.parsed.invoice_number,
		needs_review: mapped.needsReview,
		review_fields: mapped.reviewFields,
	};
}

// ── Manual invoice file upload ────────────────────────────────────

/** Decode base64 to Uint8Array. Workers/standard `atob`. */
function base64ToBytes(b64: string): Uint8Array {
	// Strip common prefixes (e.g. `data:application/xml;base64,...`)
	const comma = b64.indexOf(",");
	const pure = comma >= 0 && b64.slice(0, comma).includes("base64") ? b64.slice(comma + 1) : b64;
	const bin = atob(pure);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const MAX_MANUAL_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function toolUploadInvoiceFile(
	env: Env,
	mailboxId: string,
	emailId: string,
	args: {
		filename: string;
		mimetype?: string;
		content_base64: string;
	},
): Promise<ManualUploadResult> {
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(args.content_base64);
	} catch (e) {
		return { attachmentId: "", reason: `Invalid base64: ${(e as Error).message}` };
	}
	if (bytes.byteLength > MAX_MANUAL_UPLOAD_BYTES) {
		return {
			attachmentId: "",
			reason: `File too large (${bytes.byteLength} bytes, max ${MAX_MANUAL_UPLOAD_BYTES})`,
		};
	}
	if (bytes.byteLength === 0) {
		return { attachmentId: "", reason: "Empty file" };
	}
	return uploadInvoiceFileAndExtract(env, mailboxId, emailId, {
		filename: args.filename,
		mimetype: args.mimetype,
		content: bytes,
	});
}
