// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export interface LlmModel {
	id: string;
	owned_by?: string;
	created?: number;
	object?: string;
}

/**
 * Live LLM catalog. The worker keeps this cached for 5 minutes; the client
 * holds it for 5 minutes too — passing `force` triggers a fresh fetch on the
 * worker side as well.
 */
export function useModels(force?: boolean) {
	return useQuery({
		queryKey: queryKeys.models,
		queryFn: () => api.listModels(force),
		staleTime: 5 * 60 * 1000,
	});
}
