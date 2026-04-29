// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { LinkIcon, PlugIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { ApiError } from "~/services/api";
import {
	useAddMcpConnection,
	useDeleteMcpConnection,
	useMcpConnections,
	type AddMcpConnectionResult,
	type McpConnectionDto,
} from "~/queries/mcp-connections";

interface ConnectedAppsProps {
	mailboxId: string;
	/** Owner-only mutation gating — non-owners see read-only rows. */
	isOwner: boolean;
}

/**
 * Settings panel for the L4 MCP Client integration.
 *
 * Lists each external MCP server connected to this mailbox, lets the
 * owner add new ones, and surfaces the OAuth-redirect "Authorize"
 * affordance returned by the discriminated `AddMcpConnectionResult`
 * union. When `L4_MCP_ENABLED="false"`, the read endpoint returns an
 * empty list and `feature_disabled` mutations surface a flag-aware
 * notice.
 *
 * Plan reference: §492-570 (L4 Phase 6 — Settings UI + cutover).
 */
export default function ConnectedApps({ mailboxId, isOwner }: ConnectedAppsProps) {
	const toastManager = useKumoToastManager();
	const { data, isLoading, error } = useMcpConnections(mailboxId);
	const addMutation = useAddMcpConnection();
	const deleteMutation = useDeleteMcpConnection();

	const [name, setName] = useState("");
	const [serverUrl, setServerUrl] = useState("");
	const [pendingAuth, setPendingAuth] = useState<{
		connectionId: string;
		authUrl: string;
	} | null>(null);

	const featureDisabled = error instanceof ApiError && error.status === 503;

	const connections: McpConnectionDto[] = data?.connections ?? [];

	const handleAdd = async () => {
		const trimmedName = name.trim();
		const trimmedUrl = serverUrl.trim();
		if (!trimmedName) {
			toastManager.add({ title: "Enter a connection name", variant: "error" });
			return;
		}
		if (!trimmedUrl) {
			toastManager.add({ title: "Enter a server URL", variant: "error" });
			return;
		}
		try {
			const result: AddMcpConnectionResult = await addMutation.mutateAsync({
				mailboxId,
				input: { name: trimmedName, url: trimmedUrl },
			});
			setName("");
			setServerUrl("");
			if (result.state === "authenticating") {
				setPendingAuth({
					connectionId: result.connection.id,
					authUrl: result.authUrl,
				});
				toastManager.add({
					title: "Authorize on the provider to finish connecting",
				});
			} else {
				toastManager.add({ title: `Connected ${result.connection.serverName}` });
			}
		} catch (e) {
			const message =
				e instanceof ApiError && e.status === 503
					? "MCP connections are disabled in this environment"
					: "Failed to add connection";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	const handleDelete = async (conn: McpConnectionDto) => {
		try {
			await deleteMutation.mutateAsync({
				mailboxId,
				connectionId: conn.id,
			});
			if (pendingAuth?.connectionId === conn.id) setPendingAuth(null);
			toastManager.add({ title: `Disconnected ${conn.serverName}` });
		} catch {
			toastManager.add({
				title: "Failed to disconnect",
				variant: "error",
			});
		}
	};

	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-4">
				<PlugIcon size={16} weight="duotone" />
				<span className="text-sm font-medium text-kumo-default">
					Connected apps
				</span>
				{isOwner ? (
					<Badge variant="primary">Owner</Badge>
				) : (
					<Badge variant="secondary">Read-only (member)</Badge>
				)}
			</div>
			<p className="text-xs text-kumo-subtle mb-3">
				Connect external Model Context Protocol servers to make their
				tools available to this mailbox's agent. Only the mailbox owner
				can add or remove connections.
			</p>

			{featureDisabled && (
				<div className="rounded border border-kumo-line bg-kumo-recessed px-3 py-2 mb-3 text-xs text-kumo-subtle">
					External MCP connections are disabled in this environment.
					Contact your administrator to enable the L4 feature flag.
				</div>
			)}

			{isLoading ? (
				<div className="flex justify-center py-4">
					<Loader size="sm" />
				</div>
			) : (
				<ConnectionList
					connections={connections}
					isOwner={isOwner}
					pendingAuth={pendingAuth}
					onDelete={handleDelete}
					isDeleting={deleteMutation.isPending}
				/>
			)}

			{isOwner && !featureDisabled && (
				<AddConnectionForm
					name={name}
					serverUrl={serverUrl}
					onNameChange={setName}
					onUrlChange={setServerUrl}
					onSubmit={handleAdd}
					isSubmitting={addMutation.isPending}
				/>
			)}
		</div>
	);
}

interface ConnectionListProps {
	connections: McpConnectionDto[];
	isOwner: boolean;
	pendingAuth: { connectionId: string; authUrl: string } | null;
	onDelete: (conn: McpConnectionDto) => void;
	isDeleting: boolean;
}

function ConnectionList({
	connections,
	isOwner,
	pendingAuth,
	onDelete,
	isDeleting,
}: ConnectionListProps) {
	if (connections.length === 0) {
		return (
			<div className="text-xs text-kumo-subtle italic px-3 py-2 mb-3">
				No connected apps yet.
			</div>
		);
	}
	return (
		<div className="space-y-2 mb-4">
			{connections.map((c) => (
				<ConnectionRow
					key={c.id}
					connection={c}
					authUrl={
						pendingAuth?.connectionId === c.id ? pendingAuth.authUrl : null
					}
					isOwner={isOwner}
					onDelete={() => onDelete(c)}
					isDeleting={isDeleting}
				/>
			))}
		</div>
	);
}

interface ConnectionRowProps {
	connection: McpConnectionDto;
	authUrl: string | null;
	isOwner: boolean;
	onDelete: () => void;
	isDeleting: boolean;
}

function ConnectionRow({
	connection,
	authUrl,
	isOwner,
	onDelete,
	isDeleting,
}: ConnectionRowProps) {
	const stateBadge = stateBadgeFor(connection.lastState);
	return (
		<div className="flex flex-col gap-2 bg-kumo-recessed px-3 py-2 rounded text-xs text-kumo-default sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium">
						{connection.displayName ?? connection.serverName}
					</span>
					<Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
				</div>
				<div className="text-kumo-subtle truncate">{connection.serverUrl}</div>
				{connection.lastError && (
					<div className="text-kumo-error mt-1 break-words">
						{connection.lastError}
					</div>
				)}
				{authUrl && (
					<a
						href={authUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-1 inline-flex items-center gap-1 text-kumo-link hover:underline"
					>
						<LinkIcon size={12} />
						Authorize on provider
					</a>
				)}
			</div>
			{isOwner && (
				<Button
					variant="ghost"
					size="xs"
					icon={<TrashIcon size={14} />}
					aria-label={`Disconnect ${connection.serverName}`}
					onClick={onDelete}
					loading={isDeleting}
				>
					Disconnect
				</Button>
			)}
		</div>
	);
}

function stateBadgeFor(
	state: McpConnectionDto["lastState"],
): { label: string; variant: "primary" | "secondary" | "success" | "error" } {
	switch (state) {
		case "ready":
			return { label: "ready", variant: "success" };
		case "authenticating":
			return { label: "authenticating", variant: "secondary" };
		case "discovering":
			return { label: "discovering", variant: "secondary" };
		case "error":
			return { label: "error", variant: "error" };
	}
}

interface AddConnectionFormProps {
	name: string;
	serverUrl: string;
	onNameChange: (value: string) => void;
	onUrlChange: (value: string) => void;
	onSubmit: () => void;
	isSubmitting: boolean;
}

function AddConnectionForm({
	name,
	serverUrl,
	onNameChange,
	onUrlChange,
	onSubmit,
	isSubmitting,
}: AddConnectionFormProps) {
	const handleEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") onSubmit();
	};
	return (
		<div className="border-t border-kumo-line pt-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
				<div className="flex-1">
					<Input
						label="Connection name"
						placeholder="e.g. github"
						value={name}
						onChange={(e) => onNameChange(e.target.value)}
						onKeyDown={handleEnter}
					/>
				</div>
				<div className="flex-1">
					<Input
						label="Server URL"
						placeholder="https://mcp.example.com/sse"
						value={serverUrl}
						onChange={(e) => onUrlChange(e.target.value)}
						onKeyDown={handleEnter}
						type="url"
						inputMode="url"
					/>
				</div>
				<Button
					variant="secondary"
					onClick={onSubmit}
					loading={isSubmitting}
					className="self-end"
				>
					Add connection
				</Button>
			</div>
		</div>
	);
}
