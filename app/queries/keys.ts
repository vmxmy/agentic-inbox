// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Centralised query key factories for cache invalidation. */
export const queryKeys = {
	mailboxes: {
		all: ["mailboxes"] as const,
		detail: (id: string) => ["mailboxes", id] as const,
	},
	emails: {
		list: (mailboxId: string, params: Record<string, string>) =>
			["emails", mailboxId, params] as const,
		detail: (mailboxId: string, emailId: string) =>
			["emails", mailboxId, emailId] as const,
		thread: (mailboxId: string, threadId: string) =>
			["emails", mailboxId, "thread", threadId] as const,
	},
	folders: {
		list: (mailboxId: string) => ["folders", mailboxId] as const,
	},
	search: {
		results: (mailboxId: string, query: string, page: number) =>
			["search", mailboxId, query, page] as const,
	},
	config: ["config"] as const,
	whoami: ["whoami"] as const,
	apiKeys: ["api-keys"] as const,
	models: ["models"] as const,
	adminLlmProviders: ["admin", "llm-providers"] as const,
	capabilities: (mailboxId: string, surface?: string) =>
		["capabilities", mailboxId, surface ?? "all"] as const,
	members: (mailboxId: string) => ["members", mailboxId] as const,
	adminMailboxes: ["admin", "mailboxes"] as const,
	invoices: {
		list: (mailboxId: string, filters: Record<string, unknown>) =>
			["invoices", mailboxId, filters] as const,
		detail: (mailboxId: string, invoiceId: string) =>
			["invoices", mailboxId, invoiceId] as const,
	},
	bundles: {
		list: (mailboxId: string) => ["bundles", mailboxId] as const,
		detail: (mailboxId: string, bundleId: string) =>
			["bundles", mailboxId, bundleId] as const,
	},
};
