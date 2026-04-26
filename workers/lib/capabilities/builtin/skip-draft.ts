// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { z } from "zod";
import { register } from "../registry";

/**
 * Marker capability — having this in `then.actions[]` is *equivalent* to
 * setting the legacy `skipDraft: true` field. The actual flow control happens
 * after the action loop in the executor (it consults the normalized flow
 * envelope), so this `run` is intentionally a no-op.
 */
register({
	id: "core:skip-draft",
	displayName: "Skip auto-draft",
	description: "Suppress the EmailAgent auto-draft for this email.",
	surfaces: ["rule-action"],
	scopes: [],
	inputSchema: z.object({}),
	async run() {
		return { ok: true };
	},
});
