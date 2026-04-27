// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Barrel — importing this module triggers self-registration of every
 * built-in capability via their top-level `register()` calls. Consumers
 * (workers/index.ts, workers/agent/index.ts, workers/mcp/index.ts) only need
 * to import this file once at module load; they then call into `./registry`
 * for lookups.
 */

// Default middleware — registers the logging interceptor at module load
// time so every capability invocation gets a structured one-line log.
import "./middleware/logging";

// Built-ins — order doesn't matter, ids are unique.
import "./builtin/move-email";
import "./builtin/mark-email-read";
import "./builtin/skip-draft";
import "./builtin/list-emails";
import "./builtin/get-email";
import "./builtin/get-thread";
import "./builtin/search-emails";
import "./builtin/draft-email";
import "./builtin/draft-reply";
import "./builtin/discard-draft";
import "./builtin/send-email";
import "./builtin/webhook";
import "./builtin/extract-attachment-text";
import "./builtin/extract-invoice";

export * from "./types";
export * from "./registry";
export { normalizeRuleAction } from "./legacy-shim";
export type { NormalizedAction, NormalizedRuleAction } from "./legacy-shim";
export { serializeZodSchema } from "./zod-form";
