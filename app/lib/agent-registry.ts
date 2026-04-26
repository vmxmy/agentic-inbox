// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ReceiptIcon, RobotIcon } from "@phosphor-icons/react";

export type AgentId = "email-reply" | "invoice";

export interface AgentTool {
	name: string;
	description: string;
}

export interface AgentDescriptor {
	id: AgentId;
	name: string;
	description: string;
	icon: typeof RobotIcon;
	promptField: "agentSystemPrompt" | "invoiceAgentSystemPrompt";
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

const INVOICE_TOOLS: AgentTool[] = [
	{ name: "process_email_invoices", description: "Re-run extraction on a specific email's attachments." },
	{ name: "list_invoices", description: "List invoices with filters (sender, date, currency)." },
	{ name: "get_invoice", description: "Fetch one invoice with line items." },
	{ name: "list_bundles", description: "List reimbursement bundles." },
	{ name: "get_bundle", description: "Read one bundle and its members." },
	{ name: "create_bundle", description: "Create a new reimbursement bundle." },
	{ name: "update_bundle", description: "Rename or change a bundle's status." },
	{ name: "delete_bundle", description: "Delete a bundle (invoices stay)." },
	{ name: "add_invoice_to_bundle", description: "Attach an invoice to a bundle." },
	{ name: "remove_invoice_from_bundle", description: "Detach an invoice from a bundle." },
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
	{
		id: "invoice",
		name: "Invoice Agent",
		description: "Searches invoices and manages reimbursement bundles.",
		icon: ReceiptIcon,
		promptField: "invoiceAgentSystemPrompt",
		hasModelOverride: false,
		hasAutoDraft: false,
		tools: INVOICE_TOOLS,
	},
];
