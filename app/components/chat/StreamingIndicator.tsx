// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * "Thinking…" placeholder shown while the agent is streaming a reply.
 * Mirrors the assistant bubble layout (avatar + bubble) so the visual
 * doesn't shift when the real response lands.
 */

import { Loader } from "@cloudflare/kumo";
import type { Icon } from "@phosphor-icons/react";

export function StreamingIndicator({
	avatarIcon: AvatarIcon,
}: {
	avatarIcon: Icon;
}) {
	return (
		<div className="flex gap-2">
			<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-kumo-default">
				<AvatarIcon size={12} weight="bold" />
			</div>
			<div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-kumo-elevated border border-kumo-line rounded-bl-sm">
				<Loader size="sm" />
				<span className="text-xs text-kumo-subtle">Thinking...</span>
			</div>
		</div>
	);
}
