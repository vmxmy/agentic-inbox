// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useWhoami() {
	return useQuery({
		queryKey: queryKeys.whoami,
		queryFn: () => api.whoami(),
		staleTime: 5 * 60 * 1000,
	});
}
