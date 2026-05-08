// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import { ShieldIcon } from "@phosphor-icons/react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { useWhoami } from "~/queries/identity";

const adminNavItems = [
	{ label: "Overview", to: "/admin", exact: true },
	{ label: "Teams", to: "/admin/teams" },
	{ label: "Team Users", to: "/admin/team-users" },
	{ label: "Mailboxes", to: "/admin/mailboxes" },
	{ label: "Users", to: "/admin/users" },
	{ label: "LLM Providers", to: "/admin/llm-providers" },
];

function isActivePath(pathname: string, item: (typeof adminNavItems)[number]) {
	return item.exact ? pathname === item.to : pathname.startsWith(item.to);
}

export default function AdminRoute() {
	const navigate = useNavigate();
	const location = useLocation();
	const { data: whoami, isLoading: whoamiLoading } = useWhoami();
	const isAdmin = !!whoami?.isAdmin;

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
		<div className="min-h-screen bg-kumo-recessed text-kumo-default">
			<div className="mx-auto flex w-full max-w-7xl md:flex-row">
				<aside className="hidden w-56 shrink-0 border-r border-kumo-line bg-kumo-base px-4 py-6 md:block">
					<div className="mb-6 flex items-center gap-2 text-sm font-semibold">
						<ShieldIcon size={18} weight="fill" /> Admin console
					</div>
					<nav className="space-y-1" aria-label="Admin sections">
						{adminNavItems.map((item) => {
							const active = isActivePath(location.pathname, item);
							return (
								<Link
									key={item.to}
									to={item.to}
									className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
										active
											? "bg-kumo-tint text-kumo-default font-medium"
											: "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
									}`}
								>
									{item.label}
								</Link>
							);
						})}
					</nav>
					<Button className="mt-6 w-full" variant="secondary" size="sm" onClick={() => navigate("/")}>Back to app</Button>
				</aside>
				<main className="min-w-0 flex-1 p-4 md:p-8">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
