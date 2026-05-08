// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import { CaretRightIcon, EnvelopeIcon, ShieldIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { useWhoami } from "~/queries/identity";
import { useMailboxes } from "~/queries/mailboxes";
import type { Mailbox } from "~/types";

const STORAGE_KEY = "mailbox-groups-expanded";

function loadExpandedGroups(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return new Set(JSON.parse(raw) as string[]);
	} catch {}
	return new Set();
}

type MailboxGroup = {
	teamId: string;
	teamDisplayName: string;
	teamMailbox: Mailbox | null;
	userMailboxes: Mailbox[];
};

export function meta() {
	return [{ title: "Agentic Inbox" }];
}

export default function HomeRoute() {
	const navigate = useNavigate();
	const { data: mailboxes = [], isLoading } = useMailboxes();
	const { data: whoami } = useWhoami();
	const isAdmin = !!whoami?.isAdmin;

	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(loadExpandedGroups);

	const { groups, ungrouped } = useMemo(() => {
		const groupMap = new Map<string, MailboxGroup>();
		const ungrouped: Mailbox[] = [];

		for (const mailbox of mailboxes) {
			if (!mailbox.team) {
				ungrouped.push(mailbox);
				continue;
			}
			const { id, displayName, kind } = mailbox.team;
			if (!groupMap.has(id)) {
				groupMap.set(id, { teamId: id, teamDisplayName: displayName, teamMailbox: null, userMailboxes: [] });
			}
			const group = groupMap.get(id)!;
			if (kind === "team") {
				group.teamMailbox = mailbox;
			} else {
				group.userMailboxes.push(mailbox);
			}
		}

		for (const group of groupMap.values()) {
			group.userMailboxes.sort((a, b) => a.name.localeCompare(b.name));
		}

		return { groups: [...groupMap.values()], ungrouped };
	}, [mailboxes]);

	const toggleGroup = (teamId: string) => {
		setExpandedGroups(prev => {
			const next = new Set(prev);
			if (next.has(teamId)) {
				next.delete(teamId);
			} else {
				next.add(teamId);
			}
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
			} catch {}
			return next;
		});
	};

	const hasAnyMailboxes = groups.length > 0 || ungrouped.length > 0;

	return (
		<div className="min-h-screen min-h-[100dvh] bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8 flex items-center justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
						<p className="mt-1 text-sm text-kumo-subtle">
							Mailboxes are created by admins through teams and team users.
						</p>
					</div>
					{isAdmin && (
						<Button
							variant="secondary"
							icon={<ShieldIcon size={16} weight="fill" />}
							onClick={() => navigate("/admin")}
						>
							Admin
						</Button>
					)}
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : hasAnyMailboxes ? (
					<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{groups.map((group, groupIdx) => {
							const isExpanded = expandedGroups.has(group.teamId);
							const hasChildren = group.userMailboxes.length > 0;
							return (
								<div key={group.teamId} className={groupIdx > 0 ? "border-t border-kumo-line" : ""}>
									{/* Team header row */}
									<div className="flex items-center">
										<button
											type="button"
											onClick={() => toggleGroup(group.teamId)}
											className="flex shrink-0 items-center self-stretch px-3 bg-transparent border-0 cursor-pointer text-kumo-subtle hover:text-kumo-default transition-colors"
											aria-label={isExpanded ? "Collapse" : "Expand"}
										>
											<CaretRightIcon
												size={14}
												className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""} ${!hasChildren ? "opacity-0 pointer-events-none" : ""}`}
											/>
										</button>
										{group.teamMailbox ? (
											<RouterLink
												to={`/mailbox/${group.teamMailbox.id}`}
												className="flex flex-1 items-center gap-4 pr-5 py-4 no-underline transition-colors hover:bg-kumo-tint"
											>
												<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
													{group.teamDisplayName.charAt(0).toUpperCase()}
												</div>
												<div className="min-w-0 flex-1">
													<div className="text-sm font-semibold text-kumo-default truncate">{group.teamDisplayName}</div>
													<div className="text-sm text-kumo-subtle truncate">{group.teamMailbox.email}</div>
												</div>
												{hasChildren && (
													<span className="shrink-0 text-xs text-kumo-subtle">{group.userMailboxes.length}</span>
												)}
											</RouterLink>
										) : (
											<div className="flex flex-1 items-center gap-4 pr-5 py-4">
												<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
													{group.teamDisplayName.charAt(0).toUpperCase()}
												</div>
												<div className="min-w-0 flex-1 text-sm font-semibold text-kumo-default truncate">
													{group.teamDisplayName}
												</div>
												{hasChildren && (
													<span className="shrink-0 text-xs text-kumo-subtle">{group.userMailboxes.length}</span>
												)}
											</div>
										)}
									</div>

									{/* User mailboxes */}
									{isExpanded && group.userMailboxes.map((mailbox) => (
										<RouterLink
											key={mailbox.id}
											to={`/mailbox/${mailbox.id}`}
											className="flex items-center gap-4 border-t border-kumo-line bg-kumo-recessed py-3 pr-5 pl-10 no-underline transition-colors hover:bg-kumo-tint"
										>
											<div className="min-w-0 flex-1">
												<div className="text-sm font-medium text-kumo-default truncate">{mailbox.name}</div>
												<div className="text-xs text-kumo-subtle truncate">{mailbox.email}</div>
											</div>
										</RouterLink>
									))}
								</div>
							);
						})}

						{/* Ungrouped (legacy) mailboxes */}
						{ungrouped.map((mailbox, idx) => (
							<RouterLink
								key={mailbox.id}
								to={`/mailbox/${mailbox.id}`}
								className={`flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									groups.length > 0 || idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{mailbox.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-kumo-default truncate">{mailbox.name}</div>
									<div className="text-sm text-kumo-subtle truncate">{mailbox.email}</div>
								</div>
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base px-6 py-16">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon size={48} weight="thin" className="text-kumo-subtle" />
							</div>
							<h3 className="mb-1.5 text-base font-semibold text-kumo-default">
								No mailboxes yet
							</h3>
							<p className="mb-5 max-w-sm text-sm text-kumo-subtle">
								Ask an admin to create your team user. Your address will be derived as <code>team.user@domain</code>.
							</p>
							{isAdmin && (
								<Button
									variant="primary"
									icon={<ShieldIcon size={16} weight="fill" />}
									onClick={() => navigate("/admin")}
								>
									Create team
								</Button>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
