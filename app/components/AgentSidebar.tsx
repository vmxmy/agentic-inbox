// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { ChatCircleIcon, PlugsIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import MCPPanel from "./MCPPanel";

function LazyUnifiedAgentPanel() {
	const [Panel, setPanel] = useState<React.ComponentType | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/UnifiedAgentPanel")
			.then((mod) => setPanel(() => mod.default))
			.catch((err) => {
				console.error("Failed to load UnifiedAgentPanel:", err);
				setLoadError("Failed to load assistant panel");
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
				<span className="text-xs text-kumo-subtle">Loading assistant...</span>
			</div>
		);
	}
	return <Panel />;
}

export default function AgentSidebar() {
	const [activeTab, setActiveTab] = useState<"chat" | "mcp">("chat");

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
					<ChatCircleIcon
						size={14}
						weight={activeTab === "chat" ? "fill" : "regular"}
					/>
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
					<PlugsIcon
						size={14}
						weight={activeTab === "mcp" ? "fill" : "regular"}
					/>
					MCP
				</button>
			</div>

			{/* Tab content — keep chat mounted so chat history isn't lost on switch */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div className={activeTab === "chat" ? "h-full" : "hidden"}>
					<LazyUnifiedAgentPanel />
				</div>
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
