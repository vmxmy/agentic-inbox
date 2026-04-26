// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import AuthShell from "~/components/AuthShell";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";

export default function MagicRoute() {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const token = params.get("token") ?? "";
	const [error, setError] = useState<string | null>(null);

	const consume = useMutation({
		mutationFn: (t: string) => api.consumeMagicLink(t),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.whoami });
			navigate("/");
		},
		onError: (e) => setError(e instanceof ApiError ? e.message : "Sign-in link is invalid or expired"),
	});

	useEffect(() => {
		if (token && !consume.isPending && !consume.isSuccess && !consume.isError) {
			consume.mutate(token);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token]);

	if (!token) {
		return (
			<AuthShell title="Sign in via magic link">
				<p className="text-sm text-kumo-default">No token in URL.</p>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			title="Sign in via magic link"
			footer={
				<Link to="/login" className="text-kumo-link hover:underline">
					Back to sign in
				</Link>
			}
		>
			{!error ? (
				<div className="flex items-center gap-2 text-sm text-kumo-subtle">
					<Loader size="sm" /> Signing you in…
				</div>
			) : (
				<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
					{error}
				</div>
			)}
		</AuthShell>
	);
}
