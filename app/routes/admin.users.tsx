// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { useAdminUsers, useUpdateUserRole } from "~/queries/users";

function formatDate(value: number | null): string {
	if (!value) return "-";
	return new Date(value).toLocaleString();
}

export default function AdminUsersRoute() {
	const toastManager = useKumoToastManager();
	const { data: users = [], isLoading, error } = useAdminUsers();
	const updateUserRole = useUpdateUserRole();

	const handleRoleChange = async (userId: string, role: "admin" | "user", email: string) => {
		try {
			await updateUserRole.mutateAsync({ userId, role });
			toastManager.add({ title: `${email} is now ${role === "admin" ? "an admin" : "a user"}` });
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "Failed to update role", variant: "error" });
		}
	};

	return (
		<div className="space-y-6 text-kumo-default">
			<div>
				<h1 className="text-lg font-semibold">Users</h1>
				<p className="mt-1 text-sm text-kumo-subtle">Review registered users and manage global admin roles.</p>
			</div>

			{error && <div className="rounded border border-red-400/40 bg-red-500/5 p-3 text-sm text-red-400">{error instanceof Error ? error.message : "Failed to load users"}</div>}

			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">All users</h2>
						<p className="text-xs text-kumo-subtle">Role changes apply immediately after the server confirms them.</p>
					</div>
					<Badge variant="secondary">{users.length}</Badge>
				</div>

				{isLoading ? <div className="flex justify-center py-8"><Loader size="sm" /></div> : (
					<div className="overflow-x-auto rounded-lg border border-kumo-line bg-kumo-base">
						<table className="min-w-full text-xs">
							<thead className="bg-kumo-recessed text-[10px] uppercase tracking-wide text-kumo-subtle">
								<tr><th className="px-3 py-2 text-left">Email</th><th className="px-3 py-2 text-left">Display name</th><th className="px-3 py-2 text-left">Role</th><th className="px-3 py-2 text-left">Verified</th><th className="px-3 py-2 text-left">Created</th><th className="px-3 py-2 text-right">Actions</th></tr>
							</thead>
							<tbody>
								{users.map((user) => {
									const nextRole = user.role === "admin" ? "user" : "admin";
									return (
										<tr key={user.id} className="border-t border-kumo-line">
											<td className="px-3 py-2 font-mono">{user.email}</td>
											<td className="px-3 py-2">{user.displayName ?? <span className="text-kumo-subtle">-</span>}</td>
											<td className="px-3 py-2"><Badge variant={user.role === "admin" ? "primary" : "secondary"}>{user.role}</Badge></td>
											<td className="px-3 py-2">{formatDate(user.emailVerifiedAt)}</td>
											<td className="px-3 py-2">{formatDate(user.createdAt)}</td>
											<td className="px-3 py-2 text-right"><Button variant={user.role === "admin" ? "ghost" : "secondary"} size="xs" onClick={() => handleRoleChange(user.id, nextRole, user.email)} loading={updateUserRole.isPending}>{user.role === "admin" ? "Demote" : "Promote to admin"}</Button></td>
										</tr>
									);
								})}
								{users.length === 0 && <tr><td className="px-3 py-6 text-center italic text-kumo-subtle" colSpan={6}>No users found.</td></tr>}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
