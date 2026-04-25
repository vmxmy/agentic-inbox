// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tool-call status badge used inside chat message bubbles. Domain panels
 * provide their own `toolLabels` map — the badge renders icon + label +
 * loading/done state; falls back to a generic wrench + raw tool name when
 * the tool isn't in the map.
 */

import { Loader } from "@cloudflare/kumo";
import { CheckCircleIcon, WrenchIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export interface ToolLabelInfo {
	label: string;
	icon: ReactNode;
}

export type ToolLabels = Record<string, ToolLabelInfo>;

export function ToolCallBadge({
	toolName,
	state,
	toolLabels,
}: {
	toolName: string;
	state: string;
	toolLabels: ToolLabels;
}) {
	const info = toolLabels[toolName] || {
		label: toolName,
		icon: <WrenchIcon size={14} weight="bold" />,
	};
	const isDone =
		state === "output-available" ||
		state === "result" ||
		state === "output-error";

	return (
		<div className="flex items-center gap-1.5 py-1 px-2 rounded bg-kumo-fill/50 text-xs">
			<span className="text-kumo-brand">{info.icon}</span>
			<span className="text-kumo-strong">{info.label}</span>
			{isDone ? (
				<CheckCircleIcon
					size={12}
					weight="fill"
					className="text-kumo-success ml-auto"
				/>
			) : (
				<Loader size="sm" className="ml-auto" />
			)}
		</div>
	);
}
