// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
	invoiceAgentSystemPrompt?: string;
}

export interface TeamMailboxInfo {
	id: string;
	slug: string;
	displayName: string;
	kind: "team" | "team_user";
	userSlug: string | null;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
	team?: TeamMailboxInfo;
}

export interface Team {
	id: string;
	slug: string;
	displayName: string;
	primaryAddress: string;
	createdByUserId: string | null;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
	mailbox?: Mailbox;
}

export interface TeamUser {
	id: string;
	teamId: string;
	userId: string;
	slug: string;
	mailboxAddress: string;
	email?: string;
	displayName?: string | null;
	createdByUserId: string | null;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
	user?: {
		id: string;
		email: string;
		displayName: string | null;
		role: "user" | "admin";
		emailVerifiedAt?: number | null;
		createdAt?: number;
	};
	team?: Team;
	mailbox?: Mailbox;
	setupUrl?: string;
	setupExpiresAt?: number;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
	email_id?: string;
	origin?: "email" | "unpacked" | "external-url" | "manual-upload";
	source_url?: string | null;
	parent_attachment_id?: string | null;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}
