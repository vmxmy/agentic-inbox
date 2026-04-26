// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Tooltip } from "@cloudflare/kumo";
import { ReceiptIcon, WarningIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import type { Invoice } from "~/types";

const WARNING_BADGE_CLASS_NAME =
	"border border-kumo-warning/30 bg-kumo-warning/10 text-kumo-warning";
const INFO_BADGE_CLASS_NAME =
	"border border-kumo-info/30 bg-kumo-info/10 text-kumo-info";

interface CompactProps {
	mailboxId: string;
	invoices: Invoice[];
	/** Stop row-click propagation when rendered inside an email list row. */
	stopPropagation?: boolean;
}

/**
 * Small inline badge for email list rows. Shows "📄 发票 ×N" with warning
 * variant when any listed invoice carries `needs_review=true`. Clicking
 * navigates to the single invoice (when N=1) or the filtered list (N>1).
 */
export function InvoiceBadgeCompact({
	mailboxId,
	invoices,
	stopPropagation = true,
}: CompactProps) {
	if (invoices.length === 0) return null;
	const anyNeedsReview = invoices.some((i) => Boolean(i.needs_review));
	const to =
		invoices.length === 1
			? `/mailbox/${mailboxId}/invoices/${invoices[0].id}`
			: `/mailbox/${mailboxId}/invoices`;
	const label = invoices.length === 1 ? "发票" : `发票 ×${invoices.length}`;
	const tooltip = anyNeedsReview
		? "已提取，但有字段需要人工复核"
		: "已提取发票，点击查看";

	return (
		<Tooltip content={tooltip} asChild>
			<Link
				to={to}
				className="shrink-0"
				onClick={(e) => {
					if (stopPropagation) e.stopPropagation();
				}}
			>
				<Badge
					variant="outline"
					className={anyNeedsReview ? WARNING_BADGE_CLASS_NAME : INFO_BADGE_CLASS_NAME}
				>
					<ReceiptIcon size={11} weight="regular" />
					{label}
					{anyNeedsReview ? <WarningIcon size={10} weight="fill" /> : null}
				</Badge>
			</Link>
		</Tooltip>
	);
}

interface DetailCardProps {
	mailboxId: string;
	invoices: Invoice[];
}

/**
 * Full-width card rendered above an email's body when the email has one
 * or more extracted invoices. Gives the reader at-a-glance 发票 metadata
 * with a jump-link to the full detail page. Stacks for multi-invoice
 * emails (rare but possible: one email with several attached XMLs).
 */
export function InvoiceBadgeCard({ mailboxId, invoices }: DetailCardProps) {
	if (invoices.length === 0) return null;

	return (
		<div className="space-y-2">
			{invoices.map((inv) => (
				<Link
					key={inv.id}
					to={`/mailbox/${mailboxId}/invoices/${inv.id}`}
					className="flex items-center gap-3 rounded border border-kumo-default bg-kumo-raised px-3 py-2 text-sm hover:border-kumo-accent transition-colors"
				>
					<ReceiptIcon size={18} weight="regular" className="shrink-0 text-kumo-accent" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-mono text-xs text-kumo-default">
								{inv.invoice_number}
							</span>
							{inv.source_kind === "pdf-ocr" ? (
								<Badge variant="outline" className={WARNING_BADGE_CLASS_NAME}>PDF OCR</Badge>
							) : null}
							{inv.is_voided ? (
								<Badge variant="secondary">已红冲</Badge>
							) : null}
							{inv.original_invoice_number ? (
								<Badge variant="destructive">红字</Badge>
							) : null}
							{inv.needs_review ? (
								<Badge variant="outline" className={WARNING_BADGE_CLASS_NAME}>
									<WarningIcon size={10} weight="fill" />
									待复核
								</Badge>
							) : null}
						</div>
						<div className="mt-0.5 text-xs text-kumo-subtle truncate">
							{inv.issue_date} · {inv.seller_name ?? "—"} · ¥
							{inv.amount_incl_tax?.toFixed(2) ?? "—"}
						</div>
					</div>
					<span className="shrink-0 text-xs text-kumo-subtle">查看 →</span>
				</Link>
			))}
		</div>
	);
}
