// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { CheckIcon, PencilSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { useWhoami } from "~/queries/identity";
import { queryKeys } from "~/queries/keys";
import { useAdminTeams, useCreateTeam, useUpdateTeam } from "~/queries/teams";
import api from "~/services/api";
import type { Team } from "~/types";

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

export default function AdminTeamsRoute() {
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
	const createTeam = useCreateTeam();
	const updateTeam = useUpdateTeam();
	const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
	const [editingDisplayName, setEditingDisplayName] = useState("");
	const [teamName, setTeamName] = useState("");
	const [teamDisplayName, setTeamDisplayName] = useState("");
	const [aiInboxEnabled, setAiInboxEnabled] = useState(true);
	const teamSlug = previewSlug(teamName);
	const teamSlugError = slugValidationError(teamSlug);
	const teamAddressPreview = teamSlug ? `${teamSlug}@${rootDomain}` : `team@${rootDomain}`;

	const handleCreateTeam = async (event: FormEvent) => {
		event.preventDefault();
		try {
			const created = await createTeam.mutateAsync({ name: teamName, displayName: teamDisplayName });
			setTeamName("");
			setTeamDisplayName("");
			setAiInboxEnabled(true);
			toastManager.add({ title: `Created ${created.primaryAddress}` });
		} catch (error) {
			toastManager.add({
				title: error instanceof Error ? error.message : "Failed to create team",
				variant: "error",
			});
		}
	};

	const handleToggleTeam = async (team: Team) => {
		const nextDisabled = !team.disabledAt;
		try {
			await updateTeam.mutateAsync({ teamId: team.id, body: { disabled: nextDisabled } });
			toastManager.add({ title: `${nextDisabled ? "Disabled" : "Enabled"} ${team.displayName}` });
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to update team", variant: "error" });
		}
	};

	const handleStartTeamEdit = (team: Team) => {
		setEditingTeamId(team.id);
		setEditingDisplayName(team.displayName);
	};

	const handleSaveTeamEdit = async () => {
		if (!editingTeamId || !editingDisplayName.trim()) return;
		try {
			await updateTeam.mutateAsync({ teamId: editingTeamId, body: { displayName: editingDisplayName.trim() } });
			toastManager.add({ title: "Team name updated" });
			setEditingTeamId(null);
		} catch (error) {
			toastManager.add({ title: error instanceof Error ? error.message : "Failed to update team", variant: "error" });
		}
	};

	const handleCancelTeamEdit = () => setEditingTeamId(null);

	return (
		<div className="space-y-6 text-kumo-default">
			<div>
				<h1 className="text-lg font-semibold">Teams</h1>
				<p className="mt-1 text-sm text-kumo-subtle">Create and review admin-managed top-level mailboxes.</p>
			</div>

			{teamsError && (
				<div className="rounded border border-red-400/40 bg-red-500/5 p-3 text-sm text-red-400">
					{teamsError instanceof Error ? teamsError.message : "Failed to load teams"}
				</div>
			)}

			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
				<div className="mb-4 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Create team</h2>
						<p className="text-xs text-kumo-subtle">Addresses are server-derived as <code>team@{rootDomain}</code>.</p>
					</div>
					<Badge variant="secondary">{teams.length}</Badge>
				</div>
				<form onSubmit={handleCreateTeam} className="mb-5 space-y-3 rounded-lg bg-kumo-recessed p-3">
					<Input label="Team name" placeholder="finance" value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
					<Input label="Display name" placeholder="Finance Ops" value={teamDisplayName} onChange={(e) => setTeamDisplayName(e.target.value)} required />
					<label className="flex items-start gap-2 rounded-md border border-kumo-line bg-kumo-base p-3 text-xs text-kumo-subtle">
						<input type="checkbox" className="mt-0.5" checked={aiInboxEnabled} onChange={(e) => setAiInboxEnabled(e.target.checked)} />
						<span><span className="font-medium text-kumo-default">AI inbox</span> provision a mailbox for this team.</span>
					</label>
					<div className="flex items-center justify-between gap-3 text-xs text-kumo-subtle">
						<span className="truncate">Preview: <code>{teamAddressPreview}</code></span>
						<Button variant="primary" size="sm" type="submit" disabled={!teamSlug || !!teamSlugError || !teamDisplayName.trim() || !aiInboxEnabled} loading={createTeam.isPending}>Create team</Button>
					</div>
					{teamSlugError && <p className="text-xs text-red-400">{teamSlugError}</p>}
					{!aiInboxEnabled && <p className="text-xs text-red-400">Team creation currently requires an AI inbox.</p>}
				</form>

				{teamsLoading ? (
					<div className="flex justify-center py-8"><Loader size="sm" /></div>
				) : (
					<div className="space-y-2">
						{teams.map((team) => (
							<div key={team.id} className={`rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 transition-colors hover:bg-kumo-tint ${team.disabledAt ? "opacity-70" : ""}`}>
								<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
									{editingTeamId === team.id ? (
										<div className="flex flex-1 items-center gap-2 min-w-0">
											<Input
												value={editingDisplayName}
												onChange={(e) => setEditingDisplayName(e.target.value)}
												onKeyDown={(e) => { if (e.key === "Enter") void handleSaveTeamEdit(); if (e.key === "Escape") handleCancelTeamEdit(); }}
												autoFocus
											/>
											<Button size="xs" variant="primary" shape="square" type="button" icon={<CheckIcon size={12} weight="bold" />} onClick={() => void handleSaveTeamEdit()} loading={updateTeam.isPending} />
											<Button size="xs" variant="ghost" shape="square" type="button" icon={<XIcon size={12} />} onClick={handleCancelTeamEdit} />
										</div>
									) : (
										<div className="group flex min-w-0 flex-1 items-start gap-1">
											<Link to={`/admin/team-users?teamId=${encodeURIComponent(team.id)}`} className="min-w-0 flex-1 text-left">
												<div className="flex flex-wrap items-center gap-2">
													<span className="text-sm font-medium">{team.displayName}</span>
													{team.disabledAt && <Badge variant="destructive">Disabled</Badge>}
												</div>
												<code className="block truncate text-xs text-kumo-subtle">{team.primaryAddress}</code>
												<div className="text-xs text-kumo-subtle">team: {team.slug}</div>
											</Link>
											<Button size="xs" variant="ghost" shape="square" type="button" icon={<PencilSimpleIcon size={12} />} onClick={() => handleStartTeamEdit(team)} />
										</div>
									)}
									<Button variant={team.disabledAt ? "secondary" : "ghost"} size="xs" type="button" onClick={() => handleToggleTeam(team)} loading={updateTeam.isPending && editingTeamId === null}>{team.disabledAt ? "Enable" : "Disable"}</Button>
								</div>
							</div>
						))}
						{teams.length === 0 && <div className="rounded-lg border border-dashed border-kumo-line p-5 text-center text-xs text-kumo-subtle">No teams yet. Create the first team above.</div>}
					</div>
				)}
			</section>
		</div>
	);
}
