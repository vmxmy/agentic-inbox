// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent registry — single source of truth for which chat agents exist, their
 * binding names, tool labels, suggested prompts, and per-agent extension hooks
 * (e.g. EmailAgent's "Edit & send in composer" button when a draft_reply was
 * called).
 *
 * Hardcoded for now. If a third agent appears, lift this into a backend
 * endpoint (`GET /api/v1/agents`) so the UI can stay in sync without a
 * frontend deploy.
 */

import { Button } from "@cloudflare/kumo";
import {
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	CheckCircleIcon,
	EnvelopeSimpleIcon,
	EyeIcon,
	FoldersIcon,
	MagnifyingGlassIcon,
	MinusIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PlusIcon,
	ReceiptIcon,
	RobotIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { getToolNameFromPart, type ToolLabelsMap } from "./MessageBubble";

export type AgentId = "email" | "invoice";

/**
 * Host context handed to per-agent renderActions callbacks. Lets the registry
 * stay declarative — UnifiedAgentPanel calls hooks and threads the live state
 * + callbacks down so the registry doesn't need to import any host modules.
 */
export interface AgentActionContext {
	mailboxId: string;
	isStreaming: boolean;
	sendMessage: (msg: { text: string }) => void;
	startCompose: (opts: {
		mode: "new" | "reply" | "reply-all" | "forward";
		originalEmail: null;
		draftEmail: {
			id: string;
			subject: string;
			sender: string;
			recipient: string;
			date: string;
			read: boolean;
			starred: boolean;
			body: string;
		};
	}) => void;
}

export interface AgentDef {
	id: AgentId;
	/** DurableObject class name — must match the binding in wrangler.jsonc. */
	bindingName: "EmailAgent" | "InvoiceAgent";
	/** Short label used in chips and tabs (e.g. "email"). */
	label: string;
	/** Long display name (e.g. "Email Agent") shown in headers. */
	fullName: string;
	/** One-line description shown in the @-mention dropdown and empty state. */
	description: string;
	/** Small avatar icon, used in chips, message bubbles, and picker rows. */
	icon: ReactNode;
	/** Tool name → { label, icon } map for tool-call badges. */
	toolLabels: ToolLabelsMap;
	/** Suggested prompts shown in the empty state when this agent is default. */
	suggestedPrompts: string[];
	/**
	 * Optional per-message footer renderer (e.g. EmailAgent's draft "Edit &
	 * send in composer" button). Returning null/undefined skips it.
	 */
	renderActions?: (msg: UIMessage, ctx: AgentActionContext) => ReactNode;
}

const EMAIL_TOOL_LABELS: ToolLabelsMap = {
	list_emails: {
		label: "Fetching emails",
		icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
	},
	get_email: {
		label: "Reading email",
		icon: <EyeIcon size={14} weight="bold" />,
	},
	get_thread: {
		label: "Loading thread",
		icon: <ArrowBendUpLeftIcon size={14} weight="bold" />,
	},
	search_emails: {
		label: "Searching",
		icon: <MagnifyingGlassIcon size={14} weight="bold" />,
	},
	draft_email: {
		label: "Drafting email",
		icon: <PaperPlaneTiltIcon size={14} weight="bold" />,
	},
	draft_reply: {
		label: "Drafting reply",
		icon: <PaperPlaneTiltIcon size={14} weight="bold" />,
	},
	discard_draft: {
		label: "Discarding draft",
		icon: <TrashIcon size={14} weight="bold" />,
	},
	mark_email_read: {
		label: "Updating status",
		icon: <CheckCircleIcon size={14} weight="bold" />,
	},
	move_email: {
		label: "Moving email",
		icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
	},
};

const INVOICE_TOOL_LABELS: ToolLabelsMap = {
	process_email_invoices: {
		label: "Re-extracting invoices",
		icon: <ArrowsClockwiseIcon size={14} weight="bold" />,
	},
	list_invoices: {
		label: "Searching invoices",
		icon: <MagnifyingGlassIcon size={14} weight="bold" />,
	},
	get_invoice: {
		label: "Reading invoice",
		icon: <ReceiptIcon size={14} weight="bold" />,
	},
	list_bundles: {
		label: "Listing bundles",
		icon: <FoldersIcon size={14} weight="bold" />,
	},
	get_bundle: {
		label: "Reading bundle",
		icon: <EyeIcon size={14} weight="bold" />,
	},
	create_bundle: {
		label: "Creating bundle",
		icon: <PlusIcon size={14} weight="bold" />,
	},
	update_bundle: {
		label: "Updating bundle",
		icon: <PencilSimpleIcon size={14} weight="bold" />,
	},
	delete_bundle: {
		label: "Deleting bundle",
		icon: <TrashIcon size={14} weight="bold" />,
	},
	add_invoice_to_bundle: {
		label: "Adding to bundle",
		icon: <PlusIcon size={14} weight="bold" />,
	},
	remove_invoice_from_bundle: {
		label: "Removing from bundle",
		icon: <MinusIcon size={14} weight="bold" />,
	},
};

function hasDraftReplyTool(message: UIMessage): boolean {
	return message.parts.some(
		(part) => getToolNameFromPart(part) === "draft_reply",
	);
}

function renderEmailDraftActions(
	msg: UIMessage,
	ctx: AgentActionContext,
): ReactNode {
	if (!hasDraftReplyTool(msg)) return null;
	let draftData: {
		to?: string;
		subject?: string;
		body?: string;
		id?: string;
	} | null = null;
	for (const part of msg.parts) {
		if ((part as any).toolName === "draft_reply" && (part as any).result) {
			draftData = (part as any).result;
			break;
		}
	}
	const onEdit = () => {
		if (draftData) {
			ctx.startCompose({
				mode: "reply",
				originalEmail: null,
				draftEmail: {
					id: draftData.id || "",
					subject: draftData.subject || "",
					sender: ctx.mailboxId,
					recipient: draftData.to || "",
					date: new Date().toISOString(),
					read: true,
					starred: false,
					body: draftData.body || "",
				},
			});
		} else {
			ctx.sendMessage({
				text: "Let me edit this draft first. Show me what you have so I can modify it.",
			});
		}
	};
	return (
		<div className="flex gap-1.5 mt-1">
			<Button
				variant="primary"
				size="sm"
				icon={<PencilSimpleIcon size={14} />}
				onClick={onEdit}
				disabled={ctx.isStreaming}
			>
				Edit & send in composer
			</Button>
		</div>
	);
}

export const AGENTS: readonly AgentDef[] = [
	{
		id: "email",
		bindingName: "EmailAgent",
		label: "email",
		fullName: "Email Agent",
		description: "Draft replies, search inbox, manage threads",
		icon: <RobotIcon size={14} weight="bold" />,
		toolLabels: EMAIL_TOOL_LABELS,
		suggestedPrompts: [
			"Show me the latest inbox emails",
			"Any unread emails?",
			"Draft a response to the latest email",
		],
		renderActions: renderEmailDraftActions,
	},
	{
		id: "invoice",
		bindingName: "InvoiceAgent",
		label: "invoice",
		fullName: "Invoice Agent",
		description: "Find invoices, manage reimbursement bundles",
		icon: <ReceiptIcon size={14} weight="bold" />,
		toolLabels: INVOICE_TOOL_LABELS,
		suggestedPrompts: [
			"Show the latest invoices",
			"List reimbursement bundles",
			"How many invoices need review?",
		],
	},
] as const;

export function getAgent(id: AgentId): AgentDef {
	const found = AGENTS.find((a) => a.id === id);
	if (!found) throw new Error(`Unknown agent id: ${id}`);
	return found;
}

/** Default agent on first session. */
export const DEFAULT_AGENT_ID: AgentId = "email";

/** sessionStorage key for remembering the last-used agent. */
export const LAST_USED_AGENT_KEY = "agentic-inbox:last-agent";
