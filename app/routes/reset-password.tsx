// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import AuthShell from "~/components/AuthShell";
import api, { ApiError } from "~/services/api";

export default function ResetPasswordRoute() {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const token = params.get("token") ?? "";
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	const m = useMutation({
		mutationFn: () => api.resetPassword(token, password),
		onSuccess: () => navigate("/login?verified=1"),
		onError: (e) => setError(e instanceof ApiError ? e.message : "Reset failed"),
	});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		m.mutate();
	};

	if (!token) {
		return (
			<AuthShell title="Reset your password">
				<p className="text-sm text-kumo-default">
					No token in URL. Request a fresh link from{" "}
					<Link to="/forgot-password" className="text-kumo-link hover:underline">
						the password reset page
					</Link>.
				</p>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			title="Choose a new password"
			footer={
				<Link to="/login" className="text-kumo-link hover:underline">
					Back to sign in
				</Link>
			}
		>
			<form onSubmit={submit} className="flex flex-col gap-3">
				<label className="text-xs text-kumo-subtle">
					New password (min 8 characters)
					<Input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="new-password"
						minLength={8}
						required
						className="mt-1 w-full"
					/>
				</label>
				{error && (
					<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
						{error}
					</div>
				)}
				<Button type="submit" variant="primary" disabled={m.isPending}>
					{m.isPending ? <Loader size="sm" /> : "Update password"}
				</Button>
			</form>
		</AuthShell>
	);
}
