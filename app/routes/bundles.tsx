// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog, Empty, Input, Loader } from "@cloudflare/kumo";
import {
	DownloadSimpleIcon,
	PackageIcon,
	PlusIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { formatListDate } from "shared/dates";
import {
	useBundles,
	useCreateBundle,
	useDeleteBundle,
} from "~/queries/bundles";
import api from "~/services/api";

function formatAmount(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	return `¥${n.toFixed(2)}`;
}

export default function BundlesRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: bundles = [], isLoading } = useBundles(mailboxId);
	const createBundle = useCreateBundle(mailboxId);
	const deleteBundle = useDeleteBundle(mailboxId);

	const [createOpen, setCreateOpen] = useState(false);
	const [newName, setNewName] = useState("");
	const [newNote, setNewNote] = useState("");

	const handleCreate = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newName.trim()) return;
		try {
			await createBundle.mutateAsync({
				name: newName.trim(),
				note: newNote.trim() || null,
			});
			setNewName("");
			setNewNote("");
			setCreateOpen(false);
		} catch (err) {
			window.alert(`Failed to create: ${(err as Error).message}`);
		}
	};

	const handleDelete = async (bundleId: string, name: string) => {
		if (!window.confirm(`Delete bundle "${name}"? Invoices will not be deleted.`)) return;
		try {
			await deleteBundle.mutateAsync(bundleId);
		} catch (err) {
			window.alert(`Failed to delete: ${(err as Error).message}`);
		}
	};

	return (
		<div className="flex min-h-full flex-col">
			<div className="border-b border-kumo-default bg-kumo-raised px-6 py-4 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold text-kumo-default flex items-center gap-2">
						<PackageIcon size={22} weight="regular" />
						Bundles
					</h1>
					<p className="mt-1 text-sm text-kumo-subtle">
						{bundles.length} bundle{bundles.length !== 1 ? "s" : ""} · Export invoices as ZIP
					</p>
				</div>
				<Button
					variant="primary"
					onClick={() => setCreateOpen(true)}
				>
					<PlusIcon size={14} weight="regular" />
					New Bundle
				</Button>
			</div>

			<div className="flex-1 overflow-auto">
				{isLoading ? (
					<div className="flex h-full items-center justify-center">
						<Loader />
					</div>
				) : bundles.length === 0 ? (
					<Empty
						title="No bundles yet"
						description='Select invoices from the invoice list and click "Add to Bundle", or create an empty bundle here.'
					/>
				) : (
					<table className="w-full text-sm">
						<thead className="sticky top-0 border-b border-kumo-default bg-kumo-raised text-left text-xs uppercase text-kumo-subtle">
							<tr>
								<th className="px-6 py-2 font-medium">Name</th>
								<th className="px-3 py-2 font-medium text-right">Invoices</th>
								<th className="px-3 py-2 font-medium text-right">Total</th>
								<th className="px-3 py-2 font-medium">Status</th>
								<th className="px-3 py-2 font-medium">Created</th>
								<th className="px-3 py-2 font-medium"></th>
							</tr>
						</thead>
						<tbody>
							{bundles.map((b) => (
								<tr
									key={b.id}
									className="border-b border-kumo-muted hover:bg-kumo-muted"
								>
									<td className="px-6 py-2">
										<Link
											to={`/mailbox/${mailboxId}/bundles/${b.id}`}
											className="text-kumo-default hover:text-kumo-accent font-medium"
										>
											{b.name}
										</Link>
										{b.note ? (
											<div
												className="text-xs text-kumo-subtle truncate max-w-[300px]"
												title={b.note}
											>
												{b.note}
											</div>
										) : null}
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{b.invoice_count}
									</td>
									<td className="px-3 py-2 text-right font-mono font-semibold">
										{formatAmount(b.total_amount)}
									</td>
									<td className="px-3 py-2 text-xs text-kumo-subtle">
										{b.status}
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-xs text-kumo-subtle">
										{formatListDate(b.created_at)}
									</td>
									<td className="px-3 py-2 text-right whitespace-nowrap">
										<Button
											variant="ghost"
											size="sm"
											disabled={!mailboxId || b.invoice_count === 0}
											onClick={() => {
												if (!mailboxId) return;
												window.location.href = api.bundleZipUrl(
													mailboxId,
													b.id,
												);
											}}
											aria-label="Download ZIP"
										>
											<DownloadSimpleIcon size={14} />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleDelete(b.id, b.name)}
											aria-label="Delete bundle"
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

			<Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						New Bundle
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						<Input
							label="Name"
							placeholder="e.g. Apr 2026 Business Trip"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							required
						/>
						<Input
							label="Note (optional)"
							placeholder="Project code, applicant, etc."
							value={newNote}
							onChange={(e) => setNewNote(e.target.value)}
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!newName.trim() || createBundle.isPending}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
