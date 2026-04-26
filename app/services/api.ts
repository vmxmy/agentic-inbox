// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
	Bundle,
	BundleDetail,
	BundleSummary,
	Email,
	Folder,
	Mailbox,
	InvoiceFilters,
	InvoiceListResponse,
	InvoiceDetailResponse,
} from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

// Routes that may legitimately return 401 (e.g. POST /login on bad creds);
// the page that called them is expected to surface the error inline.
const AUTH_ENDPOINT_PREFIX = "/api/v1/auth/";
// Public auth pages: don't redirect-loop while the user is signing in.
const AUTH_PAGE_RE = /^\/(login|register|magic|forgot-password|reset-password|verify-email)(?:\/|$)/;

function shouldRedirectOn401(url: string): boolean {
	if (typeof window === "undefined") return false;
	if (url.startsWith(AUTH_ENDPOINT_PREFIX)) return false;
	if (AUTH_PAGE_RE.test(window.location.pathname)) return false;
	return true;
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			// Session-expiry interceptor: when an authenticated XHR returns 401
			// from a non-auth endpoint while the user is on a protected page,
			// kick them to /login and remember where they were. The throw still
			// happens so callers see the error — the navigation will unmount
			// them shortly after.
			if (res.status === 401 && shouldRedirectOn401(url)) {
				const next = window.location.pathname + window.location.search;
				window.location.assign(`/login?next=${encodeURIComponent(next)}`);
			}
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[] }>("/api/v1/config"),

	// Identity
	whoami: () =>
		get<{
			id: string;
			email: string;
			isAdmin: boolean;
			role: "user" | "admin";
			system: boolean;
		}>("/api/v1/whoami"),

	// Auth
	register: (email: string, password: string, displayName?: string) =>
		post<{ ok: true; message: string }>("/api/v1/auth/register", { email, password, displayName }),
	login: (email: string, password: string) =>
		post<{ ok: true; user: { id: string; email: string; role: string; displayName: string | null } }>(
			"/api/v1/auth/login",
			{ email, password },
		),
	logout: () => post<{ ok: true }>("/api/v1/auth/logout"),
	requestMagicLink: (email: string) =>
		post<{ ok: true; message: string }>("/api/v1/auth/magic-link/request", { email }),
	consumeMagicLink: (token: string) =>
		get<{ ok: true }>(`/api/v1/auth/magic-link/consume?token=${encodeURIComponent(token)}`),
	forgotPassword: (email: string) =>
		post<{ ok: true; message: string }>("/api/v1/auth/password/forgot", { email }),
	resetPassword: (token: string, password: string) =>
		post<{ ok: true }>("/api/v1/auth/password/reset", { token, password }),

	// API keys (Bearer tokens for MCP / programmatic clients)
	listApiKeys: () =>
		get<Array<{
			id: string;
			name: string;
			prefix: string;
			lastUsedAt: number | null;
			expiresAt: number | null;
			revokedAt: number | null;
			createdAt: number;
		}>>("/api/v1/api-keys"),
	createApiKey: (name: string, expiresAt?: number) =>
		post<{
			key: string;
			record: {
				id: string;
				name: string;
				prefix: string;
				lastUsedAt: number | null;
				expiresAt: number | null;
				revokedAt: number | null;
				createdAt: number;
			};
		}>("/api/v1/api-keys", { name, expiresAt }),
	revokeApiKey: (id: string) => del<void>(`/api/v1/api-keys/${id}`),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Members
	listMembers: (mailboxId: string) =>
		get<{ owner: string | null; members: string[] }>(`/api/v1/mailboxes/${mailboxId}/members`),
	addMember: (mailboxId: string, email: string) =>
		post<{ owner: string | null; members: string[] }>(
			`/api/v1/mailboxes/${mailboxId}/members`,
			{ email },
		),
	removeMember: (mailboxId: string, email: string) =>
		del<{ owner: string | null; members: string[] }>(
			`/api/v1/mailboxes/${mailboxId}/members/${encodeURIComponent(email)}`,
		),

	// Invites
	createInvite: (mailboxId: string) =>
		post<{ token: string; url: string; expiresAt: number }>(
			`/api/v1/mailboxes/${mailboxId}/invites`,
		),
	acceptInvite: (token: string) =>
		post<{ mailboxId: string; owner: string | null; members: string[]; already?: string }>(
			`/api/v1/invites/accept`,
			{ token },
		),

	// Admin
	adminListMailboxes: () =>
		get<Array<{
			id: string;
			email: string;
			owner: string | null;
			memberCount: number;
			inboxCount: number | null;
		}>>("/api/v1/admin/mailboxes"),
	adminCreateMailboxForUser: (userId: string, email: string, name: string, settings?: unknown) =>
		post<Mailbox>(`/api/v1/admin/users/${userId}/mailboxes`, { email, name, settings }),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),

	// Invoices
	listInvoices: (mailboxId: string, filters: InvoiceFilters = {}) => {
		const params: Record<string, string> = {};
		for (const [k, v] of Object.entries(filters)) {
			if (v !== undefined && v !== null && v !== "") params[k] = String(v);
		}
		return get<InvoiceListResponse>(`/api/v1/mailboxes/${mailboxId}/invoices`, { params });
	},
	getInvoice: (mailboxId: string, invoiceId: string) =>
		get<InvoiceDetailResponse>(`/api/v1/mailboxes/${mailboxId}/invoices/${invoiceId}`),
	deleteInvoice: (mailboxId: string, invoiceId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/invoices/${invoiceId}`),
	/**
	 * Build a download URL for the CSV export. Returned as a string (not
	 * fetched) so the caller can hand it to the browser's download path
	 * (`<a href>` / `window.open`) and let the streamed response come down
	 * directly.
	 */
	invoicesExportUrl: (mailboxId: string, filters: InvoiceFilters = {}): string => {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(filters)) {
			if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
		}
		const query = qs.toString();
		return query
			? `/api/v1/mailboxes/${mailboxId}/invoices.csv?${query}`
			: `/api/v1/mailboxes/${mailboxId}/invoices.csv`;
	},
	uploadInvoiceFile: (
		mailboxId: string,
		emailId: string,
		args: { filename: string; mimetype?: string; content_base64: string },
	) =>
		post<{
			attachmentId: string;
			invoiceId?: string;
			invoice_number?: string;
			reason?: string;
		}>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/invoice-file`,
			args,
		),

	// Reimbursement bundles
	listBundles: (mailboxId: string) =>
		get<BundleSummary[]>(`/api/v1/mailboxes/${mailboxId}/bundles`),
	createBundle: (mailboxId: string, args: { name: string; note?: string | null }) =>
		post<Bundle>(`/api/v1/mailboxes/${mailboxId}/bundles`, args),
	getBundle: (mailboxId: string, bundleId: string) =>
		get<BundleDetail>(`/api/v1/mailboxes/${mailboxId}/bundles/${bundleId}`),
	updateBundle: (
		mailboxId: string,
		bundleId: string,
		patch: { name?: string; note?: string | null; status?: string },
	) =>
		put<Bundle>(
			`/api/v1/mailboxes/${mailboxId}/bundles/${bundleId}`,
			patch,
		),
	deleteBundle: (mailboxId: string, bundleId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/bundles/${bundleId}`),
	addInvoiceToBundle: (mailboxId: string, bundleId: string, invoiceId: string) =>
		post<{ ok: boolean }>(
			`/api/v1/mailboxes/${mailboxId}/bundles/${bundleId}/invoices/${invoiceId}`,
		),
	removeInvoiceFromBundle: (mailboxId: string, bundleId: string, invoiceId: string) =>
		del<void>(
			`/api/v1/mailboxes/${mailboxId}/bundles/${bundleId}/invoices/${invoiceId}`,
		),
	bundleZipUrl: (mailboxId: string, bundleId: string): string =>
		`/api/v1/mailboxes/${mailboxId}/bundles/${bundleId}.zip`,
};

export default api;
