// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Phase-1 proof-of-extensibility capability: POST a JSON envelope to a
 * user-supplied URL when an inbound-email rule matches.
 *
 * TODO(security): no URL allowlist or SSRF protection in Phase 1. Single
 * tenant + admin == owner of the mailbox makes the risk acceptable; harden
 * before opening invites to untrusted users (block RFC1918 ranges,
 * 169.254.169.254, localhost; consider per-mailbox host whitelist).
 */
import { z } from "zod";
import { register } from "../registry";

const Input = z.object({
	url: z.string().url(),
	method: z.enum(["POST", "PUT"]).default("POST"),
	headers: z.record(z.string()).optional(),
	includeEmail: z.boolean().default(true),
});

register({
	id: "core:webhook",
	displayName: "Call a webhook",
	description: "POST a JSON envelope describing the matched email to an external URL.",
	surfaces: ["rule-action"],
	scopes: ["external.http"],
	inputSchema: Input,
	async run(ctx, input) {
		console.warn(
			`[capability:core:webhook] outbound ${input.method} ${input.url} ` +
				`mailbox=${ctx.mailboxId} email=${ctx.emailId ?? "—"} (no SSRF protection in Phase 1)`,
		);
		const envelope = input.includeEmail
			? { mailboxId: ctx.mailboxId, emailId: ctx.emailId ?? null, triggeredBy: ctx.triggeredBy }
			: { triggeredBy: ctx.triggeredBy };
		try {
			const res = await fetch(input.url, {
				method: input.method,
				headers: { "Content-Type": "application/json", ...(input.headers ?? {}) },
				body: JSON.stringify(envelope),
			});
			return { status: res.status, ok: res.ok };
		} catch (e) {
			return { error: e instanceof Error ? e.message : "Webhook fetch failed" };
		}
	},
});
