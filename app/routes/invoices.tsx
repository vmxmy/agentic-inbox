// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Empty, Input, Loader, Pagination } from "@cloudflare/kumo";
import {
	DownloadSimpleIcon,
	PackageIcon,
	ReceiptIcon,
	TrashIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { formatListDate } from "shared/dates";
import {
	useAddToBundle,
	useBundles,
	useCreateBundle,
} from "~/queries/bundles";
import { useDeleteInvoice, useInvoices } from "~/queries/invoices";
import api from "~/services/api";
import type { InvoiceFilters } from "~/types";

const PAGE_SIZE = 25;
const WARNING_BADGE_CLASS_NAME =
	"border border-kumo-warning/30 bg-kumo-warning/10 text-kumo-warning";

function formatAmount(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	return `¥${n.toFixed(2)}`;
}

export default function InvoicesRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [page, setPage] = useState(1);
	const [reviewOnly, setReviewOnly] = useState(false);
	const [hideVoided, setHideVoided] = useState(true);
	const [sellerContains, setSellerContains] = useState("");
	const [buyerContains, setBuyerContains] = useState("");
	const [itemContains, setItemContains] = useState("");
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [minAmount, setMinAmount] = useState("");
	const [maxAmount, setMaxAmount] = useState("");

	const filters = useMemo<InvoiceFilters>(
		() => ({
			page,
			limit: PAGE_SIZE,
			sellerContains: sellerContains.trim() || undefined,
			buyerContains: buyerContains.trim() || undefined,
			dateFrom: dateFrom || undefined,
			dateTo: dateTo || undefined,
			minAmount: minAmount ? Number(minAmount) : undefined,
			maxAmount: maxAmount ? Number(maxAmount) : undefined,
			itemContains: itemContains.trim() || undefined,
		}),
		[page, sellerContains, buyerContains, dateFrom, dateTo, minAmount, maxAmount, itemContains],
	);

	const { data, isLoading, isFetching } = useInvoices(mailboxId, filters);
	const deleteInvoice = useDeleteInvoice(mailboxId);

	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [addOpen, setAddOpen] = useState(false);
	const { data: bundles = [] } = useBundles(mailboxId);
	const createBundle = useCreateBundle(mailboxId);
	const addToBundle = useAddToBundle(mailboxId);
	const [chosenBundleId, setChosenBundleId] = useState<string>("");
	const [newBundleName, setNewBundleName] = useState("");
	const [addPending, setAddPending] = useState(false);

	const toggleSelect = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const clearSelection = () => setSelected(new Set());

	// Client-side filters for needs_review and hideVoided — backend doesn't
	// index these yet, so filtering works against the current page. With a
	// typical invoice volume (tens per month) this is fine.
	const rawInvoices = data?.invoices ?? [];
	const invoices = rawInvoices.filter((inv) => {
		if (reviewOnly && !inv.needs_review) return false;
		if (hideVoided && inv.is_voided) return false;
		return true;
	});
	const totalCount = data?.totalCount ?? 0;
	const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

	const resetFilters = () => {
		setSellerContains("");
		setBuyerContains("");
		setDateFrom("");
		setDateTo("");
		setMinAmount("");
		setMaxAmount("");
		setItemContains("");
		setReviewOnly(false);
		setHideVoided(true);
		setPage(1);
	};

	const allSelectableIds = useMemo(
		() =>
			(data?.invoices ?? [])
				.filter(
					(inv) => !inv.is_voided && !inv.original_invoice_number,
				)
				.map((inv) => inv.id),
		[data?.invoices],
	);
	const allSelected =
		allSelectableIds.length > 0 &&
		allSelectableIds.every((id) => selected.has(id));
	const someSelected = allSelectableIds.some((id) => selected.has(id));

	const toggleSelectAll = () => {
		if (allSelected) {
			setSelected((prev) => {
				const next = new Set(prev);
				for (const id of allSelectableIds) next.delete(id);
				return next;
			});
		} else {
			setSelected((prev) => {
				const next = new Set(prev);
				for (const id of allSelectableIds) next.add(id);
				return next;
			});
		}
	};

	const handleAddToBundle = async () => {
		if (!mailboxId || selected.size === 0) return;
		setAddPending(true);
		try {
			let targetId = chosenBundleId;
			if (!targetId) {
				const trimmed = newBundleName.trim();
				if (!trimmed) {
					window.alert("Please select a bundle or enter a new bundle name");
					setAddPending(false);
					return;
				}
				const created = await createBundle.mutateAsync({
					name: trimmed,
					note: null,
				});
				targetId = created.id;
			}
			let success = 0;
			const failures: string[] = [];
			for (const invoiceId of selected) {
				try {
					await addToBundle.mutateAsync({
						bundleId: targetId,
						invoiceId,
					});
					success += 1;
				} catch (err) {
					failures.push(
						`${invoiceId.slice(0, 8)}: ${(err as Error).message}`,
					);
				}
			}
			if (failures.length === 0) {
				window.alert(`Added ${success} invoice${success !== 1 ? "s" : ""} to bundle`);
			} else {
				window.alert(
					`Added ${success}, ${failures.length} failed:\n${failures.join("\n")}`,
				);
			}
			setAddOpen(false);
			setChosenBundleId("");
			setNewBundleName("");
			clearSelection();
		} finally {
			setAddPending(false);
		}
	};

	const handleDelete = async (invoiceId: string, invoiceNumber: string) => {
		if (
			!window.confirm(
				`Delete invoice ${invoiceNumber}? The original file will remain in R2.`,
			)
		) {
			return;
		}
		try {
			await deleteInvoice.mutateAsync(invoiceId);
		} catch (e) {
			window.alert(`Failed to delete: ${(e as Error).message}`);
		}
	};

	return (
		<div className="flex min-h-full flex-col">
			<div className="border-b border-kumo-default bg-kumo-raised px-6 py-4">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-xl font-semibold text-kumo-default flex items-center gap-2">
							<ReceiptIcon size={22} weight="regular" />
							Invoices
						</h1>
						<p className="mt-1 text-sm text-kumo-subtle">
							{totalCount} invoice{totalCount !== 1 ? "s" : ""} · Each linked to its authoritative original file
						</p>
					</div>
					<div className="flex items-center gap-2">
						{selected.size > 0 ? (
							<>
								<span className="text-sm text-kumo-subtle">
									{selected.size} selected
								</span>
								<Button
									variant="primary"
									onClick={() => setAddOpen(true)}
								>
									<PackageIcon size={14} weight="regular" />
									Add to Bundle
								</Button>
								<Button variant="ghost" onClick={clearSelection}>
									Deselect
								</Button>
							</>
						) : null}
						<label className="inline-flex items-center gap-2 text-sm text-kumo-default">
							<input
								type="checkbox"
								className="h-4 w-4"
								checked={hideVoided}
								onChange={(e) => {
									setHideVoided(e.target.checked);
									setPage(1);
								}}
							/>
							Hide voided
						</label>
						<label className="inline-flex items-center gap-2 text-sm text-kumo-default">
							<input
								type="checkbox"
								className="h-4 w-4"
								checked={reviewOnly}
								onChange={(e) => {
									setReviewOnly(e.target.checked);
									setPage(1);
								}}
							/>
							Needs review only
						</label>
						<Button variant="ghost" onClick={resetFilters}>
							Clear filters
						</Button>
						<Button
							variant="secondary"
							disabled={!mailboxId || totalCount === 0}
							onClick={() => {
								if (!mailboxId) return;
								// Strip pagination — export covers the entire filtered set.
								const { page: _p, limit: _l, ...exportFilters } = filters;
								const url = api.invoicesExportUrl(mailboxId, exportFilters);
								window.location.href = url;
							}}
						>
							<DownloadSimpleIcon size={14} weight="regular" />
							Export CSV
						</Button>
					</div>
				</div>

				<div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-7">
					<Input
						placeholder="Seller name…"
						value={sellerContains}
						onChange={(e) => {
							setSellerContains(e.target.value);
							setPage(1);
						}}
					/>
					<Input
						placeholder="Buyer name…"
						value={buyerContains}
						onChange={(e) => {
							setBuyerContains(e.target.value);
							setPage(1);
						}}
					/>
					<Input
						type="date"
						placeholder="Invoice date from"
						value={dateFrom}
						onChange={(e) => {
							setDateFrom(e.target.value);
							setPage(1);
						}}
					/>
					<Input
						type="date"
						placeholder="Invoice date to"
						value={dateTo}
						onChange={(e) => {
							setDateTo(e.target.value);
							setPage(1);
						}}
					/>
					<Input
						type="number"
						placeholder="Min amount"
						value={minAmount}
						onChange={(e) => {
							setMinAmount(e.target.value);
							setPage(1);
						}}
					/>
					<Input
						type="number"
						placeholder="Max amount"
						value={maxAmount}
						onChange={(e) => {
							setMaxAmount(e.target.value);
							setPage(1);
						}}
					/>
					<Input
						placeholder="Item name…"
						value={itemContains}
						onChange={(e) => {
							setItemContains(e.target.value);
							setPage(1);
						}}
					/>
				</div>
			</div>

			<div className="flex-1 overflow-auto">
				{isLoading ? (
					<div className="flex h-full items-center justify-center">
						<Loader />
					</div>
				) : invoices.length === 0 ? (
					<Empty
						title={reviewOnly ? "No invoices need review" : "No invoices yet"}
						description={
							reviewOnly
								? "All OCR results passed field validation — great."
								: "Invoices from emails with XML attachments or download links are ingested automatically. You can also run OCR manually on existing PDF emails."
						}
					/>
				) : (
					<table className="w-full text-sm">
						<thead className="sticky top-0 border-b border-kumo-default bg-kumo-raised text-left text-xs uppercase text-kumo-subtle">
							<tr>
								<th className="px-3 py-2 font-medium">
									<input
										type="checkbox"
										className="h-4 w-4"
										aria-label="Select all on page"
										checked={allSelected}
										ref={(el) => {
											if (el) el.indeterminate = !allSelected && someSelected;
										}}
										onChange={toggleSelectAll}
									/>
								</th>
								<th className="px-3 py-2 font-medium">Invoice Date</th>
								<th className="px-3 py-2 font-medium">Number</th>
								<th className="px-3 py-2 font-medium">Seller</th>
								<th className="px-3 py-2 font-medium">Buyer</th>
								<th className="px-3 py-2 font-medium text-right">Excl. Tax</th>
								<th className="px-3 py-2 font-medium text-right">Tax</th>
								<th className="px-3 py-2 font-medium text-right">Total</th>
								<th className="px-3 py-2 font-medium">Source</th>
								<th className="px-3 py-2 font-medium"></th>
							</tr>
						</thead>
						<tbody>
							{invoices.map((inv) => {
								const disabled =
									!!inv.is_voided || !!inv.original_invoice_number;
								return (
								<tr
									key={inv.id}
									className="border-b border-kumo-muted hover:bg-kumo-muted"
								>
									<td className="px-3 py-2">
										<input
											type="checkbox"
											className="h-4 w-4"
											aria-label={`Select invoice ${inv.invoice_number}`}
											disabled={disabled}
											checked={selected.has(inv.id)}
											onChange={() => toggleSelect(inv.id)}
										/>
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
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
									<td className="px-3 py-2 text-right font-mono">
										{formatAmount(inv.amount_excl_tax)}
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{formatAmount(inv.tax_amount)}
									</td>
									<td className="px-3 py-2 text-right font-mono font-semibold">
										{formatAmount(inv.amount_incl_tax)}
									</td>
									<td className="px-3 py-2">
										<div className="flex items-center gap-1">
											<Badge
												variant={inv.source_kind === "pdf-ocr" ? "outline" : "secondary"}
												className={inv.source_kind === "pdf-ocr" ? WARNING_BADGE_CLASS_NAME : undefined}
											>
												{inv.source_kind === "pdf-ocr" ? "PDF OCR" : "XML"}
											</Badge>
											{inv.needs_review ? (
												<Badge variant="outline" className={WARNING_BADGE_CLASS_NAME}>
													<WarningIcon size={12} weight="fill" />
													Review
												</Badge>
											) : null}
										</div>
									</td>
									<td className="px-3 py-2 text-right">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleDelete(inv.id, inv.invoice_number)}
											aria-label="Delete invoice"
										>
											<TrashIcon size={14} />
										</Button>
									</td>
								</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>

			{totalCount > PAGE_SIZE ? (
				<div className="border-t border-kumo-default bg-kumo-raised px-6 py-3 flex justify-center">
					<Pagination
						page={page}
						setPage={setPage}
						perPage={PAGE_SIZE}
						totalCount={totalCount}
					/>
					{isFetching ? (
						<span className="ml-3 text-xs text-kumo-subtle">Loading…</span>
					) : null}
				</div>
			) : null}

			<Dialog.Root open={addOpen} onOpenChange={setAddOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Add to Bundle
					</Dialog.Title>
					<p className="mb-4 text-sm text-kumo-subtle">
						Add the {selected.size} selected invoice{selected.size !== 1 ? "s" : ""} to an existing bundle or create a new one.
					</p>
					<div className="space-y-4">
						{bundles.length > 0 ? (
							<div>
								<label className="block text-sm font-medium text-kumo-default mb-1">
									Select existing bundle
								</label>
								<select
									className="w-full rounded border border-kumo-default bg-kumo-raised px-2 py-1.5 text-sm"
									value={chosenBundleId}
									onChange={(e) => {
										setChosenBundleId(e.target.value);
										if (e.target.value) setNewBundleName("");
									}}
								>
									<option value="">— None —</option>
									{bundles.map((b) => (
										<option key={b.id} value={b.id}>
											{b.name} ({b.invoice_count} invoice{b.invoice_count !== 1 ? "s" : ""})
										</option>
									))}
								</select>
							</div>
						) : null}
						<div>
							<label className="block text-sm font-medium text-kumo-default mb-1">
								Or create a new bundle
							</label>
							<Input
								placeholder="e.g. Apr 2026 Business Trip"
								value={newBundleName}
								onChange={(e) => {
									setNewBundleName(e.target.value);
									if (e.target.value) setChosenBundleId("");
								}}
								disabled={!!chosenBundleId}
							/>
						</div>
					</div>
					<div className="mt-6 flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="primary"
							onClick={handleAddToBundle}
							disabled={
								addPending ||
								(!chosenBundleId && !newBundleName.trim())
							}
						>
							Add to Bundle
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
