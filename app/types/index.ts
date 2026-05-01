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
	userOwnedInbox?: UserOwnedInboxMetadata;
}

export interface UserOwnedInboxMetadata {
	version: 1;
	ownerEmail: string;
	username: string;
	subname: string;
	rootDomain: string;
	address: string;
}

export interface InboxNamespace {
	email: string;
	username: string;
	rootDomain: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	displayName?: string;
	username?: string;
	subname?: string;
	rootDomain?: string;
	userOwnedInbox?: UserOwnedInboxMetadata | null;
	settings?: MailboxSettings;
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
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

// -- Inbox agent configuration (Phase 2 control plane) ---------------

export const INBOX_AGENT_CONFIG_SCHEMA_VERSION = 1 as const;

export interface AgentModelOption {
	id: string;
	displayName: string;
	tier: "default" | "workers-ai" | "openai-compatible" | "deprecated";
	description?: string;
}

export interface AgentToolCatalogEntry {
	id: string;
	displayName: string;
	description: string;
	surfaces: string[];
	permissions: {
		mutates: boolean;
		sendsMail: boolean;
		global: boolean;
		readsInbox: boolean;
	};
	editable: boolean;
	lockReason?: string;
	defaultEnabled: boolean;
}

export interface AgentSafetyPolicy {
	version: 1;
	promptInjectionScanEnabled: boolean;
	threadContextScanEnabled: boolean;
	draftVerificationEnabled: boolean;
	safetyModelId: string | null;
	level: "off" | "standard" | "strict";
}

export interface AgentSafetyLevelOption {
	id: AgentSafetyPolicy["level"];
	displayName: string;
	description: string;
}

export interface InboxAgentConfigOptions {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	models: AgentModelOption[];
	defaultModelId: string;
	tools: AgentToolCatalogEntry[];
	defaultEnabledToolIds: string[];
	safety: {
		defaults: AgentSafetyPolicy;
		levels: AgentSafetyLevelOption[];
	};
	defaults: {
		agentDisplayName: string;
		systemPrompt: string;
		automation: { inboundAutoDraftEnabled: boolean };
	};
	lockedToolIds: string[];
}

export interface InboxAgentConfigResponse {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	revision: string;
	inboxId: string;
	canonicalAddress: string;
	displayName: string;
	agent: {
		profileId: string;
		displayName: string;
		description?: string;
		systemPrompt: string;
		modelId: string;
		modelDeprecated: boolean;
		automation: { inboundAutoDraftEnabled: boolean };
	};
	tools: {
		enabledToolIds: string[];
		usingDefaultPreset: boolean;
	};
	safety: AgentSafetyPolicy;
}

export interface InboxAgentConfigPatch {
	schemaVersion: typeof INBOX_AGENT_CONFIG_SCHEMA_VERSION;
	expectedRevision: string;
	agent?: {
		displayName?: string;
		description?: string;
		systemPrompt?: string;
		modelId?: string;
		automation?: { inboundAutoDraftEnabled?: boolean };
	};
	tools?: { enabledToolIds?: string[] };
	safety?: Partial<AgentSafetyPolicy>;
}
