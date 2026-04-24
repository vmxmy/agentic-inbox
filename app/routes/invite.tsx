// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useWhoami } from "~/queries/identity";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

/**
 * /invite/:token — recipient lands here after clicking a share link.
 * Cloudflare Access has already authenticated them by the time this route
 * runs (the entire Worker is gated). We submit the token for server-side
 * verification and, on success, redirect to the mailbox.
 */
export default function InviteRoute() {
	const { token } = useParams<{ token: string }>();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { data: whoami, isLoading: whoamiLoading } = useWhoami();

	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<{ mailboxId: string; already?: string } | null>(null);

	const accept = useMutation({
		mutationFn: (t: string) => api.acceptInvite(t),
		onSuccess: (r) => {
			setResult({ mailboxId: r.mailboxId, already: r.already });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
		onError: (e) => setError(e instanceof Error ? e.message : "Invite failed"),
	});

	useEffect(() => {
		if (token && !accept.isPending && !accept.isSuccess && !accept.isError) {
			accept.mutate(token);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token]);

	if (!token) {
		return (
			<div className="p-8 max-w-lg mx-auto text-sm text-kumo-default">
				No invite token in URL.
			</div>
		);
	}

	return (
		<div className="p-8 max-w-lg mx-auto flex flex-col gap-4 text-kumo-default">
			<h1 className="text-lg font-semibold">Mailbox invite</h1>
			{(accept.isPending || whoamiLoading) && (
				<div className="flex items-center gap-2 text-sm text-kumo-subtle">
					<Loader size="sm" /> Verifying your invite…
				</div>
			)}
			{whoami?.email && !accept.isPending && (
				<div className="text-xs text-kumo-subtle">
					Signed in as <span className="font-medium text-kumo-default">{whoami.email}</span>.
				</div>
			)}
			{error && (
				<div className="rounded border border-red-400/40 bg-red-500/5 text-sm text-red-400 p-3">
					{error}
				</div>
			)}
			{result && (
				<div className="rounded border border-kumo-line bg-kumo-recessed p-4 text-sm space-y-3">
					<div>
						{result.already === "owner" ? (
							<>You are already the owner of <code>{result.mailboxId}</code>.</>
						) : (
							<>You've been added to <code>{result.mailboxId}</code>.</>
						)}
					</div>
					<Button
						variant="primary"
						onClick={() => navigate(`/mailbox/${result.mailboxId}/emails/inbox`)}
					>
						Open mailbox
					</Button>
				</div>
			)}
		</div>
	);
}
