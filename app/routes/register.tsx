// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import AuthShell from "~/components/AuthShell";
import api, { ApiError } from "~/services/api";

export default function RegisterRoute() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const register = useMutation({
		mutationFn: () => api.register(email, password, displayName || undefined),
		onError: (e) => setError(e instanceof ApiError ? e.message : "Registration failed"),
	});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		register.mutate();
	};

	if (register.isSuccess) {
		return (
			<AuthShell
				title="Check your inbox"
				footer={
					<Link to="/login" className="text-kumo-link hover:underline">
						Back to sign in
					</Link>
				}
			>
				<p className="text-sm text-kumo-default">
					We've sent a verification link to{" "}
					<span className="font-medium">{email}</span>. Click the link to
					activate your account, then return here to sign in.
				</p>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			title="Create an account"
			footer={
				<>
					Already have an account?{" "}
					<Link to="/login" className="text-kumo-link hover:underline">
						Sign in
					</Link>
				</>
			}
		>
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
				<label className="text-xs text-kumo-subtle">
					Password (min 8 characters)
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
				<label className="text-xs text-kumo-subtle">
					Display name (optional)
					<Input
						type="text"
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						className="mt-1 w-full"
					/>
				</label>
				{error && (
					<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
						{error}
					</div>
				)}
				<Button type="submit" variant="primary" disabled={register.isPending}>
					{register.isPending ? <Loader size="sm" /> : "Create account"}
				</Button>
			</form>
		</AuthShell>
	);
}
