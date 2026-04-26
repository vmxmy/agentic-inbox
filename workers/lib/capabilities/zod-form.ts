// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tiny wrapper around `zod-to-json-schema` so the /capabilities endpoint can
 * ship each capability's `inputSchema` as standard JSON Schema, and the
 * frontend can render a param form without depending on Zod at runtime.
 *
 * The dep is already pulled in transitively via the AI SDK; we don't add it
 * to package.json directly.
 */
import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export function serializeInputSchema(schema: ZodType): unknown {
	return zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" });
}
