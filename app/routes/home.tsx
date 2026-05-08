// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader } from "@cloudflare/kumo";
import { EnvelopeIcon, ShieldIcon } from "@phosphor-icons/react";
import { Link as RouterLink, useNavigate } from "react-router";
import { useWhoami } from "~/queries/identity";
import { useMailboxes } from "~/queries/mailboxes";

export function meta() {
	return [{ title: "Agentic Inbox" }];
}

export default function HomeRoute() {
	const navigate = useNavigate();
	const { data: mailboxes = [], isLoading } = useMailboxes();
	const { data: whoami } = useWhoami();
	const isAdmin = !!whoami?.isAdmin;

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
				) : mailboxes.length > 0 ? (
					<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{mailboxes.map((mailbox, idx) => (
							<RouterLink
								key={mailbox.id}
								to={`/mailbox/${mailbox.id}`}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{mailbox.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 text-sm font-medium text-kumo-default">
										<span className="truncate">{mailbox.name}</span>
										{mailbox.team && (
											<Badge variant="secondary">
												{mailbox.team.kind === "team" ? "team" : "user"}
											</Badge>
										)}
									</div>
									<div className="truncate text-sm text-kumo-subtle">
										{mailbox.email}
									</div>
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
