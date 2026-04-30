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

/**
 * Reduce a client-supplied `next` URL parameter to a safe internal path.
 * Mirrors workers/routes/auth.ts:sanitizeInternalNext — kept in lockstep so a
 * value that the server accepts is also one the client will navigate to.
 */
function safeNext(raw: string | null): string {
	if (!raw) return "/";
	if (raw.length > 2048) return "/";
	if (!raw.startsWith("/")) return "/";
	if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
	const firstSegment = raw.split("/")[1] ?? "";
	if (firstSegment.includes(":") && /^[a-z][a-z0-9+.\-]*:/i.test(firstSegment)) return "/";
	return raw;
}

export default function MagicRoute() {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const token = params.get("token") ?? "";
	const next = safeNext(params.get("next"));
	const [error, setError] = useState<string | null>(null);

	const consume = useMutation({
		mutationFn: (t: string) => api.consumeMagicLink(t),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.whoami });
			navigate(next);
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
			<AuthShell
				title="Sign in via magic link"
				footer={
					<Link to="/login" className="text-kumo-link hover:underline">
						Back to sign in
					</Link>
				}
			>
				<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
					No magic link token found in URL. Please request a new sign-in link.
				</div>
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
