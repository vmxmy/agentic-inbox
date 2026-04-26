// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Centered card layout shared by all unauthenticated routes (login, register,
 * password recovery, magic link consume).
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

interface Props {
	title: string;
	children: ReactNode;
	footer?: ReactNode;
}

export default function AuthShell({ title, children, footer }: Props) {
	return (
		<div className="min-h-screen min-h-[100dvh] flex items-center justify-center p-6 bg-kumo-recessed">
			<div className="w-full max-w-sm bg-kumo-base border border-kumo-line rounded-lg p-6 shadow-sm">
				<div className="mb-5 flex flex-col items-center">
					<Link to="/" className="text-base font-semibold text-kumo-default">
						Agentic Inbox
					</Link>
					<h1 className="mt-2 text-sm text-kumo-subtle">{title}</h1>
				</div>
				{children}
				{footer && (
					<div className="mt-5 text-center text-xs text-kumo-subtle">{footer}</div>
				)}
			</div>
		</div>
	);
}
