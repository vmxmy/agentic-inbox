// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Empty,
	Input,
	Loader,
	Text,
	Tooltip,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { CheckIcon, CopyIcon, EnvelopeIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import api from "~/services/api";
import {
	useCreateInbox,
	useCreateMailbox,
	useDeleteMailbox,
	useInboxNamespace,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";

export function meta() {
	return [{ title: "Agentic Inbox" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const { data: mailboxes = [], refetch: refetchMailboxes, isFetched: mailboxesFetched } = useMailboxes();
	const createInbox = useCreateInbox();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];
	const isConfigured = emailAddresses.length > 0;
	const { data: inboxNamespace, isLoading: isInboxNamespaceLoading } =
		useInboxNamespace(!isConfigured && Boolean(configData));

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newSubname, setNewSubname] = useState("");
	const [newDisplayName, setNewDisplayName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

	// Auto-create mailboxes from config (run once when both data sources are ready)
	const autoCreateDone = useRef(false);
	useEffect(() => {
		if (autoCreateDone.current) return;
		if (emailAddresses.length === 0 || !mailboxesFetched) return;
		const existingEmails = new Set(
			mailboxes.map((m) => m.email.toLowerCase()),
		);
		const toCreate = emailAddresses.filter(
			(addr) => !existingEmails.has(addr.toLowerCase()),
		);
		if (toCreate.length === 0) {
			autoCreateDone.current = true;
			return;
		}
		autoCreateDone.current = true;
		let cancelled = false;
		Promise.all(
			toCreate.map((addr) => {
				const localPart = addr.split("@")[0] || addr;
				return api.createMailbox(addr, localPart).catch(() => {});
			}),
		).then(() => { if (!cancelled) refetchMailboxes(); });
		return () => { cancelled = true; };
	}, [emailAddresses, mailboxes, mailboxesFetched, refetchMailboxes]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		if (!newDisplayName.trim() || !newSubname.trim()) {
			setCreateError("Please enter a display name and address name");
			return;
		}
		setIsCreating(true);
		try {
			await createInbox.mutateAsync({
				displayName: newDisplayName.trim(),
				subname: newSubname.trim(),
			});
			toastManager.add({ title: "AI inbox created successfully!" });
			setIsCreateOpen(false);
			setNewSubname("");
			setNewDisplayName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create AI inbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "AI inbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete AI inbox", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const handleCopyEmail = async (email: string) => {
		try {
			await navigator.clipboard.writeText(email);
			setCopiedEmail(email);
			toastManager.add({ title: "Email address copied" });
			window.setTimeout(() => {
				setCopiedEmail((current) => current === email ? null : current);
			}, 2000);
		} catch {
			toastManager.add({ title: "Failed to copy email address", variant: "error" });
		}
	};

	const accounts = isConfigured
		? emailAddresses.map((addr) => ({
				id: addr,
				email: addr,
				name: addr.split("@")[0] || addr,
			}))
		: mailboxes;

	const normalizedSubname = newSubname.trim().toLowerCase();
	const previewUsername = inboxNamespace?.username ?? "username";
	const previewDomain = inboxNamespace?.rootDomain ?? domains[0] ?? "example.com";
	const previewSubname = normalizedSubname || "subname";
	const generatedAddressPreview = `${previewUsername}.${previewSubname}@${previewDomain}`;

	const isLoading = !configData || (!isConfigured && isInboxNamespaceLoading);

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">AI Inboxes</h1>
						{!isConfigured && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => setIsCreateOpen(true)}
							>
								New AI Inbox
							</Button>
						)}
					</div>
					{domains.length > 0 && (
						<p className="text-sm text-kumo-subtle mt-1">
							{domains.join(", ")}
						</p>
					)}
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : accounts.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{accounts.map((account, idx) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-kumo-default truncate">
										{account.name}
									</div>
									<div className="text-sm text-kumo-subtle truncate">
										{account.email}
									</div>
								</div>
								<Tooltip content={copiedEmail === account.email ? "Copied!" : "Copy email"} asChild>
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={copiedEmail === account.email
											? <CheckIcon size={16} weight="bold" className="text-kumo-success" />
											: <CopyIcon size={16} />}
										aria-label={`Copy email address ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											void handleCopyEmail(account.email);
										}}
									/>
								</Tooltip>
								{!isConfigured && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete AI inbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No AI inboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "Your email routing is configured but no AI inboxes have been created yet. They will appear here automatically."
									: "Create an AI inbox to give a workstream its own email address, memory, and agent context."}
							</p>
							{!isConfigured && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => setIsCreateOpen(true)}
								>
									Create AI Inbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						Create New AI Inbox
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						<Input
							label="Display Name"
							placeholder="Reimbursements"
							size="sm"
							value={newDisplayName}
							onChange={(e) => setNewDisplayName(e.target.value)}
							required
						/>
						<Input
							label="Address Name"
							placeholder="reimburse"
							size="sm"
							value={newSubname}
							onChange={(e) => setNewSubname(e.target.value)}
							required
						/>
						<div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2">
							<p className="text-sm text-kumo-subtle">
								Generated email address
							</p>
							<div className="mt-1 flex items-center gap-2">
								<div className="min-w-0 flex-1 break-all font-mono text-sm text-kumo-default">
									{generatedAddressPreview}
								</div>
								<Tooltip content={copiedEmail === generatedAddressPreview ? "Copied!" : "Copy email"} asChild>
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={copiedEmail === generatedAddressPreview
											? <CheckIcon size={16} weight="bold" className="text-kumo-success" />
											: <CopyIcon size={16} />}
										aria-label="Copy generated email address"
										onClick={() => void handleCopyEmail(generatedAddressPreview)}
									/>
								</Tooltip>
							</div>
						</div>
						<p className="text-sm text-kumo-subtle">
							Use lowercase letters, numbers, and hyphens. The username and
							root domain come from your verified login and system config.
						</p>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={!newDisplayName.trim() || !newSubname.trim()}
							>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete AI Inbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
