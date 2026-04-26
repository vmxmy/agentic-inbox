// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader } from "@cloudflare/kumo";
import { ShieldIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useWhoami } from "~/queries/identity";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

export default function AdminRoute() {
	const navigate = useNavigate();
	const { data: whoami, isLoading: whoamiLoading } = useWhoami();

	const { data, isLoading, error } = useQuery({
		queryKey: queryKeys.adminMailboxes,
		queryFn: () => api.adminListMailboxes(),
		enabled: !!whoami?.isAdmin,
	});

	if (whoamiLoading) {
		return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
	}

	if (!whoami?.isAdmin) {
		return (
			<div className="p-8 max-w-lg mx-auto text-sm text-kumo-default space-y-3">
				<h1 className="text-lg font-semibold flex items-center gap-2">
					<ShieldIcon size={18} weight="fill" /> Admin dashboard
				</h1>
				<p className="text-kumo-subtle">
					You don't have admin access. Existing admins can promote you via
					<code> /api/v1/admin/users/:id/role</code>.
				</p>
				<Button variant="secondary" onClick={() => navigate("/")}>Back</Button>
			</div>
		);
	}

	return (
		<div className="p-6 md:p-8 max-w-5xl mx-auto text-kumo-default space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold flex items-center gap-2">
					<ShieldIcon size={18} weight="fill" /> Admin dashboard
				</h1>
				<Button variant="secondary" size="sm" onClick={() => navigate("/")}>Back to app</Button>
			</div>
			<p className="text-xs text-kumo-subtle">
				Global view of every mailbox in R2. Read-only at this point — use the
				regular UI or <code>/api/v1/mailboxes/:id/members</code> to manage ACL.
			</p>

			{isLoading && <div className="flex justify-center py-10"><Loader size="base" /></div>}

			{error && (
				<div className="rounded border border-red-400/40 bg-red-500/5 text-sm text-red-400 p-3">
					{error instanceof Error ? error.message : "Failed to load mailboxes"}
				</div>
			)}

			{data && (
				<div className="overflow-x-auto rounded-lg border border-kumo-line bg-kumo-base">
					<table className="min-w-full text-xs">
						<thead className="bg-kumo-recessed text-kumo-subtle uppercase tracking-wide text-[10px]">
							<tr>
								<th className="px-3 py-2 text-left">Mailbox</th>
								<th className="px-3 py-2 text-left">Owner</th>
								<th className="px-3 py-2 text-right">Members</th>
								<th className="px-3 py-2 text-right">Inbox</th>
								<th className="px-3 py-2" />
							</tr>
						</thead>
						<tbody>
							{data.map((m) => (
								<tr key={m.id} className="border-t border-kumo-line">
									<td className="px-3 py-2 font-mono">{m.email}</td>
									<td className="px-3 py-2">
										{m.owner ?? <Badge variant="secondary">unclaimed</Badge>}
									</td>
									<td className="px-3 py-2 text-right">{m.memberCount}</td>
									<td className="px-3 py-2 text-right">
										{m.inboxCount ?? "—"}
									</td>
									<td className="px-3 py-2 text-right">
										<Button
											variant="ghost"
											size="xs"
											onClick={() => navigate(`/mailbox/${m.id}/emails/inbox`)}
										>
											Open
										</Button>
									</td>
								</tr>
							))}
							{data.length === 0 && (
								<tr>
									<td className="px-3 py-6 text-center text-kumo-subtle italic" colSpan={5}>
										No mailboxes yet.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
