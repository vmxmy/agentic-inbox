// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Recipient normalization for inbound Email Workers events.
 *
 * Cloudflare Email Routing exposes the envelope recipient as `message.to`.
 * That value is the address the Worker actually received, even when the
 * message headers omit it (for example Bcc or mailing-list deliveries).
 */

export interface HeaderRecipient {
	address?: string | null;
}

function normalizeRecipient(address: string | null | undefined): string | null {
	const normalized = address?.trim().toLowerCase();
	return normalized && normalized.includes("@") ? normalized : null;
}

export function collectInboundRecipientAddresses(
	envelopeTo: string | null | undefined,
	headerTo: HeaderRecipient[] | null | undefined,
): string[] {
	const seen = new Set<string>();
	const recipients: string[] = [];
	for (const candidate of [
		envelopeTo,
		...(headerTo ?? []).map((recipient) => recipient.address),
	]) {
		const normalized = normalizeRecipient(candidate);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		recipients.push(normalized);
	}
	return recipients;
}
