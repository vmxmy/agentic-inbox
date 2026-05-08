// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, PencilSimpleIcon, UsersThreeIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useWhoami } from "~/queries/identity";
import { queryKeys } from "~/queries/keys";
import { useAdminTeams, useAdminTeamUsers, useCreateTeamUser, useReissueSetupLink, useUpdateTeamUser } from "~/queries/teams";
import api from "~/services/api";
import type { TeamUser } from "~/types";

function previewSlug(value: string): string {
	return value.trim().toLowerCase();
}

function slugValidationError(value: string): string | null {
	if (!value) return null;
	if (value.length < 2 || value.length > 40) return "Use 2-40 lowercase letters, numbers, or single hyphens.";
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return "Use lowercase letters, numbers, and single hyphens only.";
	if (["admin", "api", "auth", "mcp", "root", "security", "support", "system", "www"].includes(value)) return "This name is reserved.";
	return null;
}

export default function AdminTeamUsersRoute() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const toastManager = useKumoToastManager();
	const { data: whoami } = useWhoami();
	const isAdmin = !!whoami?.isAdmin;
	const { data: config } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
		enabled: isAdmin,
	});
	const rootDomain = config?.domains[0] ?? "domain";
	const { data: teams = [], isLoading: teamsLoading, error: teamsError } = useAdminTeams(isAdmin);
	const selectedTeamId = searchParams.get("teamId") ?? undefined;
	const selectedTeam = useMemo(() => teams.find((team) => team.id === selectedTeamId) ?? teams[0], [teams, selectedTeamId]);
	const { data: teamUsers = [], isLoading: usersLoading } = useAdminTeamUsers(selectedTeam?.id, isAdmin);
	const createTeamUser = useCreateTeamUser();
	const updateTeamUser = useUpdateTeamUser(selectedTeam?.id ?? "");
	const reissueSetupLink = useReissueSetupLink(selectedTeam?.id ?? "");
	const [editingUserId, setEditingUserId] = useState<string | null>(null);
	const [editingUserDisplayName, setEditingUserDisplayName] = useState("");
	const [userName, setUserName] = useState("");
	const [userDisplayName, setUserDisplayName] = useState("");
	const [setupUrl, setSetupUrl] = useState<string | null>(null);
	const [setupExpiresAt, setSetupExpiresAt] = useState<number | null>(null);
	const [rowSetupLinks, setRowSetupLinks] = useState<Record<string, { setupUrl: string; setupExpiresAt: number | null }>>({});
	const userSlug = previewSlug(userName);
	const userSlugError = slugValidationError(userSlug);
	const userAddressPreview = selectedTeam && userSlug
		? `${selectedTeam.slug}.${userSlug}@${rootDomain}`
		: selectedTeam ? `${selectedTeam.slug}.user@${rootDomain}` : `team.user@${rootDomain}`;

	useEffect(() => {
		if (!selectedTeamId && teams[0]) setSearchParams({ teamId: teams[0].id }, { replace: true });
	}, [selectedTeamId, setSearchParams, teams]);

	const handleSelectTeam = (teamId: string) => {
		setSetupUrl(null);
		setSetupExpiresAt(null);
		setRowSetupLinks({});
		setSearchParams({ teamId });
	};

	const handleCreateUser = async (event: FormEvent) => {
		event.preventDefault();
		if (!selectedTeam) return;
		try {
			const created = await createTeamUser.mutateAsync({ teamId: selectedTeam.id, userName, displayName: userDisplayName });
			setUserName("");
			setUserDisplayName("");
			setSetupUrl(created.setupUrl ?? null);
			setSetupExpiresAt(created.setupExpiresAt ?? null);
			toastManager.add({ title: `Created ${created.mailboxAddress}` });
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to create user", variant: "error" });
		}
	};

	const copySetupUrl = async (url: string) => {
		try {
			await navigator.clipboard.writeText(url);
			toastManager.add({ title: "Setup link copied" });
		} catch {
			toastManager.add({ title: "Copy failed — select the link manually", variant: "error" });
		}
	};

	const handleCopySetupUrl = () => {
		if (setupUrl) void copySetupUrl(setupUrl);
	};

	const handleToggleUser = async (user: TeamUser) => {
		if (!selectedTeam) return;
		const nextDisabled = !user.disabledAt;
		try {
			await updateTeamUser.mutateAsync({ userId: user.id, body: { disabled: nextDisabled } });
			toastManager.add({ title: `${nextDisabled ? "Disabled" : "Enabled"} ${user.displayName ?? user.slug}` });
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to update team user", variant: "error" });
		}
	};

	const handleStartUserEdit = (user: TeamUser) => {
		setEditingUserId(user.id);
		setEditingUserDisplayName(user.displayName ?? user.slug);
	};

	const handleSaveUserEdit = async () => {
		if (!editingUserId || !editingUserDisplayName.trim() || !selectedTeam) return;
		try {
			await updateTeamUser.mutateAsync({ userId: editingUserId, body: { displayName: editingUserDisplayName.trim() } });
			toastManager.add({ title: "Display name updated" });
			setEditingUserId(null);
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to update user", variant: "error" });
		}
	};

	const handleCancelUserEdit = () => setEditingUserId(null);

	const handleReissueSetupLink = async (user: TeamUser) => {
		if (!selectedTeam) return;
		try {
			const issued = await reissueSetupLink.mutateAsync({ userId: user.id });
			setRowSetupLinks((current) => ({ ...current, [user.id]: issued }));
			toastManager.add({ title: `Setup link re-issued for ${user.displayName ?? user.slug}` });
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to re-send setup link", variant: "error" });
		}
	};

	return (
		<div className="space-y-6 text-kumo-default">
			<div>
				<h1 className="flex items-center gap-2 text-lg font-semibold"><UsersThreeIcon size={18} weight="duotone" /> Team users</h1>
				<p className="mt-1 text-sm text-kumo-subtle">Create users under a selected team. Selection is persisted in <code>?teamId=</code>.</p>
			</div>
			{teamsError && <div className="rounded border border-red-400/40 bg-red-500/5 p-3 text-sm text-red-400">{teamsError instanceof Error ? teamsError.message : "Failed to load teams"}</div>}

			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="mb-4 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Select team</h2>
						<p className="text-xs text-kumo-subtle">{selectedTeam ? `Users under ${selectedTeam.displayName}` : "Select a team first."}</p>
					</div>
					<Badge variant="secondary">{teamUsers.length}</Badge>
				</div>
				{teamsLoading ? <div className="flex justify-center py-6"><Loader size="sm" /></div> : (
					<div className="mb-5 flex flex-wrap gap-2">
						{teams.map((team) => (
							<Button key={team.id} type="button" size="sm" variant={selectedTeam?.id === team.id ? "primary" : "secondary"} onClick={() => handleSelectTeam(team.id)}>{team.displayName}</Button>
						))}
						{teams.length === 0 && <span className="text-xs text-kumo-subtle">No teams yet.</span>}
					</div>
				)}

				<form onSubmit={handleCreateUser} className="mb-5 space-y-3 rounded-lg bg-kumo-recessed p-3">
					<Input label="User name" placeholder="alice" value={userName} onChange={(e) => setUserName(e.target.value)} disabled={!selectedTeam} required />
					<Input label="Display name" placeholder="Alice Zhang" value={userDisplayName} onChange={(e) => setUserDisplayName(e.target.value)} disabled={!selectedTeam} required />
					<div className="flex items-center justify-between gap-3 text-xs text-kumo-subtle">
						<span className="truncate">Preview: <code>{userAddressPreview}</code></span>
						<Button variant="primary" size="sm" type="submit" disabled={!selectedTeam || !userSlug || !!userSlugError || !userDisplayName.trim()} loading={createTeamUser.isPending}>Create user</Button>
					</div>
					{userSlugError && <p className="text-xs text-red-400">{userSlugError}</p>}
					{setupUrl && <SetupLink setupUrl={setupUrl} setupExpiresAt={setupExpiresAt} onCopy={handleCopySetupUrl} />}
				</form>

				{usersLoading ? <div className="flex justify-center py-8"><Loader size="sm" /></div> : (
					<div className="overflow-x-auto rounded-lg border border-kumo-line">
						<table className="min-w-full text-xs">
							<thead className="bg-kumo-recessed text-[10px] uppercase tracking-wide text-kumo-subtle"><tr><th className="px-3 py-2 text-left">User</th><th className="px-3 py-2 text-left">Mailbox</th><th className="px-3 py-2 text-left">Setup</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
							<tbody>
								{teamUsers.map((user) => (
									<tr key={user.id} className={`border-t border-kumo-line ${user.disabledAt ? "opacity-70" : ""}`}>
										<td className="px-3 py-2">
											{editingUserId === user.id ? (
												<div className="flex items-center gap-1.5">
													<Input
														value={editingUserDisplayName}
														onChange={(e) => setEditingUserDisplayName(e.target.value)}
														onKeyDown={(e) => { if (e.key === "Enter") void handleSaveUserEdit(); if (e.key === "Escape") handleCancelUserEdit(); }}
														autoFocus
													/>
													<Button size="xs" variant="primary" shape="square" type="button" aria-label="Save" icon={<CheckIcon size={12} weight="bold" />} onClick={() => void handleSaveUserEdit()} loading={updateTeamUser.isPending} />
													<Button size="xs" variant="ghost" shape="square" type="button" aria-label="Cancel" icon={<XIcon size={12} />} onClick={handleCancelUserEdit} />
												</div>
											) : (
												<div className="group flex items-start gap-1">
													<div>
														<div className="flex flex-wrap items-center gap-2"><span className="font-medium">{user.displayName ?? user.slug}</span>{user.disabledAt && <Badge variant="destructive">Disabled</Badge>}</div>
														<div className="text-kumo-subtle">{user.slug}</div>
													</div>
													<Button size="xs" variant="ghost" shape="square" type="button" aria-label="Edit display name" icon={<PencilSimpleIcon size={12} />} onClick={() => handleStartUserEdit(user)} />
												</div>
											)}
										</td>
										<td className="px-3 py-2 font-mono">{user.mailboxAddress}</td>
										<td className="min-w-64 px-3 py-2">{rowSetupLinks[user.id] ? <SetupLink setupUrl={rowSetupLinks[user.id].setupUrl} setupExpiresAt={rowSetupLinks[user.id].setupExpiresAt} onCopy={() => copySetupUrl(rowSetupLinks[user.id].setupUrl)} compact /> : <span className="text-kumo-subtle">-</span>}</td>
										<td className="px-3 py-2 text-right"><div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" size="xs" onClick={() => navigate(`/mailbox/${user.mailboxAddress}/emails/inbox`)}>Open</Button><Button variant="secondary" size="xs" onClick={() => handleReissueSetupLink(user)} loading={reissueSetupLink.isPending}>Re-send setup link</Button><Button variant={user.disabledAt ? "secondary" : "ghost"} size="xs" onClick={() => handleToggleUser(user)} loading={updateTeamUser.isPending}>{user.disabledAt ? "Enable" : "Disable"}</Button></div></td>
									</tr>
								))}
								{teamUsers.length === 0 && <tr><td className="px-3 py-6 text-center italic text-kumo-subtle" colSpan={4}>No team users yet.</td></tr>}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}

function SetupLink({ setupUrl, setupExpiresAt, onCopy, compact = false }: { setupUrl: string; setupExpiresAt: number | null; onCopy: () => void; compact?: boolean }) {
	return (
		<div className={compact ? "space-y-1" : "rounded-md border border-kumo-line bg-kumo-base p-3"}>
			{!compact && <div className="mb-2 text-xs font-medium text-kumo-default">One-time setup link</div>}
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input value={setupUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
				<Button variant="secondary" size="sm" type="button" icon={<CopyIcon size={14} />} onClick={onCopy}>Copy</Button>
			</div>
			{setupExpiresAt && <p className="mt-1 text-xs text-kumo-subtle">Expires {new Date(setupExpiresAt).toLocaleString()}</p>}
		</div>
	);
}
