// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, DeleteResource, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

type AdminMailbox = Awaited<ReturnType<typeof api.adminListMailboxes>>[number];
type MailboxKindFilter = "all" | "legacy" | "team" | "team_user" | "ownerless";

const KIND_FILTERS: Array<{ value: MailboxKindFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "legacy", label: "Legacy" },
	{ value: "team", label: "Team" },
	{ value: "team_user", label: "Team user" },
	{ value: "ownerless", label: "Ownerless" },
];

function useAdminMailboxes() {
	return useQuery<AdminMailbox[]>({
		queryKey: queryKeys.adminMailboxes,
		queryFn: () => api.adminListMailboxes(),
	});
}

function useAssignMailboxOwner() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, email }: { mailboxId: string; email: string }) => api.adminAssignMailboxOwner(mailboxId, email),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.adminMailboxes });
			queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

function useDeleteMailbox() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.adminDeleteMailbox(mailboxId),
		onSuccess: (_data, mailboxId) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.adminMailboxes });
			queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			queryClient.removeQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
		},
	});
}

function isMailboxKindFilter(value: string | null): value is MailboxKindFilter {
	return value === "legacy" || value === "team" || value === "team_user" || value === "ownerless" || value === "all";
}

function mailboxMatchesKind(mailbox: AdminMailbox, kind: MailboxKindFilter): boolean {
	if (kind === "all") return true;
	if (kind === "ownerless") return !mailbox.team && mailbox.owner === null;
	if (kind === "legacy") return !mailbox.team;
	return mailbox.team?.kind === kind;
}

function mailboxMatchesSearch(mailbox: AdminMailbox, search: string): boolean {
	const needle = search.trim().toLowerCase();
	if (!needle) return true;
	const maybeName = (mailbox as { name?: string | null }).name ?? "";
	return [mailbox.email, mailbox.owner ?? "", mailbox.team?.displayName ?? "", maybeName].some((value) => value.toLowerCase().includes(needle));
}

export default function AdminMailboxesRoute() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: mailboxes = [], isLoading: mailboxesLoading } = useAdminMailboxes();
	const search = searchParams.get("search") ?? "";
	const kindParam = searchParams.get("kind");
	const kind: MailboxKindFilter = isMailboxKindFilter(kindParam) ? kindParam : "all";
	const filteredMailboxes = useMemo(
		() => mailboxes.filter((mailbox) => mailboxMatchesKind(mailbox, kind) && mailboxMatchesSearch(mailbox, search)),
		[mailboxes, kind, search],
	);

	const updateParam = (key: "search" | "kind", value: string) => {
		const next = new URLSearchParams(searchParams);
		if (!value || (key === "kind" && value === "all")) next.delete(key);
		else next.set(key, value);
		setSearchParams(next, { replace: true });
	};

	return (
		<div className="space-y-6 text-kumo-default">
			<div>
				<h1 className="text-lg font-semibold">Mailbox directory</h1>
				<p className="mt-1 text-sm text-kumo-subtle">Team-managed and legacy rows visible to admins.</p>
			</div>

			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">All mailboxes</h2>
						<p className="text-xs text-kumo-subtle">Audit every mailbox, owner, and inbox count.</p>
					</div>
					<Badge variant="secondary">{filteredMailboxes.length}/{mailboxes.length}</Badge>
				</div>

				<div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
					<Input label="Search" placeholder="email, owner, or name" value={search} onChange={(e) => updateParam("search", e.target.value)} />
					<label className="grid gap-1 text-xs text-kumo-subtle">
						<span>Kind</span>
						<select className="h-9 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default" value={kind} onChange={(e) => updateParam("kind", e.target.value)}>
							{KIND_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
						</select>
					</label>
				</div>

				{mailboxesLoading ? (
					<div className="flex justify-center py-8"><Loader size="sm" /></div>
				) : (
					<div className="overflow-x-auto rounded-lg border border-kumo-line bg-kumo-base">
						<table className="min-w-full text-xs">
							<thead className="bg-kumo-recessed text-[10px] uppercase tracking-wide text-kumo-subtle">
								<tr><th className="px-3 py-2 text-left">Mailbox</th><th className="px-3 py-2 text-left">Mode</th><th className="px-3 py-2 text-left">Owner</th><th className="px-3 py-2 text-right">Members</th><th className="px-3 py-2 text-right">Inbox</th><th className="px-3 py-2" /></tr>
							</thead>
							<tbody>
								{filteredMailboxes.map((mailbox) => <MailboxRow key={mailbox.id} mailbox={mailbox} onOpen={() => navigate(`/mailbox/${mailbox.id}/emails/inbox`)} />)}
								{filteredMailboxes.length === 0 && <tr><td className="px-3 py-6 text-center italic text-kumo-subtle" colSpan={6}>No mailboxes match the current filters.</td></tr>}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}

function MailboxRow({ mailbox, onOpen }: { mailbox: AdminMailbox; onOpen: () => void }) {
	const toastManager = useKumoToastManager();
	const assignOwner = useAssignMailboxOwner();
	const deleteMailbox = useDeleteMailbox();
	const [isEditingOwner, setIsEditingOwner] = useState(false);
	const [ownerEmail, setOwnerEmail] = useState("");
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const isLegacy = !mailbox.team;
	const isOwnerlessLegacy = isLegacy && mailbox.owner === null;

	const handleAssignOwner = async (event: FormEvent) => {
		event.preventDefault();
		try {
			const result = await assignOwner.mutateAsync({ mailboxId: mailbox.id, email: ownerEmail });
			setIsEditingOwner(false);
			setOwnerEmail("");
			toastManager.add({ title: `Owner assigned to ${result.owner ?? ownerEmail}` });
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to assign owner", variant: "error" });
		}
	};

	const handleDelete = async () => {
		try {
			await deleteMailbox.mutateAsync(mailbox.id);
			setIsDeleteOpen(false);
			toastManager.add({ title: `Deleted ${mailbox.email}` });
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to delete mailbox", variant: "error" });
		}
	};

	return (
		<tr className="border-t border-kumo-line align-top">
			<td className="px-3 py-2 font-mono">{mailbox.email}</td>
			<td className="px-3 py-2">
				{mailbox.team ? <Badge variant="primary">{mailbox.team.kind === "team" ? "team" : "team user"}</Badge> : <Badge variant="secondary">legacy</Badge>}
			</td>
			<td className="px-3 py-2">
				{mailbox.owner ?? <Badge variant="secondary">ownerless</Badge>}
				{isEditingOwner && (
					<form onSubmit={handleAssignOwner} className="mt-2 flex min-w-72 flex-col gap-2 sm:flex-row sm:items-center">
						<Input value={ownerEmail} placeholder="owner@example.com" onChange={(e) => setOwnerEmail(e.target.value)} autoFocus required />
						<Button type="submit" variant="primary" size="xs" loading={assignOwner.isPending} disabled={!ownerEmail.trim()}>Save</Button>
						<Button type="button" variant="ghost" size="xs" onClick={() => setIsEditingOwner(false)}>Cancel</Button>
					</form>
				)}
			</td>
			<td className="px-3 py-2 text-right">{mailbox.memberCount}</td>
			<td className="px-3 py-2 text-right">{mailbox.inboxCount ?? "-"}</td>
			<td className="px-3 py-2 text-right">
				<div className="flex flex-wrap justify-end gap-2">
					<Button variant="ghost" size="xs" onClick={onOpen}>Open</Button>
					{isOwnerlessLegacy && !isEditingOwner && <Button variant="secondary" size="xs" onClick={() => setIsEditingOwner(true)}>Reassign owner</Button>}
					{isLegacy && <Button variant="ghost" size="xs" onClick={() => setIsDeleteOpen(true)}>Delete</Button>}
				</div>
				{isLegacy && (
					<DeleteResource
						open={isDeleteOpen}
						onOpenChange={setIsDeleteOpen}
						resourceType="mailbox"
						resourceName={mailbox.email}
						isDeleting={deleteMailbox.isPending}
						errorMessage={deleteMailbox.error instanceof Error ? deleteMailbox.error.message : undefined}
						onDelete={handleDelete}
					/>
				)}
			</td>
		</tr>
	);
}
