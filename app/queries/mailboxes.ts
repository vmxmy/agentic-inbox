// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type {
	AdminLegacyInboxesResponse,
	AssignInboxOwnerRequest,
	AssignInboxOwnerResponse,
	InboxAgentConfigOptions,
	InboxAgentConfigPatch,
	InboxAgentConfigResponse,
	InboxNamespace,
	Mailbox,
} from "~/types";
import { queryKeys } from "./keys";

export function useMailboxes() {
	return useQuery<Mailbox[]>({
		queryKey: queryKeys.mailboxes.all,
		queryFn: () => api.listMailboxes() as Promise<Mailbox[]>,
	});
}

export function useMailbox(mailboxId: string | undefined) {
	return useQuery<Mailbox>({
		queryKey: mailboxId
			? queryKeys.mailboxes.detail(mailboxId)
			: ["mailboxes", "_disabled"],
		queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
		enabled: !!mailboxId,
	});
}

export function useInboxNamespace(enabled: boolean) {
	return useQuery<InboxNamespace>({
		queryKey: queryKeys.inboxes.namespace,
		queryFn: () => api.getInboxNamespace(),
		enabled,
	});
}

export function useCreateInbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			displayName,
			subname,
		}: { displayName: string; subname: string }) =>
			api.createInbox(displayName, subname),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useCreateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name }: { email: string; name: string }) =>
			api.createMailbox(email, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useUpdateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: { mailboxId: string; settings: unknown }) =>
			api.updateMailbox(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useDeleteMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useInboxAgentConfigOptions(enabled: boolean) {
	return useQuery<InboxAgentConfigOptions>({
		queryKey: queryKeys.inboxes.agentConfigOptions,
		queryFn: () => api.getInboxAgentConfigOptions(),
		enabled,
		staleTime: 5 * 60 * 1000,
	});
}

export function useInboxAgentConfig(mailboxId: string | undefined, enabled: boolean) {
	return useQuery<InboxAgentConfigResponse>({
		queryKey: mailboxId
			? queryKeys.inboxes.agentConfig(mailboxId)
			: ["inboxes", "_disabled", "agent-config"],
		queryFn: () => api.getInboxAgentConfig(mailboxId!),
		enabled: !!mailboxId && enabled,
	});
}

export function useUpdateInboxAgentConfig() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			patch,
		}: { mailboxId: string; patch: InboxAgentConfigPatch }) =>
			api.updateInboxAgentConfig(mailboxId, patch),
		onSuccess: (data, { mailboxId }) => {
			qc.setQueryData(queryKeys.inboxes.agentConfig(mailboxId), data);
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useAdminLegacyInboxes(includeOwned: boolean) {
	return useQuery<AdminLegacyInboxesResponse>({
		queryKey: queryKeys.admin.legacyInboxes(includeOwned),
		queryFn: () => api.listAdminLegacyInboxes(includeOwned),
	});
}

export function useAssignInboxOwner() {
	const qc = useQueryClient();
	return useMutation<
		AssignInboxOwnerResponse,
		Error,
		{ mailboxId: string; body: AssignInboxOwnerRequest; includeOwned: boolean }
	>({
		mutationFn: ({ mailboxId, body }) => api.assignInboxOwner(mailboxId, body),
		onSuccess: (_data, { mailboxId, includeOwned }) => {
			qc.invalidateQueries({ queryKey: queryKeys.admin.legacyInboxes(includeOwned) });
			qc.invalidateQueries({ queryKey: queryKeys.admin.legacyInboxes(!includeOwned) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
		},
	});
}
