// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Invoice + reimbursement-bundle tool implementations consumed by
 * `InvoiceAgent` (auto-extract trigger from `receiveEmail` in PR3, and the
 * chat tool surface in PR4).
 *
 * Convention mirrors `workers/lib/tools.ts`: each function takes
 * `(env, mailboxId, params)`, calls `MailboxDO` RPC via `getMailboxStub`, and
 * returns either a raw object on success or `{ error: string }` on expected
 * failures (row not found, RPC-level rejection, etc). Agent / MCP callers
 * wrap the result in their own response shape.
 *
 * The MCP invoice/bundle tools (`workers/mcp/index.ts`) intentionally remain
 * wired directly to MailboxDO RPC for backwards compatibility — see PR plan
 * in `workers/invoice-agent/AGENTS.md`.
 */

import type { Env } from "../types";
import type { InvoiceFilters } from "../durableObject";
import { getMailboxStub } from "./email-helpers";
import { resolveInvoiceSourceDomains } from "./agent-config";

// ── Auto-extract orchestration ─────────────────────────────────────

/**
 * Run the invoice-extraction pipeline against an email already persisted to
 * MailboxDO. Resolves `allowedDomains` from per-mailbox config + worker-level
 * defaults, then delegates to `MailboxDO.reprocessInvoicesForEmail`, which is
 * the canonical entrypoint into `processEmailForInvoices` for both fresh
 * receives (after PR3) and reprocess-after-parser-fix paths.
 *
 * Idempotent: reuses existing derived / external-url attachments and dedupes
 * by `invoice_number`.
 */
export async function toolProcessEmailInvoices(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const allowedDomains = await resolveInvoiceSourceDomains(env, mailboxId);
	const stub = getMailboxStub(env, mailboxId);
	return stub.reprocessInvoicesForEmail(emailId, { allowedDomains });
}

// ── Invoice queries ────────────────────────────────────────────────

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
	if (!result) return { error: "invoice not found" };
	return result;
}

// ── Bundle queries ─────────────────────────────────────────────────

export async function toolListBundles(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.listBundles();
}

export async function toolGetBundle(
	env: Env,
	mailboxId: string,
	bundleId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.getBundle(bundleId);
	if (!result) return { error: "bundle not found" };
	return result;
}

// ── Bundle mutations ───────────────────────────────────────────────

export async function toolCreateBundle(
	env: Env,
	mailboxId: string,
	args: { name: string; note?: string | null },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.createBundle(args);
}

export async function toolUpdateBundle(
	env: Env,
	mailboxId: string,
	bundleId: string,
	patch: { name?: string; note?: string | null; status?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.updateBundle(bundleId, patch);
	if (!result) return { error: "bundle not found" };
	return result;
}

export async function toolDeleteBundle(
	env: Env,
	mailboxId: string,
	bundleId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const ok = await stub.deleteBundle(bundleId);
	if (!ok) return { error: "bundle not found" };
	return { ok: true };
}

export async function toolAddInvoiceToBundle(
	env: Env,
	mailboxId: string,
	bundleId: string,
	invoiceId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.addInvoiceToBundle(bundleId, invoiceId);
	if (!result.ok) return { error: result.error ?? "failed to add invoice" };
	return { ok: true };
}

export async function toolRemoveInvoiceFromBundle(
	env: Env,
	mailboxId: string,
	bundleId: string,
	invoiceId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const ok = await stub.removeInvoiceFromBundle(bundleId, invoiceId);
	if (!ok) return { error: "invoice not in bundle" };
	return { ok: true };
}
