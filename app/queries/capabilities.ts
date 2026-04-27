// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export type CapabilitySurface = "rule-action" | "agent-tool" | "mcp-tool";

export interface CapabilityDescriptor {
	id: string;
	displayName: string;
	description: string;
	surfaces: ReadonlyArray<CapabilitySurface>;
	scopes: readonly string[];
	/** Major-version of the capability's input contract. v1 today. */
	version: number;
	/** JSON Schema (zod-to-json-schema serialised) for the capability's params. */
	inputSchema: unknown;
}

/**
 * Fetch the Capability registry for a mailbox. Server returns the global
 * registry today; the per-mailbox path is forward-compatible with future
 * per-mailbox ACL filtering.
 */
export function useCapabilities(
	mailboxId: string | undefined,
	filter?: { surface?: CapabilitySurface },
) {
	return useQuery({
		queryKey: queryKeys.capabilities(mailboxId ?? "", filter?.surface),
		queryFn: async () => {
			if (!mailboxId) return { capabilities: [] as CapabilityDescriptor[] };
			const res = await api.listCapabilities(mailboxId, filter);
			return { capabilities: res.capabilities as CapabilityDescriptor[] };
		},
		enabled: !!mailboxId,
		staleTime: 5 * 60 * 1000,
	});
}
