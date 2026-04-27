// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Capability: POST a JSON envelope to a user-supplied URL when an inbound-email
 * rule matches.
 *
 * Hardening (Phase 2 — see docs/review-remediation-plan.md W5):
 *   - HTTPS-only.
 *   - Reject IP-literal hostnames in private / loopback / link-local /
 *     multicast / metadata ranges. (We can't resolve DNS from a Worker, so
 *     hostnames pointing into private space via DNS are still possible — a
 *     per-mailbox host allowlist is the right next step.)
 *   - 5s connect+response timeout via AbortController.
 *   - Response read capped at 8 KiB so a hostile endpoint can't OOM the
 *     Worker by streaming an unbounded body.
 *   - User-supplied headers stripped of Host / Authorization / Cookie /
 *     Content-Length / hop-by-hop / Cloudflare-internal names so a rule
 *     author cannot impersonate the Worker or override our routing.
 */
import { z } from "zod";
import { register } from "../registry";

const Input = z.object({
	url: z.string().url(),
	method: z.enum(["POST", "PUT"]).default("POST"),
	headers: z.record(z.string()).optional(),
	includeEmail: z.boolean().default(true),
});

const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

/** Header names a rule author MUST NOT be able to set. Lowercased. */
const FORBIDDEN_HEADER_PREFIXES = ["cf-", "proxy-", "x-forwarded-", "x-real-"];
const FORBIDDEN_HEADER_NAMES = new Set([
	"host",
	"authorization",
	"cookie",
	"set-cookie",
	"content-length",
	"content-type", // we set this ourselves to application/json
	"connection",
	"keep-alive",
	"transfer-encoding",
	"te",
	"trailer",
	"upgrade",
	"expect",
]);

function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
	if (!input) return {};
	const out: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(input)) {
		if (typeof rawValue !== "string") continue;
		const name = rawName.toLowerCase().trim();
		if (!name) continue;
		if (FORBIDDEN_HEADER_NAMES.has(name)) continue;
		if (FORBIDDEN_HEADER_PREFIXES.some((p) => name.startsWith(p))) continue;
		// Strip CRLF to defeat header-injection attempts via header values.
		out[name] = rawValue.replace(/[\r\n]/g, " ");
	}
	return out;
}

/** True iff `host` is an IP literal in a range we refuse to proxy to. */
function isBlockedIpLiteral(host: string): boolean {
	const h = host.toLowerCase();
	// IPv6 literal — `[…]` already stripped by URL.host parsing on hostname,
	// but URL.hostname returns the bracketed form for IPv6 with port; here we
	// receive it without brackets via the URL.hostname property.
	if (h.includes(":")) {
		// Loopback ::1, unspecified ::, link-local fe80::/10, unique-local fc00::/7.
		if (h === "::1" || h === "::") return true;
		if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
		if (h.startsWith("fc") || h.startsWith("fd")) return true;
		// IPv4-mapped IPv6 like ::ffff:127.0.0.1
		const v4Mapped = h.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
		if (v4Mapped) return isBlockedIpLiteral(v4Mapped[1]);
		return false;
	}
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	if ([a, Number(v4[2]), Number(v4[3]), Number(v4[4])].some((n) => n < 0 || n > 255)) return true;
	if (a === 0) return true;                 // 0.0.0.0/8 "this network"
	if (a === 10) return true;                // 10.0.0.0/8 RFC1918
	if (a === 127) return true;               // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true;  // 169.254.0.0/16 link-local + AWS/GCP metadata
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
	if (a === 192 && b === 168) return true;  // 192.168.0.0/16 RFC1918
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a >= 224 && a <= 239) return true;    // 224.0.0.0/4 multicast
	if (a >= 240) return true;                // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
	return false;
}

/** Throws Error with a user-readable reason if the URL is unsafe to fetch. */
function assertSafeWebhookUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Webhook URL is invalid");
	}
	if (parsed.protocol !== "https:") {
		throw new Error("Webhook URL must use https://");
	}
	const host = parsed.hostname;
	if (!host) throw new Error("Webhook URL is missing a hostname");
	const lowered = host.toLowerCase();
	if (lowered === "localhost" || lowered.endsWith(".localhost")) {
		throw new Error("Webhook URL must not target localhost");
	}
	if (isBlockedIpLiteral(lowered)) {
		throw new Error("Webhook URL must not target a private, loopback, or metadata IP");
	}
	return parsed;
}

async function readCappedBody(res: Response, maxBytes: number): Promise<void> {
	if (!res.body) return;
	const reader = res.body.getReader();
	let total = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return;
			total += value?.byteLength ?? 0;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

register({
	id: "core:webhook",
	displayName: "Call a webhook",
	description: "POST a JSON envelope describing the matched email to an external URL.",
	surfaces: ["rule-action"],
	scopes: ["external.http"],
	version: 1,
	inputSchema: Input,
	async run(ctx, input) {
		let target: URL;
		try {
			target = assertSafeWebhookUrl(input.url);
		} catch (e) {
			return { error: e instanceof Error ? e.message : "Webhook URL rejected" };
		}
		const envelope = input.includeEmail
			? { mailboxId: ctx.mailboxId, emailId: ctx.emailId ?? null, triggeredBy: ctx.triggeredBy }
			: { triggeredBy: ctx.triggeredBy };
		const headers = {
			"content-type": "application/json",
			...sanitizeHeaders(input.headers),
		};
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
		try {
			const res = await fetch(target.toString(), {
				method: input.method,
				headers,
				body: JSON.stringify(envelope),
				signal: ac.signal,
				redirect: "manual", // don't auto-follow into a private network
			});
			// Drain (capped) so the connection isn't held open by an unbounded
			// response body. We deliberately do not return the body to the rule.
			await readCappedBody(res, MAX_RESPONSE_BYTES);
			return { status: res.status, ok: res.ok };
		} catch (e) {
			const aborted = e instanceof Error && (e.name === "AbortError" || ac.signal.aborted);
			return {
				error: aborted
					? `Webhook timed out after ${TIMEOUT_MS}ms`
					: e instanceof Error
						? e.message
						: "Webhook fetch failed",
			};
		} finally {
			clearTimeout(timer);
		}
	},
});
