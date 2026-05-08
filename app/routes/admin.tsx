// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { CopyIcon, ShieldIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useWhoami } from "~/queries/identity";
import { queryKeys } from "~/queries/keys";
import {
	useAdminTeams,
	useAdminTeamUsers,
	useCreateTeam,
	useCreateTeamUser,
} from "~/queries/teams";
import api from "~/services/api";

function previewSlug(value: string): string {
	return value.trim().toLowerCase();
}

function slugValidationError(value: string): string | null {
	if (!value) return null;
	if (value.length < 2 || value.length > 40) return "Use 2-40 lowercase letters, numbers, or single hyphens.";
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
		return "Use lowercase letters, numbers, and single hyphens only.";
	}
	if (["admin", "api", "auth", "mcp", "root", "security", "support", "system", "www"].includes(value)) {
		return "This name is reserved.";
	}
	return null;
}

export default function AdminRoute() {
	const navigate = useNavigate();
	const toastManager = useKumoToastManager();
	const { data: whoami, isLoading: whoamiLoading } = useWhoami();
	const isAdmin = !!whoami?.isAdmin;

	const { data: config } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
		enabled: isAdmin,
	});
	const rootDomain = config?.domains[0] ?? "domain";

	const { data: teams = [], isLoading: teamsLoading, error: teamsError } = useAdminTeams(isAdmin);
	const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>();
	const selectedTeam = useMemo(
		() => teams.find((team) => team.id === selectedTeamId) ?? teams[0],
		[teams, selectedTeamId],
	);
	const { data: teamUsers = [], isLoading: usersLoading } = useAdminTeamUsers(selectedTeam?.id, isAdmin);

	const { data: mailboxes = [], isLoading: mailboxesLoading } = useQuery({
		queryKey: queryKeys.adminMailboxes,
		queryFn: () => api.adminListMailboxes(),
		enabled: isAdmin,
	});

	const createTeam = useCreateTeam();
	const createTeamUser = useCreateTeamUser();
	const [teamName, setTeamName] = useState("");
	const [teamDisplayName, setTeamDisplayName] = useState("");
	const [userName, setUserName] = useState("");
	const [userDisplayName, setUserDisplayName] = useState("");
	const [setupUrl, setSetupUrl] = useState<string | null>(null);
	const [setupExpiresAt, setSetupExpiresAt] = useState<number | null>(null);

	useEffect(() => {
		if (!selectedTeamId && teams[0]) setSelectedTeamId(teams[0].id);
	}, [selectedTeamId, teams]);

	const teamSlug = previewSlug(teamName);
	const userSlug = previewSlug(userName);
	const teamSlugError = slugValidationError(teamSlug);
	const userSlugError = slugValidationError(userSlug);
	const teamAddressPreview = teamSlug
		? `${teamSlug}@${rootDomain}`
		: `team@${rootDomain}`;
	const userAddressPreview = selectedTeam && userSlug
		? `${selectedTeam.slug}.${userSlug}@${rootDomain}`
		: selectedTeam
			? `${selectedTeam.slug}.user@${rootDomain}`
			: `team.user@${rootDomain}`;

	const handleCreateTeam = async (event: FormEvent) => {
		event.preventDefault();
		try {
			const created = await createTeam.mutateAsync({
				name: teamName,
				displayName: teamDisplayName,
			});
			setSelectedTeamId(created.id);
			setTeamName("");
			setTeamDisplayName("");
			setSetupUrl(null);
			setSetupExpiresAt(null);
			toastManager.add({ title: `Created ${created.primaryAddress}` });
		} catch (error) {
			toastManager.add({
				title: error instanceof Error ? error.message : "Failed to create team",
				variant: "error",
			});
		}
	};

	const handleCreateUser = async (event: FormEvent) => {
		event.preventDefault();
		if (!selectedTeam) return;
		try {
			const created = await createTeamUser.mutateAsync({
				teamId: selectedTeam.id,
				userName,
				displayName: userDisplayName,
			});
			setUserName("");
			setUserDisplayName("");
			setSetupUrl(created.setupUrl ?? null);
			setSetupExpiresAt(created.setupExpiresAt ?? null);
			toastManager.add({ title: `Created ${created.mailboxAddress}` });
		} catch (error) {
			toastManager.add({
				title: error instanceof Error ? error.message : "Failed to create user",
				variant: "error",
			});
		}
	};

	const handleCopySetupUrl = async () => {
		if (!setupUrl) return;
		try {
			await navigator.clipboard.writeText(setupUrl);
			toastManager.add({ title: "Setup link copied" });
		} catch {
			toastManager.add({ title: "Copy failed — select the link manually", variant: "error" });
		}
	};

	if (whoamiLoading) {
		return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
	}

	if (!isAdmin) {
		return (
			<div className="p-8 max-w-lg mx-auto text-sm text-kumo-default space-y-3">
				<h1 className="text-lg font-semibold flex items-center gap-2">
					<ShieldIcon size={18} weight="fill" /> Admin dashboard
				</h1>
				<p className="text-kumo-subtle">
					You do not have admin access. Existing admins can promote you from the user admin API.
				</p>
				<Button variant="secondary" onClick={() => navigate("/")}>Back</Button>
			</div>
		);
	}

	return (
		<div className="p-6 md:p-8 max-w-6xl mx-auto text-kumo-default space-y-6">
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div>
					<h1 className="text-lg font-semibold flex items-center gap-2">
						<ShieldIcon size={18} weight="fill" /> Admin dashboard
					</h1>
					<p className="mt-1 text-xs text-kumo-subtle">
						Create teams and team users. Addresses are server-derived as <code>team@{rootDomain}</code> and <code>team.user@{rootDomain}</code>.
					</p>
				</div>
				<Button variant="secondary" size="sm" onClick={() => navigate("/")}>Back to app</Button>
			</div>

			{teamsError && (
				<div className="rounded border border-red-400/40 bg-red-500/5 p-3 text-sm text-red-400">
					{teamsError instanceof Error ? teamsError.message : "Failed to load teams"}
				</div>
			)}

			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="mb-4 flex items-center justify-between gap-3">
						<div>
							<h2 className="text-sm font-semibold">Teams</h2>
							<p className="text-xs text-kumo-subtle">Admin-created top-level mailboxes.</p>
						</div>
						<Badge variant="secondary">{teams.length}</Badge>
					</div>
					<form onSubmit={handleCreateTeam} className="mb-5 space-y-3 rounded-lg bg-kumo-recessed p-3">
						<Input
							label="Team name"
							placeholder="finance"
							value={teamName}
							onChange={(e) => setTeamName(e.target.value)}
							required
						/>
						<Input
							label="Display name"
							placeholder="Finance Ops"
							value={teamDisplayName}
							onChange={(e) => setTeamDisplayName(e.target.value)}
							required
						/>
						<div className="flex items-center justify-between gap-3 text-xs text-kumo-subtle">
							<span className="truncate">Preview: <code>{teamAddressPreview}</code></span>
							<Button
								variant="primary"
								size="sm"
								type="submit"
								disabled={!teamSlug || !!teamSlugError || !teamDisplayName.trim()}
								loading={createTeam.isPending}
							>
								Create team
							</Button>
						</div>
						{teamSlugError && <p className="text-xs text-red-400">{teamSlugError}</p>}
					</form>

					{teamsLoading ? (
						<div className="flex justify-center py-8"><Loader size="sm" /></div>
					) : (
						<div className="space-y-2">
							{teams.map((team) => (
								<button
									key={team.id}
									type="button"
									onClick={() => setSelectedTeamId(team.id)}
									className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
										selectedTeam?.id === team.id
											? "border-kumo-primary bg-kumo-tint"
											: "border-kumo-line bg-kumo-base hover:bg-kumo-tint"
									}`}
								>
									<div className="flex items-center justify-between gap-3">
										<span className="text-sm font-medium">{team.displayName}</span>
										<code className="text-xs text-kumo-subtle">{team.primaryAddress}</code>
									</div>
									<div className="text-xs text-kumo-subtle">team: {team.slug}</div>
								</button>
							))}
							{teams.length === 0 && (
								<div className="rounded-lg border border-dashed border-kumo-line p-5 text-center text-xs text-kumo-subtle">
									No teams yet. Create the first team above.
								</div>
							)}
						</div>
					)}
				</section>

				<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="mb-4 flex items-center justify-between gap-3">
						<div>
							<h2 className="text-sm font-semibold flex items-center gap-2">
								<UsersThreeIcon size={16} weight="duotone" /> Team users
							</h2>
							<p className="text-xs text-kumo-subtle">
								{selectedTeam ? `Users under ${selectedTeam.displayName}` : "Select a team first."}
							</p>
						</div>
						<Badge variant="secondary">{teamUsers.length}</Badge>
					</div>

					<form onSubmit={handleCreateUser} className="mb-5 space-y-3 rounded-lg bg-kumo-recessed p-3">
						<Input
							label="User name"
							placeholder="alice"
							value={userName}
							onChange={(e) => setUserName(e.target.value)}
							disabled={!selectedTeam}
							required
						/>
						<Input
							label="Display name"
							placeholder="Alice Zhang"
							value={userDisplayName}
							onChange={(e) => setUserDisplayName(e.target.value)}
							disabled={!selectedTeam}
							required
						/>
						<div className="flex items-center justify-between gap-3 text-xs text-kumo-subtle">
							<span className="truncate">Preview: <code>{userAddressPreview}</code></span>
							<Button
								variant="primary"
								size="sm"
								type="submit"
								disabled={!selectedTeam || !userSlug || !!userSlugError || !userDisplayName.trim()}
								loading={createTeamUser.isPending}
							>
								Create user
							</Button>
						</div>
						{userSlugError && <p className="text-xs text-red-400">{userSlugError}</p>}
						{setupUrl && (
							<div className="rounded-md border border-kumo-line bg-kumo-base p-3">
								<div className="mb-2 text-xs font-medium text-kumo-default">
									One-time setup link
								</div>
								<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
									<Input value={setupUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
									<Button
										variant="secondary"
										size="sm"
										type="button"
										icon={<CopyIcon size={14} />}
										onClick={handleCopySetupUrl}
									>
										Copy
									</Button>
								</div>
								{setupExpiresAt && (
									<p className="mt-1 text-xs text-kumo-subtle">
										Expires {new Date(setupExpiresAt).toLocaleString()}
									</p>
								)}
							</div>
						)}
					</form>

					{usersLoading ? (
						<div className="flex justify-center py-8"><Loader size="sm" /></div>
					) : (
						<div className="overflow-hidden rounded-lg border border-kumo-line">
							<table className="min-w-full text-xs">
								<thead className="bg-kumo-recessed text-[10px] uppercase tracking-wide text-kumo-subtle">
									<tr>
										<th className="px-3 py-2 text-left">User</th>
										<th className="px-3 py-2 text-left">Mailbox</th>
										<th className="px-3 py-2" />
									</tr>
								</thead>
								<tbody>
									{teamUsers.map((user) => (
										<tr key={user.id} className="border-t border-kumo-line">
											<td className="px-3 py-2">
												<div className="font-medium">{user.displayName ?? user.slug}</div>
												<div className="text-kumo-subtle">{user.slug}</div>
											</td>
											<td className="px-3 py-2 font-mono">{user.mailboxAddress}</td>
											<td className="px-3 py-2 text-right">
												<Button variant="ghost" size="xs" onClick={() => navigate(`/mailbox/${user.mailboxAddress}/emails/inbox`)}>
													Open
												</Button>
											</td>
										</tr>
									))}
									{teamUsers.length === 0 && (
										<tr>
											<td className="px-3 py-6 text-center italic text-kumo-subtle" colSpan={3}>
												No team users yet.
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
					)}
				</section>
			</div>

			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="mb-3 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Mailbox directory</h2>
						<p className="text-xs text-kumo-subtle">Team-managed and legacy rows visible to admins.</p>
					</div>
					<Badge variant="secondary">{mailboxes.length}</Badge>
				</div>
				{mailboxesLoading ? (
					<div className="flex justify-center py-8"><Loader size="sm" /></div>
				) : (
					<div className="overflow-x-auto rounded-lg border border-kumo-line bg-kumo-base">
						<table className="min-w-full text-xs">
							<thead className="bg-kumo-recessed text-[10px] uppercase tracking-wide text-kumo-subtle">
								<tr>
									<th className="px-3 py-2 text-left">Mailbox</th>
									<th className="px-3 py-2 text-left">Mode</th>
									<th className="px-3 py-2 text-left">Owner</th>
									<th className="px-3 py-2 text-right">Members</th>
									<th className="px-3 py-2 text-right">Inbox</th>
									<th className="px-3 py-2" />
								</tr>
							</thead>
							<tbody>
								{mailboxes.map((mailbox) => (
									<tr key={mailbox.id} className="border-t border-kumo-line">
										<td className="px-3 py-2 font-mono">{mailbox.email}</td>
										<td className="px-3 py-2">
											{mailbox.team ? (
												<Badge variant="primary">{mailbox.team.kind === "team" ? "team" : "team user"}</Badge>
											) : (
												<Badge variant="secondary">legacy</Badge>
											)}
										</td>
										<td className="px-3 py-2">
											{mailbox.owner ?? <Badge variant="secondary">ownerless</Badge>}
										</td>
										<td className="px-3 py-2 text-right">{mailbox.memberCount}</td>
										<td className="px-3 py-2 text-right">{mailbox.inboxCount ?? "-"}</td>
										<td className="px-3 py-2 text-right">
											<Button variant="ghost" size="xs" onClick={() => navigate(`/mailbox/${mailbox.id}/emails/inbox`)}>
												Open
											</Button>
										</td>
									</tr>
								))}
								{mailboxes.length === 0 && (
									<tr>
										<td className="px-3 py-6 text-center italic text-kumo-subtle" colSpan={6}>
											No mailboxes yet.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
