// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type AddMcpConnectionInput,
	type AddMcpConnectionResult,
	type McpConnectionDto,
} from "~/services/api";

const QUERY_KEY_PREFIX = "mcp-connections" as const;

/** Query key for the per-mailbox MCP connection list. */
export function mcpConnectionsKey(mailboxId: string) {
	return [QUERY_KEY_PREFIX, mailboxId] as const;
}

export function useMcpConnections(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId
			? mcpConnectionsKey(mailboxId)
			: [QUERY_KEY_PREFIX, "_disabled"],
		queryFn: () => api.listMcpConnections(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useAddMcpConnection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			input,
		}: {
			mailboxId: string;
			input: AddMcpConnectionInput;
		}): Promise<AddMcpConnectionResult> =>
			api.addMcpConnection(mailboxId, input),
		onSuccess: (_data, { mailboxId }) =>
			qc.invalidateQueries({ queryKey: mcpConnectionsKey(mailboxId) }),
	});
}

export function useDeleteMcpConnection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			connectionId,
		}: {
			mailboxId: string;
			connectionId: string;
		}) => api.deleteMcpConnection(mailboxId, connectionId),
		onSuccess: (_data, { mailboxId }) =>
			qc.invalidateQueries({ queryKey: mcpConnectionsKey(mailboxId) }),
	});
}

export type { AddMcpConnectionInput, McpConnectionDto, AddMcpConnectionResult };
