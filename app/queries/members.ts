// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useMembers(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId ? queryKeys.members(mailboxId) : ["members", "_disabled"],
		queryFn: () => api.listMembers(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useAddMember() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, email }: { mailboxId: string; email: string }) =>
			api.addMember(mailboxId, email),
		onSuccess: (_data, { mailboxId }) =>
			qc.invalidateQueries({ queryKey: queryKeys.members(mailboxId) }),
	});
}

export function useRemoveMember() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, email }: { mailboxId: string; email: string }) =>
			api.removeMember(mailboxId, email),
		onSuccess: (_data, { mailboxId }) =>
			qc.invalidateQueries({ queryKey: queryKeys.members(mailboxId) }),
	});
}

export function useCreateInvite() {
	return useMutation({
		mutationFn: (mailboxId: string) => api.createInvite(mailboxId),
	});
}
