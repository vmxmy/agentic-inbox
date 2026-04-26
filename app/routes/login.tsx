// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import AuthShell from "~/components/AuthShell";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";

export default function LoginRoute() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [params] = useSearchParams();
	const verified = params.get("verified") === "1";
	const next = params.get("next") || "/";

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [magicSent, setMagicSent] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const login = useMutation({
		mutationFn: () => api.login(email, password),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.whoami });
			navigate(next);
		},
		onError: (e) => setError(e instanceof ApiError ? e.message : "Login failed"),
	});

	const magic = useMutation({
		mutationFn: () => api.requestMagicLink(email),
		onSuccess: () => setMagicSent(true),
		onError: (e) => setError(e instanceof ApiError ? e.message : "Failed to send link"),
	});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		login.mutate();
	};

	return (
		<AuthShell
			title="Sign in to your account"
			footer={
				<>
					Need an account?{" "}
					<Link to="/register" className="text-kumo-link hover:underline">
						Register
					</Link>
				</>
			}
		>
			<form onSubmit={submit} className="flex flex-col gap-3">
				{verified && (
					<div className="text-xs rounded border border-green-500/30 bg-green-500/5 text-green-400 p-2">
						Email verified. You can sign in now.
					</div>
				)}
				<label className="text-xs text-kumo-subtle">
					Email
					<Input
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						autoComplete="email"
						required
						className="mt-1 w-full"
					/>
				</label>
				<label className="text-xs text-kumo-subtle">
					Password
					<Input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="current-password"
						required
						className="mt-1 w-full"
					/>
				</label>
				{error && (
					<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
						{error}
					</div>
				)}
				<Button type="submit" variant="primary" disabled={login.isPending}>
					{login.isPending ? <Loader size="sm" /> : "Sign in"}
				</Button>
				<div className="flex items-center justify-between text-[11px] text-kumo-subtle">
					<Link to="/forgot-password" className="hover:underline">
						Forgot password?
					</Link>
					<button
						type="button"
						className="hover:underline disabled:opacity-50"
						disabled={!email || magic.isPending}
						onClick={() => {
							setError(null);
							magic.mutate();
						}}
					>
						{magic.isPending
							? "Sending…"
							: magicSent
								? "Magic link sent"
								: "Email me a magic link"}
					</button>
				</div>
			</form>
		</AuthShell>
	);
}
