// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Capability — a single, registry-defined unit of "something the inbox can do."
 *
 * One Capability can be exposed on three surfaces (any subset):
 *   - rule-action : invoked declaratively from a Rule's `then.actions[]` after
 *                   inbound-email match.
 *   - agent-tool  : exposed to the LLM as a callable tool inside an Agent.
 *   - mcp-tool    : exposed by the hosted MCP server to external clients.
 *
 * Adding a new behaviour ("post a Slack message", "create a Linear ticket")
 * means writing one capability file + listing it in the barrel — never editing
 * the rule executor, the agent class, and the MCP class separately.
 */
import type { z } from "zod";
import type { Env } from "../../types";

export type CapabilitySurface = "rule-action" | "agent-tool" | "mcp-tool";

/**
 * Permission/intent hints. Used today only for audit + UI badges. Future
 * per-mailbox / per-key ACL can deny by scope without changing capability code.
 */
export type CapabilityScope =
	| "mailbox.read"
	| "mailbox.write"
	| "email.send"
	| "external.http";

export interface CapabilityUser {
	id: string;
	email: string;
	role: "user" | "admin";
}

export interface CapabilityContext {
	env: Env;
	mailboxId: string;
	/** Authenticated caller. Null for system-triggered (rule executor on inbound mail). */
	user?: CapabilityUser | null;
	/** Set when triggered from inbound-email rule. */
	emailId?: string;
	/** Set when invoked as an agent tool. */
	agentId?: "email-reply" | "invoice";
	triggeredBy: "rule" | "agent-tool" | "mcp";
}

export interface Capability<I = unknown, O = unknown> {
	/** Stable id, lowercase + colon-namespaced. Enforced regex `/^[a-z]+:[a-z][a-z0-9-]*$/`. */
	id: string;
	displayName: string;
	/** Doubles as LLM tool description and UI tooltip. */
	description: string;
	surfaces: readonly CapabilitySurface[];
	scopes: readonly CapabilityScope[];
	inputSchema: z.ZodType<I>;
	run(ctx: CapabilityContext, input: I): Promise<O>;
}

/** Result of `registry.invoke()`. Discriminated for type-safe consumers. */
export type CapabilityResult<O = unknown> =
	| { ok: true; value: O }
	| { ok: false; error: string; code: "unknown_capability" | "invalid_input" | "run_failed" };

/**
 * Optional return shape for capabilities that contribute to the inbound-email
 * auto-draft agent's prompt envelope. The rule executor in `workers/index.ts`
 * harvests `promptText` from each invocation and concatenates them into the
 * final `promptOverride` passed to EmailAgent. Capabilities that do not
 * contribute simply return any other value (or void); the executor reads
 * these fields with `typeof` guards so non-contributing capabilities pay
 * nothing.
 */
export interface CapabilityPromptContribution {
	/** Text to append to the agent's prompt. Blank string means no contribution. */
	promptText?: string;
	/** Filenames of attachments deferred to async OCR (informational). */
	deferredPdfs?: string[];
}
