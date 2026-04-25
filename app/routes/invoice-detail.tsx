// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
	ArrowLeftIcon,
	DownloadSimpleIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate, useParams } from "react-router";
import { formatDetailDate } from "shared/dates";
import { InvoicePreview } from "~/components/InvoicePreview";
import { formatBytes, getAttachmentUrl } from "~/lib/utils";
import { useDeleteInvoice, useInvoice } from "~/queries/invoices";
import type { Attachment } from "~/types";

function amt(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	return n.toFixed(2);
}

function ReviewBadges({
	sourceKind,
	needsReview,
}: {
	sourceKind: string | undefined;
	needsReview: boolean | number | undefined;
}) {
	return (
		<div className="flex items-center gap-2">
			<Badge variant={sourceKind === "pdf-ocr" ? "warning" : "neutral"}>
				源：{sourceKind === "pdf-ocr" ? "PDF OCR" : "XML"}
			</Badge>
			{needsReview ? (
				<Badge variant="warning">
					<WarningIcon size={12} weight="fill" />
					待复核
				</Badge>
			) : null}
		</div>
	);
}

/**
 * Build a `parent_attachment_id` → children map and return the forest of
 * root rows (origin=email or source_url set). Each node carries its
 * children for recursive rendering.
 */
interface TreeNode {
	attachment: Attachment;
	children: TreeNode[];
}

function buildAttachmentForest(atts: Attachment[]): TreeNode[] {
	const byId = new Map<string, TreeNode>();
	for (const a of atts) byId.set(a.id, { attachment: a, children: [] });
	const roots: TreeNode[] = [];
	for (const a of atts) {
		const node = byId.get(a.id)!;
		const parentId = a.parent_attachment_id ?? null;
		if (parentId && byId.has(parentId)) {
			byId.get(parentId)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

function AttachmentTree({
	nodes,
	mailboxId,
	emailId,
	authoritativeId,
	depth = 0,
}: {
	nodes: TreeNode[];
	mailboxId: string;
	emailId: string;
	authoritativeId: string;
	depth?: number;
}) {
	return (
		<ul className={depth === 0 ? "space-y-1" : "ml-4 mt-1 space-y-1 border-l border-kumo-muted pl-3"}>
			{nodes.map((n) => (
				<li key={n.attachment.id}>
					<AttachmentRow
						attachment={n.attachment}
						mailboxId={mailboxId}
						emailId={emailId}
						isAuthoritative={n.attachment.id === authoritativeId}
					/>
					{n.children.length > 0 ? (
						<AttachmentTree
							nodes={n.children}
							mailboxId={mailboxId}
							emailId={emailId}
							authoritativeId={authoritativeId}
							depth={depth + 1}
						/>
					) : null}
				</li>
			))}
		</ul>
	);
}

function AttachmentRow({
	attachment,
	mailboxId,
	emailId,
	isAuthoritative,
}: {
	attachment: Attachment;
	mailboxId: string;
	emailId: string;
	isAuthoritative: boolean;
}) {
	const url = getAttachmentUrl(mailboxId, emailId, attachment.id);
	const originLabel = {
		email: "邮件附件",
		unpacked: "容器解包",
		"external-url": "外链下载",
	}[attachment.origin ?? "email"];
	return (
		<div className="flex items-center gap-2 py-0.5 text-xs">
			<FileIcon size={14} weight="regular" className="text-kumo-subtle shrink-0" />
			<a
				href={url}
				className="font-mono text-kumo-default hover:text-kumo-accent truncate"
				target="_blank"
				rel="noopener noreferrer"
			>
				{attachment.filename}
			</a>
			<span className="text-kumo-subtle shrink-0">
				{formatBytes(attachment.size)}
			</span>
			<Badge variant="neutral">{originLabel}</Badge>
			{isAuthoritative ? <Badge variant="success">权威源</Badge> : null}
			<a
				href={url}
				download={attachment.filename}
				className="ml-auto text-kumo-subtle hover:text-kumo-accent shrink-0"
				aria-label="Download"
			>
				<DownloadSimpleIcon size={14} />
			</a>
		</div>
	);
}

export default function InvoiceDetailRoute() {
	const { mailboxId, invoiceId } = useParams<{
		mailboxId: string;
		invoiceId: string;
	}>();
	const navigate = useNavigate();
	const { data, isLoading, error } = useInvoice(mailboxId, invoiceId);
	const deleteInvoice = useDeleteInvoice(mailboxId);

	const handleDelete = async () => {
		if (!data || !invoiceId) return;
		if (
			!window.confirm(
				`删除发票 ${data.invoice.invoice_number}？原始文件仍保留在 R2。`,
			)
		) {
			return;
		}
		try {
			await deleteInvoice.mutateAsync(invoiceId);
			navigate(`/mailbox/${mailboxId}/invoices`);
		} catch (e) {
			window.alert(`删除失败：${(e as Error).message}`);
		}
	};

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Loader />
			</div>
		);
	}

	if (error || !data) {
		return (
			<div className="p-6 text-kumo-subtle">
				Failed to load invoice: {(error as Error | undefined)?.message ?? "unknown error"}
			</div>
		);
	}

	const { invoice, items, related_attachments } = data;
	const forest = buildAttachmentForest(related_attachments);

	return (
		<div className="flex min-h-full flex-col">
			<div className="border-b border-kumo-default bg-kumo-raised px-6 py-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<Link
							to={`/mailbox/${mailboxId}/invoices`}
							className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"
						>
							<ArrowLeftIcon size={14} />
							所有发票
						</Link>
						<h1 className="mt-2 font-mono text-2xl font-semibold text-kumo-default">
							{invoice.invoice_number}
						</h1>
						<p className="mt-1 text-sm text-kumo-subtle">
							{formatDetailDate(invoice.issue_date)} · {invoice.invoice_type ?? "—"}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<ReviewBadges
							sourceKind={invoice.source_kind}
							needsReview={invoice.needs_review}
						/>
						<Link to={`/mailbox/${mailboxId}/emails/inbox`}>
							<Button variant="ghost" size="sm">
								<EnvelopeSimpleIcon size={14} />
								邮件
							</Button>
						</Link>
						<Button variant="ghost" size="sm" onClick={handleDelete}>
							<TrashIcon size={14} />
							删除
						</Button>
					</div>
				</div>
			</div>

			<div className="flex-1 overflow-auto px-6 py-6 space-y-6">
				<section>
					<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-kumo-subtle">
						基本信息
					</h2>
					<dl className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2 text-sm">
						<div className="flex justify-between border-b border-kumo-muted py-1">
							<dt className="text-kumo-subtle">销方名称</dt>
							<dd className="font-medium">{invoice.seller_name ?? "—"}</dd>
						</div>
						<div className="flex justify-between border-b border-kumo-muted py-1">
							<dt className="text-kumo-subtle">销方税号</dt>
							<dd className="font-mono text-xs">{invoice.seller_tax_id ?? "—"}</dd>
						</div>
						<div className="flex justify-between border-b border-kumo-muted py-1">
							<dt className="text-kumo-subtle">购方名称</dt>
							<dd className="font-medium">{invoice.buyer_name ?? "—"}</dd>
						</div>
						<div className="flex justify-between border-b border-kumo-muted py-1">
							<dt className="text-kumo-subtle">购方税号</dt>
							<dd className="font-mono text-xs">{invoice.buyer_tax_id ?? "—"}</dd>
						</div>
						<div className="flex justify-between border-b border-kumo-muted py-1">
							<dt className="text-kumo-subtle">发票代码</dt>
							<dd className="font-mono text-xs">{invoice.invoice_code ?? "—"}</dd>
						</div>
						<div className="flex justify-between border-b border-kumo-muted py-1">
							<dt className="text-kumo-subtle">备注</dt>
							<dd>{invoice.remark ?? "—"}</dd>
						</div>
					</dl>
				</section>

				<section>
					<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-kumo-subtle">
						金额
					</h2>
					<div className="grid grid-cols-3 gap-4 text-sm">
						<div className="rounded border border-kumo-default p-3">
							<div className="text-xs text-kumo-subtle">不含税金额</div>
							<div className="mt-1 font-mono text-lg">{amt(invoice.amount_excl_tax)}</div>
						</div>
						<div className="rounded border border-kumo-default p-3">
							<div className="text-xs text-kumo-subtle">税额</div>
							<div className="mt-1 font-mono text-lg">{amt(invoice.tax_amount)}</div>
						</div>
						<div className="rounded border-2 border-kumo-accent p-3">
							<div className="text-xs text-kumo-subtle">价税合计</div>
							<div className="mt-1 font-mono text-lg font-semibold">
								{amt(invoice.amount_incl_tax)}
							</div>
						</div>
					</div>
				</section>

				<InvoicePreview
					related={related_attachments}
					mailboxId={mailboxId!}
					emailId={invoice.email_id}
					rawXml={invoice.raw_xml}
				/>

				{items.length > 0 ? (
					<section>
						<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-kumo-subtle">
							明细（{items.length}）
						</h2>
						<table className="w-full text-sm">
							<thead className="border-b border-kumo-default text-left text-xs uppercase text-kumo-subtle">
								<tr>
									<th className="py-2 pr-3 font-medium">项目</th>
									<th className="py-2 pr-3 font-medium">规格</th>
									<th className="py-2 pr-3 font-medium">单位</th>
									<th className="py-2 pr-3 font-medium text-right">数量</th>
									<th className="py-2 pr-3 font-medium text-right">单价</th>
									<th className="py-2 pr-3 font-medium text-right">金额</th>
									<th className="py-2 pr-3 font-medium text-right">税率</th>
									<th className="py-2 pr-3 font-medium text-right">税额</th>
								</tr>
							</thead>
							<tbody>
								{items.map((it) => (
									<tr key={it.id} className="border-b border-kumo-muted">
										<td className="py-2 pr-3">{it.item_name ?? "—"}</td>
										<td className="py-2 pr-3">{it.spec ?? "—"}</td>
										<td className="py-2 pr-3">{it.unit ?? "—"}</td>
										<td className="py-2 pr-3 text-right font-mono">
											{it.quantity ?? "—"}
										</td>
										<td className="py-2 pr-3 text-right font-mono">
											{amt(it.unit_price)}
										</td>
										<td className="py-2 pr-3 text-right font-mono">{amt(it.amount)}</td>
										<td className="py-2 pr-3 text-right font-mono">
											{it.tax_rate === null || it.tax_rate === undefined
												? "—"
												: `${(it.tax_rate * 100).toFixed(0)}%`}
										</td>
										<td className="py-2 pr-3 text-right font-mono">
											{amt(it.tax_amount)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				) : null}

				<section>
					<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-kumo-subtle">
						原始文件（{related_attachments.length}）
					</h2>
					<p className="mb-2 text-xs text-kumo-subtle">
						这张发票所在邮件里的所有文件。树形结构表达容器解包关系：邮件附件
						→ ZIP/OFD 解出的子文件 / 下载到的外链文件。「权威源」标签标注本发票字段的来源。
					</p>
					<div className="rounded border border-kumo-default bg-kumo-muted p-3">
						<AttachmentTree
							nodes={forest}
							mailboxId={mailboxId!}
							emailId={invoice.email_id}
							authoritativeId={invoice.attachment_id}
						/>
					</div>
				</section>
			</div>
		</div>
	);
}
