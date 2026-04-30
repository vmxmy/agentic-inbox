// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { ChatCircleIcon, PlugsIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useUIStore } from "~/hooks/useUIStore";
import MCPPanel from "./MCPPanel";

function LazyUnifiedAgentPanel() {
	const [Panel, setPanel] = useState<React.ComponentType | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/UnifiedAgentPanel").then((mod) => {
			setPanel(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load UnifiedAgentPanel:", err);
			setLoadError("Failed to load agent panel");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}
	if (!Panel) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <Panel />;
}

type AgentSidebarTab = "chat" | "mcp";

const TAB_STORAGE_KEY = "agentic-inbox:agentSidebarTab";

function isTab(value: string): value is AgentSidebarTab {
	return value === "chat" || value === "mcp";
}

function readInitialTab(): AgentSidebarTab {
	if (typeof window === "undefined") return "chat";
	const raw = window.sessionStorage.getItem(TAB_STORAGE_KEY);
	return raw && isTab(raw) ? raw : "chat";
}

export default function AgentSidebar() {
	// Lazy initializer is SSR-safe (`readInitialTab` guards `window`) and
	// preserves the last-active tab across sidebar remounts within the
	// same session. We persist on change rather than on unmount so quick
	// remounts (e.g. route transitions) don't lose the value.
	const [activeTab, setActiveTab] = useState<AgentSidebarTab>(readInitialTab);
	const { toggleAgentPanel } = useUIStore();

	useEffect(() => {
		if (typeof window !== "undefined") {
			window.sessionStorage.setItem(TAB_STORAGE_KEY, activeTab);
		}
	}, [activeTab]);

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar */}
			<div className="flex items-center border-b border-kumo-line shrink-0">
				<button
					type="button"
					onClick={() => setActiveTab("chat")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "chat"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<ChatCircleIcon size={14} weight={activeTab === "chat" ? "fill" : "regular"} />
					Chat
				</button>
				<button
					type="button"
					onClick={() => setActiveTab("mcp")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "mcp"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<PlugsIcon size={14} weight={activeTab === "mcp" ? "fill" : "regular"} />
					MCP
				</button>
				<div className="ml-auto px-2">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<SidebarSimpleIcon size={16} weight="regular" />}
						onClick={toggleAgentPanel}
						aria-label="Close agent panel"
					/>
				</div>
			</div>

			{/* Tab content — keep chat mounted so chat state survives tab switches */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div className={activeTab === "chat" ? "h-full" : "hidden"}>
					<LazyUnifiedAgentPanel />
				</div>
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
