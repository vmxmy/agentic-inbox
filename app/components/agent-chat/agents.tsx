// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-agent registry consumed by `UnifiedAgentPanel`. Keeps every agent's
 * display metadata (label, icons, suggested prompts) and tool-label map in
 * one place so adding a future agent is "append a record" rather than
 * "fork another panel file".
 *
 * Adding an agent requires:
 *   1. Backend DO + binding (see workers/invoice-agent for a worked example)
 *   2. A new entry below + add to AGENTS / AGENTS_BY_ID / AgentId union
 *   3. Optional per-agent action footer (UnifiedAgentPanel branches by id)
 *
 * No backend endpoint is consulted — the registry is intentionally hardcoded
 * client-side. If a third agent appears, consider promoting this to a
 * `GET /api/v1/agents` response so the runtime list stays in sync without
 * a frontend rebuild.
 */

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
import type { ToolLabelsMap } from "./MessageBubble";

export type AgentId = "email" | "invoice" | "router";

export interface AgentDef {
	id: AgentId;
	/** DO class name — must match `wrangler.jsonc` `durable_objects.bindings`
	 *  and the `useAgent({ agent: "..." })` hook argument. */
	bindingName: "EmailAgent" | "InvoiceAgent" | "RouterAgent";
	/** Short identifier shown in the @ dropdown, chip, and message header. */
	label: string;
	/** One-line description shown beside the label in the @ dropdown
	 *  and on the empty-state card. */
	description: string;
	/** Compact avatar icon (12-14px) for chat bubbles + chip. */
	icon: ReactNode;
	/** Larger duotone version for empty-state cards (24px). */
	largeIcon: ReactNode;
	/** Tool name → { label, icon } for the streaming tool-call badges. */
	toolLabels: ToolLabelsMap;
	/** Suggested prompts on the empty-state card; click to send to this agent. */
	suggestedPrompts: string[];
}

const EMAIL: AgentDef = {
	id: "email",
	bindingName: "EmailAgent",
	label: "email",
	description: "Draft replies, search inbox, manage emails",
	icon: <RobotIcon size={12} weight="bold" />,
	largeIcon: (
		<RobotIcon size={24} weight="duotone" className="text-kumo-brand" />
	),
	toolLabels: {
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
	},
	suggestedPrompts: [
		"Show me the latest inbox emails",
		"Any unread emails?",
		"Draft a response to the latest email",
	],
};

const INVOICE: AgentDef = {
	id: "invoice",
	bindingName: "InvoiceAgent",
	label: "invoice",
	description: "Find invoices, manage reimbursement bundles",
	icon: <ReceiptIcon size={12} weight="bold" />,
	largeIcon: (
		<ReceiptIcon size={24} weight="duotone" className="text-kumo-brand" />
	),
	toolLabels: {
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
	},
	suggestedPrompts: [
		"Show the latest invoices",
		"List reimbursement bundles",
		"How many invoices need review?",
	],
};

const ROUTER: AgentDef = {
	id: "router",
	bindingName: "RouterAgent",
	label: "assistant",
	description: "Routes your request to the right agent",
	icon: <RobotIcon size={12} weight="bold" />,
	largeIcon: (
		<RobotIcon size={24} weight="duotone" className="text-kumo-brand" />
	),
	toolLabels: {
		ask_email_agent: {
			label: "Asking email agent",
			icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
		},
		ask_invoice_agent: {
			label: "Asking invoice agent",
			icon: <ReceiptIcon size={14} weight="bold" />,
		},
	},
	suggestedPrompts: [
		"Show me the latest inbox emails",
		"List my reimbursement bundles",
		"Draft a reply to the latest email",
	],
};

export const AGENTS: AgentDef[] = [EMAIL, INVOICE];

export const AGENTS_BY_ID: Record<AgentId, AgentDef> = {
	email: EMAIL,
	invoice: INVOICE,
	router: ROUTER,
};

export const DEFAULT_AGENT_ID: AgentId = "email";

export function isAgentId(s: string): s is AgentId {
	return s === "email" || s === "invoice" || s === "router";
}

const SESSION_KEY_PREFIX = "agentic-inbox:lastAgent";

function sessionKey(mailboxId?: string | null): string {
	return mailboxId
		? `${SESSION_KEY_PREFIX}:${mailboxId}`
		: SESSION_KEY_PREFIX;
}

/**
 * Read the last-used agent id from sessionStorage for the given mailbox,
 * falling back to the default. Used to pick the routing target when the
 * user sends without an explicit @-mention. Mailbox-scoped so switching
 * mailboxes doesn't carry over the previous mailbox's preference.
 */
export function readLastAgent(mailboxId?: string | null): AgentId {
	if (typeof window === "undefined") return DEFAULT_AGENT_ID;
	try {
		const raw = window.sessionStorage.getItem(sessionKey(mailboxId));
		return raw && isAgentId(raw) ? raw : DEFAULT_AGENT_ID;
	} catch {
		return DEFAULT_AGENT_ID;
	}
}

export function writeLastAgent(
	id: AgentId,
	mailboxId?: string | null,
): void {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(sessionKey(mailboxId), id);
	} catch {
		// ignore (private browsing / quota exceeded)
	}
}
