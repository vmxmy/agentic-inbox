// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Empty, Input, Loader } from "@cloudflare/kumo";
import {
	ArrowLeftIcon,
	DownloadSimpleIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { formatListDate } from "shared/dates";
import {
	useBundle,
	useDeleteBundle,
	useRemoveFromBundle,
	useUpdateBundle,
} from "~/queries/bundles";
import api from "~/services/api";

function formatAmount(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	return `¥${n.toFixed(2)}`;
}

const STATUS_OPTIONS: { id: string; label: string }[] = [
	{ id: "draft", label: "草稿" },
	{ id: "submitted", label: "已提交" },
	{ id: "reimbursed", label: "已报销" },
];

export default function BundleDetailRoute() {
	const { mailboxId, bundleId } = useParams<{
		mailboxId: string;
		bundleId: string;
	}>();
	const navigate = useNavigate();
	const { data, isLoading, error } = useBundle(mailboxId, bundleId);
	const updateBundle = useUpdateBundle(mailboxId, bundleId);
	const removeInvoice = useRemoveFromBundle(mailboxId, bundleId);
	const deleteBundle = useDeleteBundle(mailboxId);

	const [name, setName] = useState("");
	const [note, setNote] = useState("");

	useEffect(() => {
		if (data?.bundle) {
			setName(data.bundle.name);
			setNote(data.bundle.note ?? "");
		}
	}, [data?.bundle]);

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
				加载失败：{(error as Error | undefined)?.message ?? "unknown error"}
			</div>
		);
	}

	const { bundle, invoices } = data;
	const totalAmount = invoices.reduce(
		(s, inv) => s + (inv.amount_incl_tax ?? 0),
		0,
	);

	const handleSaveHeader = async () => {
		const trimmedName = name.trim();
		if (!trimmedName) {
			window.alert("名称不能为空");
			return;
		}
		try {
			await updateBundle.mutateAsync({
				name: trimmedName,
				note: note.trim() || null,
			});
		} catch (e) {
			window.alert(`保存失败：${(e as Error).message}`);
		}
	};

	const handleStatusChange = async (status: string) => {
		try {
			await updateBundle.mutateAsync({ status });
		} catch (e) {
			window.alert(`状态更新失败：${(e as Error).message}`);
		}
	};

	const handleRemove = async (invoiceId: string, invoiceNumber: string) => {
		if (!window.confirm(`从报销单移出 ${invoiceNumber}？发票本身不会被删除。`)) {
			return;
		}
		try {
			await removeInvoice.mutateAsync(invoiceId);
		} catch (e) {
			window.alert(`移出失败：${(e as Error).message}`);
		}
	};

	const handleDeleteBundle = async () => {
		if (!bundleId) return;
		if (!window.confirm(`删除报销单「${bundle.name}」？发票本身不会被删除。`)) {
			return;
		}
		try {
			await deleteBundle.mutateAsync(bundleId);
			navigate(`/mailbox/${mailboxId}/bundles`);
		} catch (e) {
			window.alert(`删除失败：${(e as Error).message}`);
		}
	};

	const headerDirty =
		name.trim() !== bundle.name || (note.trim() || null) !== (bundle.note ?? null);

	return (
		<div className="flex min-h-full flex-col">
			<div className="border-b border-kumo-default bg-kumo-raised px-6 py-4">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1 min-w-0">
						<Link
							to={`/mailbox/${mailboxId}/bundles`}
							className="inline-flex items-center gap-1 text-sm text-kumo-subtle hover:text-kumo-default"
						>
							<ArrowLeftIcon size={14} />
							所有报销单
						</Link>
						<div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
							<Input
								label="名称"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
							<Input
								label="备注"
								value={note}
								onChange={(e) => setNote(e.target.value)}
							/>
						</div>
						{headerDirty ? (
							<div className="mt-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={handleSaveHeader}
									disabled={updateBundle.isPending}
								>
									保存修改
								</Button>
							</div>
						) : null}
					</div>
					<div className="flex flex-col items-end gap-2">
						<div className="flex items-center gap-2">
							{STATUS_OPTIONS.map((opt) => (
								<Button
									key={opt.id}
									variant={bundle.status === opt.id ? "primary" : "ghost"}
									size="sm"
									onClick={() => handleStatusChange(opt.id)}
									disabled={updateBundle.isPending}
								>
									{opt.label}
								</Button>
							))}
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant="primary"
								disabled={!mailboxId || !bundleId || invoices.length === 0}
								onClick={() => {
									if (!mailboxId || !bundleId) return;
									window.location.href = api.bundleZipUrl(mailboxId, bundleId);
								}}
							>
								<DownloadSimpleIcon size={14} weight="regular" />
								下载 ZIP
							</Button>
							<Button variant="ghost" onClick={handleDeleteBundle}>
								<TrashIcon size={14} />
								删除
							</Button>
						</div>
					</div>
				</div>
				<div className="mt-3 flex items-center gap-4 text-sm text-kumo-subtle">
					<span>
						创建于 {formatListDate(bundle.created_at)}
					</span>
					<span>·</span>
					<span>{invoices.length} 张发票</span>
					<span>·</span>
					<span>
						合计 <span className="font-mono font-semibold text-kumo-default">{formatAmount(totalAmount)}</span>
					</span>
				</div>
			</div>

			<div className="flex-1 overflow-auto">
				{invoices.length === 0 ? (
					<Empty
						title="还没有发票"
						description="去发票列表勾选发票后点击「加入报销单」。"
					/>
				) : (
					<table className="w-full text-sm">
						<thead className="sticky top-0 border-b border-kumo-default bg-kumo-raised text-left text-xs uppercase text-kumo-subtle">
							<tr>
								<th className="px-6 py-2 font-medium">开票日期</th>
								<th className="px-3 py-2 font-medium">发票号码</th>
								<th className="px-3 py-2 font-medium">销方</th>
								<th className="px-3 py-2 font-medium">购方</th>
								<th className="px-3 py-2 font-medium text-right">价税合计</th>
								<th className="px-3 py-2 font-medium">源</th>
								<th className="px-3 py-2 font-medium"></th>
							</tr>
						</thead>
						<tbody>
							{invoices.map((inv) => (
								<tr
									key={inv.id}
									className="border-b border-kumo-muted hover:bg-kumo-muted"
								>
									<td className="px-6 py-2 whitespace-nowrap">
										<Link
											to={`/mailbox/${mailboxId}/invoices/${inv.id}`}
											className="text-kumo-default hover:text-kumo-accent"
										>
											{formatListDate(inv.issue_date)}
										</Link>
									</td>
									<td className="px-3 py-2 font-mono text-xs">
										<Link
											to={`/mailbox/${mailboxId}/invoices/${inv.id}`}
											className="text-kumo-default hover:text-kumo-accent"
										>
											{inv.invoice_number}
										</Link>
									</td>
									<td className="px-3 py-2 max-w-[200px] truncate" title={inv.seller_name ?? ""}>
										{inv.seller_name ?? "—"}
									</td>
									<td className="px-3 py-2 max-w-[200px] truncate" title={inv.buyer_name ?? ""}>
										{inv.buyer_name ?? "—"}
									</td>
									<td className="px-3 py-2 text-right font-mono font-semibold">
										{formatAmount(inv.amount_incl_tax)}
									</td>
									<td className="px-3 py-2">
										<div className="flex items-center gap-1">
											<Badge variant={inv.source_kind === "pdf-ocr" ? "warning" : "neutral"}>
												{inv.source_kind === "pdf-ocr" ? "PDF OCR" : "XML"}
											</Badge>
											{inv.needs_review ? (
												<Badge variant="warning">
													<WarningIcon size={12} weight="fill" />
													待复核
												</Badge>
											) : null}
										</div>
									</td>
									<td className="px-3 py-2 text-right">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleRemove(inv.id, inv.invoice_number)}
											aria-label="Remove from bundle"
										>
											<TrashIcon size={14} />
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
