// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Team, TeamUser } from "~/types";
import { queryKeys } from "./keys";

export function useAdminTeams(enabled: boolean) {
	return useQuery<Team[]>({
		queryKey: queryKeys.adminTeams,
		queryFn: () => api.adminListTeams(),
		enabled,
	});
}

export function useAdminTeamUsers(teamId: string | undefined, enabled: boolean) {
	return useQuery<TeamUser[]>({
		queryKey: teamId
			? queryKeys.adminTeamUsers(teamId)
			: ["admin", "teams", "_disabled", "users"],
		queryFn: () => api.adminListTeamUsers(teamId!),
		enabled: enabled && !!teamId,
	});
}

export function useCreateTeam() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ name, displayName }: { name: string; displayName: string }) =>
			api.adminCreateTeam(name, displayName),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.adminTeams });
			qc.invalidateQueries({ queryKey: queryKeys.adminMailboxes });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useCreateTeamUser() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			teamId,
			userName,
			displayName,
		}: { teamId: string; userName: string; displayName: string }) =>
			api.adminCreateTeamUser(teamId, userName, displayName),
		onSuccess: (_data, { teamId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.adminTeamUsers(teamId) });
			qc.invalidateQueries({ queryKey: queryKeys.adminMailboxes });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
