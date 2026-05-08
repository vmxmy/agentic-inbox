// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useAdminUsers() {
	return useQuery({
		queryKey: queryKeys.adminUsers,
		queryFn: () => api.adminListUsers(),
	});
}

export function useUpdateUserRole() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ userId, role }: { userId: string; role: string }) =>
			api.adminUpdateUserRole(userId, role),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
		},
	});
}
