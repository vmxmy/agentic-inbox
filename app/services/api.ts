// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type {
	Email,
	Folder,
	Mailbox,
	Team,
	TeamUser,
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
			hasPassword: boolean;
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
	requestMagicLink: (email: string, next?: string) =>
		post<{ ok: true; message: string }>("/api/v1/auth/magic-link/request", {
			email,
			...(next ? { next } : {}),
		}),
	consumeMagicLink: (token: string) =>
		get<{ ok: true }>(`/api/v1/auth/magic-link/consume?token=${encodeURIComponent(token)}`),
	forgotPassword: (email: string) =>
		post<{ ok: true; message: string }>("/api/v1/auth/password/forgot", { email }),
	resetPassword: (token: string, password: string) =>
		post<{ ok: true }>("/api/v1/auth/password/reset", { token, password }),
	changePassword: (currentPassword: string | null, newPassword: string) =>
		post<{ ok: true }>("/api/v1/auth/password/change", {
			...(currentPassword ? { currentPassword } : {}),
			newPassword,
		}),

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

	// LLM model catalog — fetched from the configured LLM_BASE_URL/v1/models,
	// cached in-process by the worker for 5 minutes.
	listModels: (force?: boolean) =>
		get<{
			default: string | null;
			models: Array<{ id: string; owned_by?: string; created?: number; object?: string }>;
		}>("/api/v1/models", force ? { params: { force: "1" } } : undefined),

	// LLM provider registry (admin-only)
	adminListLlmProviders: () =>
		get<Array<{
			id: string;
			name: string;
			baseUrl: string;
			apiKeyMasked: string;
			defaultModel: string;
			enabled: boolean;
			isDefault: boolean;
			createdAt: number;
			updatedAt: number;
		}>>("/api/v1/admin/llm-providers"),
	adminCreateLlmProvider: (input: {
		name: string;
		baseUrl: string;
		apiKey: string;
		defaultModel: string;
		enabled?: boolean;
		makeDefault?: boolean;
	}) =>
		post<{
			id: string;
			name: string;
			baseUrl: string;
			apiKeyMasked: string;
			defaultModel: string;
			enabled: boolean;
			isDefault: boolean;
			createdAt: number;
			updatedAt: number;
		}>("/api/v1/admin/llm-providers", input),
	adminUpdateLlmProvider: (
		id: string,
		patch: Partial<{
			name: string;
			baseUrl: string;
			apiKey: string;
			defaultModel: string;
			enabled: boolean;
			makeDefault: boolean;
		}>,
	) => put<{
		id: string;
		name: string;
		baseUrl: string;
		apiKeyMasked: string;
		defaultModel: string;
		enabled: boolean;
		isDefault: boolean;
		createdAt: number;
		updatedAt: number;
	}>(`/api/v1/admin/llm-providers/${id}`, patch),
	adminDeleteLlmProvider: (id: string) =>
		del<void>(`/api/v1/admin/llm-providers/${id}`),
	adminTestLlmProvider: (id: string) =>
		post<{ ok: boolean; modelCount: number; modelIds: string[] }>(
			`/api/v1/admin/llm-providers/${id}/test`,
		),
	/** Probe an unsaved provider's `/v1/models` so the form can populate the
	 *  default-model dropdown before the row is committed. */
	adminDiscoverLlmModels: (baseUrl: string, apiKey: string) =>
		post<{
			ok: boolean;
			modelCount: number;
			models: Array<{ id: string; owned_by?: string; created?: number; object?: string }>;
		}>("/api/v1/admin/llm-providers/discover", { baseUrl, apiKey }),

	// Capabilities (rule actions / agent skills / mcp tools, all backed by
	// the same workers/lib/capabilities registry)
	listCapabilities: (
		mailboxId: string,
		filter?: { surface?: "rule-action" | "agent-tool" | "mcp-tool" },
	) =>
		get<{
			capabilities: Array<{
				id: string;
				displayName: string;
				description: string;
				surfaces: ReadonlyArray<"rule-action" | "agent-tool" | "mcp-tool">;
				scopes: readonly string[];
				inputSchema: unknown;
			}>;
		}>(
			`/api/v1/mailboxes/${mailboxId}/capabilities`,
			filter?.surface ? { params: { surface: filter.surface } } : undefined,
		),

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
		get<{
			owner: string | null;
			members: string[];
			teamManaged?: boolean;
			team?: Mailbox["team"] | null;
		}>(`/api/v1/mailboxes/${mailboxId}/members`),
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
			team: Mailbox["team"] | null;
		}>>("/api/v1/admin/mailboxes"),
	adminCreateMailboxForUser: (userId: string, email: string, name: string, settings?: unknown) =>
		post<Mailbox>(`/api/v1/admin/users/${userId}/mailboxes`, { email, name, settings }),
	adminListTeams: () => get<Team[]>("/api/v1/admin/teams"),
	adminCreateTeam: (name: string, displayName: string) =>
		post<Team>("/api/v1/admin/teams", { name, displayName }),
	adminListTeamUsers: (teamId: string) =>
		get<TeamUser[]>(`/api/v1/admin/teams/${teamId}/users`),
	adminCreateTeamUser: (teamId: string, userName: string, displayName: string) =>
		post<TeamUser>(`/api/v1/admin/teams/${teamId}/users`, { userName, displayName }),

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

	// L4 — external MCP connections (owner-only mutations, member-readable list).
	// Routes are flag-gated server-side via L4_MCP_ENABLED; the read path
	// returns an empty list when the flag is off so the UI can render a
	// "feature disabled" empty state without surfacing a 503.
	listMcpConnections: (mailboxId: string) =>
		get<{ connections: McpConnectionDto[] }>(
			`/api/v1/mailboxes/${mailboxId}/mcp-connections`,
		),
	addMcpConnection: (
		mailboxId: string,
		input: AddMcpConnectionInput,
	) =>
		post<AddMcpConnectionResult>(
			`/api/v1/mailboxes/${mailboxId}/mcp-connections`,
			input,
		),
	deleteMcpConnection: (mailboxId: string, connectionId: string) =>
		del<{ ok: true }>(
			`/api/v1/mailboxes/${mailboxId}/mcp-connections/${encodeURIComponent(connectionId)}`,
		),
};

// ── L4 MCP connection DTOs (mirror workers/lib/mcp-connections.ts) ──
//
// We re-declare the row shape here (rather than importing from
// workers/lib/...) so the React-side bundle stays free of worker
// imports — the build pipeline already keeps app/* and workers/* in
// separate compilation roots.
export interface McpConnectionDto {
	id: string;
	serverName: string;
	displayName: string | null;
	serverUrl: string;
	transportType: "sse" | "streamable-http" | null;
	addedByUserId: string;
	addedAt: number;
	lastState: "authenticating" | "ready" | "error" | "discovering";
	lastError: string | null;
	enabledTools: readonly string[] | null;
	authType: "oauth" | "bearer";
}

export type AddMcpConnectionInput =
	| {
			authType?: "oauth";
			name: string;
			url: string;
			displayName?: string;
		}
	| {
			authType: "bearer";
			name: string;
			url: string;
			displayName?: string;
			bearerToken: string;
		};

export type AddMcpConnectionResult =
	| { state: "ready"; connection: McpConnectionDto }
	| {
			state: "authenticating";
			connection: McpConnectionDto;
			authUrl: string;
		};

export default api;
