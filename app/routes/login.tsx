// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import AuthShell from "~/components/AuthShell";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";

const RESEND_COOLDOWN_SECONDS = 30;

type Mode = "magic" | "password";

export default function LoginRoute() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [params] = useSearchParams();
	const verified = params.get("verified") === "1";
	const next = params.get("next") || "/";

	const [mode, setMode] = useState<Mode>("magic");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [magicSentTo, setMagicSentTo] = useState<string | null>(null);
	const [resendIn, setResendIn] = useState(0);
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
		mutationFn: (target: string) =>
			// `next` is preserved through the email round-trip so the user lands
			// on the page they originally requested even if they open the link
			// on a different device.
			api.requestMagicLink(target, next !== "/" ? next : undefined),
		onSuccess: (_data, target) => {
			setMagicSentTo(target);
			setResendIn(RESEND_COOLDOWN_SECONDS);
		},
		onError: (e) => {
			if (e instanceof ApiError && e.status === 429) {
				const retryAfter = e.body?.retryAfter;
				if (typeof retryAfter === "number") {
					setResendIn(retryAfter);
				}
			}
			setError(e instanceof ApiError ? e.message : "Failed to send link");
		},
	});

	// Resend countdown — single interval, cleared when it hits zero.
	const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
	useEffect(() => {
		if (resendIn <= 0) {
			if (tickRef.current) {
				clearInterval(tickRef.current);
				tickRef.current = null;
			}
			return;
		}
		if (tickRef.current) return;
		tickRef.current = setInterval(() => {
			setResendIn((s) => (s <= 1 ? 0 : s - 1));
		}, 1000);
		return () => {
			if (tickRef.current) {
				clearInterval(tickRef.current);
				tickRef.current = null;
			}
		};
	}, [resendIn]);

	const submitPassword = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		login.mutate();
	};

	const submitMagic = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!email) return;
		magic.mutate(email);
	};

	const handleResend = () => {
		if (!magicSentTo || resendIn > 0) return;
		setError(null);
		magic.mutate(magicSentTo);
	};

	const handleUseDifferentEmail = () => {
		setMagicSentTo(null);
		setResendIn(0);
		setError(null);
	};

	// ── Sent confirmation panel ─────────────────────────────────────
	if (magicSentTo) {
		return (
			<AuthShell
				title="Check your inbox"
				footer={
					<button
						type="button"
						className="text-kumo-link hover:underline"
						onClick={handleUseDifferentEmail}
					>
						Use a different email
					</button>
				}
			>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-kumo-default">
						We sent a sign-in link to{" "}
						<span className="font-medium text-kumo-default">{magicSentTo}</span>.
						Click the link in the email to sign in. It expires in 15 minutes.
					</p>
					<p className="text-xs text-kumo-subtle">
						Didn't get it? Check your spam folder, or resend below.
					</p>
					{error && (
						<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
							{error}
						</div>
					)}
					<Button
						type="button"
						variant="secondary"
						onClick={handleResend}
						disabled={resendIn > 0 || magic.isPending}
					>
						{magic.isPending
							? <Loader size="sm" />
							: resendIn > 0
								? `Resend in ${resendIn}s`
								: "Resend link"}
					</Button>
				</div>
			</AuthShell>
		);
	}

	// ── Magic-link primary form ─────────────────────────────────────
	if (mode === "magic") {
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
				<form onSubmit={submitMagic} className="flex flex-col gap-3">
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
					<p className="text-xs text-kumo-subtle">
						We'll email you a one-time link to sign in. No password needed.
					</p>
					{error && (
						<div className="text-xs rounded border border-red-400/40 bg-red-500/5 text-red-400 p-2">
							{error}
						</div>
					)}
					<Button type="submit" variant="primary" disabled={!email || magic.isPending}>
						{magic.isPending ? <Loader size="sm" /> : "Send sign-in link"}
					</Button>
					<div className="flex items-center justify-between text-[11px] text-kumo-subtle">
						<Link to="/forgot-password" className="hover:underline">
							Forgot password?
						</Link>
						<button
							type="button"
							className="hover:text-kumo-default hover:underline"
							onClick={() => {
								setMode("password");
								setError(null);
							}}
						>
							Sign in with password instead
						</button>
					</div>
				</form>
			</AuthShell>
		);
	}

	// ── Password form ───────────────────────────────────────────────
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
			<form onSubmit={submitPassword} className="flex flex-col gap-3">
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
						className="hover:text-kumo-default hover:underline"
						onClick={() => {
							setMode("magic");
							setError(null);
						}}
					>
						Use sign-in link instead
					</button>
				</div>
			</form>
		</AuthShell>
	);
}
