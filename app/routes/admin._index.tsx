// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Loader } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { queryKeys } from "~/queries/keys";
import { useAdminTeams } from "~/queries/teams";
import api from "~/services/api";

type AdminMailbox = Awaited<ReturnType<typeof api.adminListMailboxes>>[number];

const sectionLinks = [
	{ label: "Teams", to: "/admin/teams", description: "Create and manage team mailboxes." },
	{ label: "Team Users", to: "/admin/team-users", description: "Manage people under each team." },
	{ label: "Mailboxes", to: "/admin/mailboxes", description: "Audit every mailbox and owner." },
	{ label: "Users", to: "/admin/users", description: "Review users and admin roles." },
	{ label: "LLM Providers", to: "/admin/llm-providers", description: "Configure model providers." },
];

function useAdminMailboxes() {
	return useQuery<AdminMailbox[]>({
		queryKey: queryKeys.adminMailboxes,
		queryFn: () => api.adminListMailboxes(),
	});
}

export default function AdminOverviewRoute() {
	const { data: teams = [], isLoading: teamsLoading } = useAdminTeams(true);
	const { data: mailboxes = [], isLoading: mailboxesLoading } = useAdminMailboxes();
	const ownerlessMailboxes = mailboxes.filter((mailbox) => !mailbox.team && mailbox.owner === null);
	const isLoading = teamsLoading || mailboxesLoading;

	if (isLoading) {
		return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-lg font-semibold">Admin overview</h1>
				<p className="mt-1 text-sm text-kumo-subtle">
					Monitor teams, mailboxes, users, and model provider configuration from one console.
				</p>
			</div>

			<div className="grid gap-4 md:grid-cols-3">
				<MetricCard label="Teams" value={teams.length} helper="Top-level team mailboxes" />
				<MetricCard label="Mailboxes" value={mailboxes.length} helper="Visible to admins" />
				<MetricCard label="Ownerless" value={ownerlessMailboxes.length} helper="Legacy mailboxes needing review" />
			</div>

			{mailboxes.length > 0 && ownerlessMailboxes.length > 0 && (
				<div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-kumo-default">
					<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
						<div className="flex gap-3">
							<WarningIcon className="mt-0.5 shrink-0 text-amber-500" size={18} weight="fill" />
							<div>
								<div className="font-medium">Ownerless legacy mailboxes need attention</div>
								<p className="mt-1 text-xs text-kumo-subtle">
									{ownerlessMailboxes.length} mailbox{ownerlessMailboxes.length === 1 ? "" : "es"} do not have an owner assigned.
								</p>
							</div>
						</div>
						<Link
							to="/admin/mailboxes?ownerless=true"
							className="inline-flex items-center justify-center rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-xs font-medium hover:bg-kumo-tint"
						>
							Review mailboxes
						</Link>
					</div>
				</div>
			)}

			<section className="hidden rounded-xl border border-kumo-line bg-kumo-base p-5 md:block">
				<div className="mb-4 flex items-center justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Admin sections</h2>
						<p className="text-xs text-kumo-subtle">Jump directly to a focused management area.</p>
					</div>
					<Badge variant="secondary">{sectionLinks.length}</Badge>
				</div>
				<div className="grid gap-3 lg:grid-cols-2">
					{sectionLinks.map((item) => <SectionLink key={item.to} {...item} />)}
				</div>
			</section>

			<div className="space-y-3 md:hidden">
				{sectionLinks.map((item) => <SectionLink key={item.to} {...item} />)}
			</div>
		</div>
	);
}

function MetricCard({ label, value, helper }: { label: string; value: number; helper: string }) {
	return (
		<div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
			<div className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">{label}</div>
			<div className="mt-3 text-3xl font-semibold">{value}</div>
			<div className="mt-1 text-xs text-kumo-subtle">{helper}</div>
		</div>
	);
}

function SectionLink({ label, to, description }: { label: string; to: string; description: string }) {
	return (
		<Link to={to} className="block rounded-xl border border-kumo-line bg-kumo-base p-4 transition-colors hover:bg-kumo-tint">
			<div className="flex items-center justify-between gap-3">
				<div className="text-sm font-medium">{label}</div>
				<span className="text-xs text-kumo-subtle">Open</span>
			</div>
			<p className="mt-1 text-xs text-kumo-subtle">{description}</p>
		</Link>
	);
}
