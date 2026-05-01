// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Empty, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ShieldCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
	useAdminLegacyInboxes,
	useAssignInboxOwner,
} from "~/queries/mailboxes";
import { ApiError } from "~/services/api";
import type { AdminInboxOwnershipSummary } from "~/types";

export function meta() {
	return [{ title: "Admin Legacy Inboxes - Agentic Inbox" }];
}

type RowFormState = Record<string, { ownerEmail: string; subname: string }>;

function defaultSubname(inbox: AdminInboxOwnershipSummary): string {
	if (inbox.userOwnedInbox?.subname) return inbox.userOwnedInbox.subname;
	const local = inbox.email.split("@")[0] ?? inbox.email;
	const withoutUsername = local.includes(".") ? local.split(".").pop() || local : local;
	return withoutUsername
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32) || "legacy";
}

function defaultOwner(inbox: AdminInboxOwnershipSummary): string {
	return inbox.userOwnedInbox?.ownerEmail ?? "";
}

function errorMessage(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return "Unexpected error";
}

export default function AdminLegacyInboxesRoute() {
	const toastManager = useKumoToastManager();
	const [includeOwned, setIncludeOwned] = useState(false);
	const { data, isLoading, error, refetch } = useAdminLegacyInboxes(includeOwned);
	const assignOwner = useAssignInboxOwner();
	const [forms, setForms] = useState<RowFormState>({});
	const [savingId, setSavingId] = useState<string | null>(null);
	const [lastAssigned, setLastAssigned] = useState<{ email: string; ownerEmail: string } | null>(null);

	useEffect(() => {
		if (!data?.inboxes) return;
		setForms((current) => {
			const next = { ...current };
			for (const inbox of data.inboxes) {
				if (next[inbox.id]) continue;
				next[inbox.id] = {
					ownerEmail: defaultOwner(inbox),
					subname: defaultSubname(inbox),
				};
			}
			return next;
		});
	}, [data]);

	const updateForm = (id: string, field: "ownerEmail" | "subname", value: string) => {
		setForms((current) => ({
			...current,
			[id]: { ...(current[id] ?? { ownerEmail: "", subname: "" }), [field]: value },
		}));
	};

	const handleAssign = async (inbox: AdminInboxOwnershipSummary) => {
		const form = forms[inbox.id] ?? { ownerEmail: "", subname: "" };
		const ownerEmail = form.ownerEmail.trim().toLowerCase();
		const subname = form.subname.trim().toLowerCase();
		if (!ownerEmail || !subname) {
			toastManager.add({ title: "Owner email and subname are required", variant: "error" });
			return;
		}
		const isReplacement = Boolean(inbox.userOwnedInbox);
		const message = isReplacement
			? `Replace owner for ${inbox.email}?\n\nPrevious owner: ${inbox.userOwnedInbox?.ownerEmail}\nNext owner: ${ownerEmail}\n\nThis changes who can see and configure this inbox.`
			: `Assign ${inbox.email} to ${ownerEmail}?`;
		if (!window.confirm(message)) return;

		setSavingId(inbox.id);
		try {
			const result = await assignOwner.mutateAsync({
				mailboxId: inbox.id,
				includeOwned,
				body: {
					ownerEmail,
					subname,
					expectedEtag: inbox.etag,
					confirmReplacement: isReplacement,
				},
			});
			setLastAssigned({ email: result.email, ownerEmail });
			toastManager.add({
				title: result.action === "replace" ? "Owner replaced" : "Owner assigned",
			});
			await refetch();
		} catch (e) {
			toastManager.add({ title: errorMessage(e), variant: "error" });
		} finally {
			setSavingId(null);
		}
	};

	const inboxes = data?.inboxes ?? [];
	const unauthorized = error instanceof ApiError && error.status === 403;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-12">
				<div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
					<div>
						<div className="flex items-center gap-2">
							<ShieldCheckIcon size={22} weight="duotone" className="text-kumo-subtle" />
							<h1 className="text-2xl font-bold text-kumo-default">Legacy Inbox Ownership</h1>
						</div>
						<p className="mt-2 max-w-2xl text-sm text-kumo-subtle">
							Assign explicit owners to legacy inboxes so their settings can use
							structured Agent, Tools, and Safety controls. Existing addresses,
							emails, attachments, and agent configuration are preserved.
						</p>
					</div>
					<div className="flex gap-2">
						<Button
							variant={includeOwned ? "primary" : "secondary"}
							onClick={() => setIncludeOwned((value) => !value)}
						>
							{includeOwned ? "Showing owned" : "Show owned"}
						</Button>
						<Button
							variant="ghost"
							icon={<ArrowCounterClockwiseIcon size={16} />}
							onClick={() => refetch()}
						>
							Refresh
						</Button>
					</div>
				</div>

				{lastAssigned && (
					<div className="mb-5 rounded-lg border border-kumo-line bg-kumo-base p-4 text-sm text-kumo-default">
						Ownership saved for <span className="font-medium">{lastAssigned.email}</span>.
						<span className="text-kumo-subtle"> The assigned owner is {lastAssigned.ownerEmail}.</span>{" "}
						<RouterLink className="text-kumo-link no-underline hover:underline" to={`/mailbox/${lastAssigned.email}/settings`}>
							Open settings
						</RouterLink>
					</div>
				)}

				{isLoading ? (
					<div className="flex justify-center py-20"><Loader size="lg" /></div>
				) : unauthorized ? (
					<Empty
						icon={<WarningIcon size={48} className="text-kumo-inactive" />}
						title="Admin access required"
						description="Your verified identity is not listed in ADMINS for this deployment."
					/>
				) : error ? (
					<Empty
						icon={<WarningIcon size={48} className="text-kumo-inactive" />}
						title="Failed to load admin inboxes"
						description={errorMessage(error)}
					/>
				) : inboxes.length === 0 ? (
					<Empty
						title={includeOwned ? "No inboxes found" : "No legacy inboxes found"}
						description={includeOwned ? "There are no mailbox settings to show." : "Every listed mailbox already has owner metadata, or no legacy inboxes exist."}
					/>
				) : (
					<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
						{inboxes.map((inbox, index) => {
							const form = forms[inbox.id] ?? { ownerEmail: "", subname: "" };
							const isReplacement = Boolean(inbox.userOwnedInbox);
							return (
								<div key={inbox.id} className={`p-5 ${index > 0 ? "border-t border-kumo-line" : ""}`}>
									<div className="mb-4 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<h2 className="truncate text-sm font-semibold text-kumo-default">{inbox.displayName}</h2>
												<Badge variant={isReplacement ? "secondary" : "destructive"}>{isReplacement ? "Owned" : "Legacy"}</Badge>
											</div>
											<p className="mt-1 break-all text-sm text-kumo-subtle">{inbox.email}</p>
											{inbox.userOwnedInbox && (
												<p className="mt-1 text-xs text-kumo-subtle">
													Current owner: {inbox.userOwnedInbox.ownerEmail} · {inbox.userOwnedInbox.username}.{inbox.userOwnedInbox.subname}
												</p>
											)}
										</div>
										<RouterLink className="text-sm text-kumo-link no-underline hover:underline" to={`/mailbox/${inbox.email}/settings`}>
											Open settings
										</RouterLink>
									</div>

									<div className="grid gap-3 md:grid-cols-[1fr_220px_auto] md:items-end">
										<div>
											<label className="mb-1 block text-xs font-medium text-kumo-subtle">Owner email</label>
											<Input
												value={form.ownerEmail}
												onChange={(e) => updateForm(inbox.id, "ownerEmail", e.target.value)}
												placeholder="owner@example.com"
											/>
										</div>
										<div>
											<label className="mb-1 block text-xs font-medium text-kumo-subtle">Logical subname</label>
											<Input
												value={form.subname}
												onChange={(e) => updateForm(inbox.id, "subname", e.target.value)}
												placeholder="support"
											/>
										</div>
										<Button
											variant={isReplacement ? "destructive" : "primary"}
											disabled={savingId === inbox.id}
											onClick={() => handleAssign(inbox)}
										>
											{savingId === inbox.id ? "Saving..." : isReplacement ? "Replace owner" : "Assign owner"}
										</Button>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
