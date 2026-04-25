// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef } from "react";
import { Outlet, useParams } from "react-router";
import AgentSidebar from "~/components/AgentSidebar";
import ComposeEmail from "~/components/ComposeEmail";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	// Prefetch mailbox data for child components
	useMailbox(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const {
		isSidebarOpen,
		closeSidebar,
		isAgentPanelOpen,
		toggleAgentPanel,
		closePanel,
		closeComposeModal,
	} = useUIStore();

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeComposeModal();
			closeSidebar();
		}

		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId, closeComposeModal, closePanel, closeSidebar]);

	return (
		<div className="flex h-screen overflow-hidden">
			{/* Mobile sidebar overlay backdrop */}
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				<Sidebar />
			</div>

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>

			{/* Agent + MCP sidebar
			    - lg+ : in-flow 380px column, sits beside the main content
			    - <lg : full-screen drawer (capped at 420px) over the content
			           with a backdrop click-to-close.
			    Previously this was `hidden lg:flex` which excluded all tablet
			    users (md/lg breakpoints) from the AI assistant entirely. */}
			{isAgentPanelOpen && (
				<>
					<div
						className="fixed inset-0 z-30 bg-black/30 lg:hidden"
						onClick={toggleAgentPanel}
						onKeyDown={(e) => e.key === "Escape" && toggleAgentPanel()}
						role="button"
						tabIndex={-1}
						aria-label="Close agent panel"
					/>
					<div className="fixed inset-y-0 right-0 z-40 w-full max-w-[420px] flex flex-col border-l border-kumo-line bg-kumo-base overflow-hidden lg:relative lg:z-0 lg:max-w-none lg:w-[380px] lg:shrink-0">
						<AgentSidebar />
					</div>
				</>
			)}

			<ComposeEmail />
		</div>
	);
}
