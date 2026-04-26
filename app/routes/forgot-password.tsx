// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import AuthShell from "~/components/AuthShell";
import api, { ApiError } from "~/services/api";

export default function ForgotPasswordRoute() {
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string | null>(null);

	const m = useMutation({
		mutationFn: () => api.forgotPassword(email),
		onError: (e) => setError(e instanceof ApiError ? e.message : "Request failed"),
	});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		m.mutate();
	};

	return (
		<AuthShell
			title="Reset your password"
			footer={
				<Link to="/login" className="text-kumo-link hover:underline">
					Back to sign in
				</Link>
			}
		>
			{m.isSuccess ? (
				<p className="text-sm text-kumo-default">
					If an account exists for <span className="font-medium">{email}</span>,
					a password reset link is on its way.
				</p>
			) : (
				<form onSubmit={submit} className="flex flex-col gap-3">
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
					{error && (
						<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
							{error}
						</div>
					)}
					<Button type="submit" variant="primary" disabled={m.isPending}>
						{m.isPending ? <Loader size="sm" /> : "Send reset link"}
					</Button>
				</form>
			)}
		</AuthShell>
	);
}
