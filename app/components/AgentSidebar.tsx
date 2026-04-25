// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { PlugsIcon, ReceiptIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import MCPPanel from "./MCPPanel";

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
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
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat />;
}

function LazyInvoicePanel() {
	const [Panel, setPanel] = useState<React.ComponentType | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/InvoicePanel").then((mod) => {
			setPanel(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load InvoicePanel:", err);
			setLoadError("Failed to load invoice agent panel");
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
				<span className="text-xs text-kumo-subtle">Loading invoice agent...</span>
			</div>
		);
	}
	return <Panel />;
}

export default function AgentSidebar() {
	const [activeTab, setActiveTab] = useState<"agent" | "invoice" | "mcp">(
		"agent",
	);
	// Track which tabs the user has opened so we only mount each agent panel
	// after first activation (lazy-load on demand, but keep mounted thereafter
	// so chat state survives tab switches).
	const [opened, setOpened] = useState<Set<"agent" | "invoice">>(
		new Set(["agent"]),
	);

	const handleTab = (tab: "agent" | "invoice" | "mcp") => {
		setActiveTab(tab);
		if (tab === "agent" || tab === "invoice") {
			setOpened((prev) => {
				if (prev.has(tab)) return prev;
				const next = new Set(prev);
				next.add(tab);
				return next;
			});
		}
	};

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar */}
			<div className="flex items-center border-b border-kumo-line shrink-0">
				<button
					type="button"
					onClick={() => handleTab("agent")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "agent"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<RobotIcon size={14} weight={activeTab === "agent" ? "fill" : "regular"} />
					Agent
				</button>
				<button
					type="button"
					onClick={() => handleTab("invoice")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "invoice"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<ReceiptIcon size={14} weight={activeTab === "invoice" ? "fill" : "regular"} />
					Invoice
				</button>
				<button
					type="button"
					onClick={() => handleTab("mcp")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "mcp"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<PlugsIcon size={14} weight={activeTab === "mcp" ? "fill" : "regular"} />
					MCP
				</button>
			</div>

			{/* Tab content — keep agent panels mounted so chat isn't lost on switch */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{opened.has("agent") && (
					<div className={activeTab === "agent" ? "h-full" : "hidden"}>
						<LazyAgentPanel />
					</div>
				)}
				{opened.has("invoice") && (
					<div className={activeTab === "invoice" ? "h-full" : "hidden"}>
						<LazyInvoicePanel />
					</div>
				)}
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
