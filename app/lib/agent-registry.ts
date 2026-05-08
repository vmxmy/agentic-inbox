// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { RobotIcon } from "@phosphor-icons/react";

export type AgentId = "email-reply";

export interface AgentTool {
	name: string;
	description: string;
}

export interface AgentDescriptor {
	id: AgentId;
	name: string;
	description: string;
	icon: typeof RobotIcon;
	promptField: "agentSystemPrompt";
	hasModelOverride: boolean;
	hasAutoDraft: boolean;
	tools: AgentTool[];
}

const EMAIL_REPLY_TOOLS: AgentTool[] = [
	{ name: "list_emails", description: "List recent emails in a folder." },
	{ name: "get_email", description: "Read one email by id." },
	{ name: "get_thread", description: "Read a full conversation thread." },
	{ name: "search_emails", description: "Search emails by sender, subject, or body." },
	{ name: "draft_email", description: "Compose a new draft email." },
	{ name: "draft_reply", description: "Draft a reply to a specific email." },
	{ name: "mark_email_read", description: "Mark an email as read or unread." },
	{ name: "move_email", description: "Move an email to another folder." },
	{ name: "discard_draft", description: "Delete a draft." },
];

export const AGENTS: AgentDescriptor[] = [
	{
		id: "email-reply",
		name: "Email Reply Agent",
		description: "Reads incoming mail and drafts replies into Drafts.",
		icon: RobotIcon,
		promptField: "agentSystemPrompt",
		hasModelOverride: true,
		hasAutoDraft: true,
		tools: EMAIL_REPLY_TOOLS,
	},
];
