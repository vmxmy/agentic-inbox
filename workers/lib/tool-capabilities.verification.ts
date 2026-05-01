// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for the Tool Capability Framework (Phase 3).
 *
 * Mirrors the pattern used by `agent-profile.verification.ts`: this file
 * is intentionally NOT imported by production code. It exists so `tsc -b`
 * exercises the registry filtering surface against representative
 * fixtures. There are no runtime side effects.
 */
import { DEFAULT_AGENT_PROFILE_ID } from "./inbox-profile";
import type { InboxProfile } from "./inbox-profile";
import {
	DEFAULT_EMAIL_AGENT_PROFILE,
} from "./agent-profile";
import type { AgentProfile } from "./agent-profile";
import {
	createAgentToolSet,
	getAvailableToolCapabilities,
	getToolCapability,
	listBuiltinCapabilities,
	resolveExecutableCapability,
	type ToolCapability,
	type ToolExecutionContext,
	type ToolSurface,
} from "./tool-capabilities";
import type { Env } from "../types";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

type _SurfaceShape = Expect<Equal<ToolSurface, "agent" | "mcp">>;

type _CapabilityShape = Expect<
	Equal<
		keyof ToolCapability,
		| "id"
		| "displayName"
		| "description"
		| "surfaces"
		| "permissions"
		| "agent"
		| "mcp"
	>
>;

type _ExecutionContextShape = Expect<
	Equal<
		keyof ToolExecutionContext,
		| "env"
		| "surface"
		| "mailboxId"
		| "canonicalAddress"
		| "inboxProfile"
		| "agentProfile"
	>
>;

// --- Inert fixture builders ------------------------------------------------

const FIXTURE_MAILBOX = "verify-tools@example.com";

const FAKE_ENV = {} as unknown as Env;

function makeInbox(overrides: Partial<InboxProfile> = {}): InboxProfile {
	return {
		id: FIXTURE_MAILBOX,
		canonicalAddress: FIXTURE_MAILBOX,
		displayName: FIXTURE_MAILBOX,
		lifecycleStatus: "active",
		storageMailboxId: FIXTURE_MAILBOX,
		agentProfileId: DEFAULT_AGENT_PROFILE_ID,
		enabledToolIds: [],
		settings: {},
		...overrides,
	};
}

function makeAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		...DEFAULT_EMAIL_AGENT_PROFILE,
		...overrides,
	};
}

function makeCtx(
	inbox: InboxProfile,
	agent: AgentProfile,
	surface: ToolSurface,
	mailboxId: string | null = FIXTURE_MAILBOX,
): ToolExecutionContext {
	return {
		env: FAKE_ENV,
		surface,
		mailboxId,
		canonicalAddress: inbox.canonicalAddress,
		inboxProfile: inbox,
		agentProfile: agent,
	};
}

// --- Case 1: agent surface defaults expose the 9 expected tools ------------

const EXPECTED_AGENT_TOOL_IDS = [
	"list_emails",
	"get_email",
	"get_thread",
	"search_emails",
	"draft_email",
	"draft_reply",
	"mark_email_read",
	"move_email",
	"discard_draft",
] as const;

export function verifyAgentDefaultsExposeNineTools(): void {
	const inbox = makeInbox();
	const agent = makeAgent();
	const ctx = makeCtx(inbox, agent, "agent");
	const tools = getAvailableToolCapabilities(ctx, "agent");
	const ids = new Set(tools.map((t) => t.id));
	for (const expected of EXPECTED_AGENT_TOOL_IDS) {
		if (!ids.has(expected)) {
			throw new Error(`agent surface missing default tool ${expected}`);
		}
	}
	if (ids.size !== EXPECTED_AGENT_TOOL_IDS.length) {
		throw new Error(
			`agent surface exposes ${ids.size} tools, expected ${EXPECTED_AGENT_TOOL_IDS.length}`,
		);
	}
}

// --- Case 2: MCP surface defaults expose the 13 expected tools -------------

const EXPECTED_MCP_TOOL_IDS = [
	"list_mailboxes",
	"list_emails",
	"get_email",
	"get_thread",
	"search_emails",
	"draft_reply",
	"create_draft",
	"update_draft",
	"delete_email",
	"send_reply",
	"send_email",
	"mark_email_read",
	"move_email",
] as const;

export function verifyMcpDefaultsExposeFullSurface(): void {
	const inbox = makeInbox();
	const agent = makeAgent();
	const ctx = makeCtx(inbox, agent, "mcp");
	const tools = getAvailableToolCapabilities(ctx, "mcp");
	const ids = new Set(tools.map((t) => t.id));
	for (const expected of EXPECTED_MCP_TOOL_IDS) {
		if (!ids.has(expected)) {
			throw new Error(`mcp surface missing default tool ${expected}`);
		}
	}
	if (ids.size !== EXPECTED_MCP_TOOL_IDS.length) {
		throw new Error(
			`mcp surface exposes ${ids.size} tools, expected ${EXPECTED_MCP_TOOL_IDS.length}`,
		);
	}
}

// --- Case 2b: MCP does not expose config mutation tools in Phase 2 ---------

export function verifyMcpDoesNotExposeConfigMutators(): void {
	const mutatingConfigPattern =
		/^(set|update|patch|delete|create|reset|enable|disable)_.*(config|agent|tool|safety|policy)/;
	const exposed = getAvailableToolCapabilities(
		makeCtx(makeInbox(), makeAgent(), "mcp"),
		"mcp",
	);
	const mutators = exposed
		.map((tool) => tool.id)
		.filter((id) => mutatingConfigPattern.test(id));
	if (mutators.length > 0) {
		throw new Error(
			`mcp surface must not expose Phase 2 config mutators: ${mutators.join(", ")}`,
		);
	}
}

// --- Case 3: agent-only and mcp-only tools never bleed across surfaces -----

export function verifySurfaceIsolation(): void {
	const ctx = makeCtx(makeInbox(), makeAgent(), "agent");
	const agentIds = new Set(
		getAvailableToolCapabilities(ctx, "agent").map((t) => t.id),
	);
	if (agentIds.has("list_mailboxes")) {
		throw new Error("agent surface must not expose list_mailboxes");
	}
	if (agentIds.has("send_email") || agentIds.has("send_reply")) {
		throw new Error("agent surface must not expose send_email / send_reply");
	}
	if (agentIds.has("create_draft") || agentIds.has("update_draft")) {
		throw new Error(
			"agent surface must not expose create_draft / update_draft",
		);
	}

	const mcpCtx = makeCtx(makeInbox(), makeAgent(), "mcp");
	const mcpIds = new Set(
		getAvailableToolCapabilities(mcpCtx, "mcp").map((t) => t.id),
	);
	if (mcpIds.has("draft_email")) {
		throw new Error("mcp surface should not expose agent-only draft_email");
	}
	if (mcpIds.has("discard_draft")) {
		throw new Error("mcp surface should not expose agent-only discard_draft");
	}
}

// --- Case 4: enabledToolIds narrows availability ---------------------------

export function verifyEnabledToolNarrowing(): void {
	const inbox = makeInbox({ enabledToolIds: ["draft_reply"] });
	const agent = makeAgent();
	const ctx = makeCtx(inbox, agent, "agent");
	const tools = getAvailableToolCapabilities(ctx, "agent");
	if (tools.length !== 1 || tools[0].id !== "draft_reply") {
		throw new Error("inbox enabledToolIds did not narrow to draft_reply");
	}
}

// --- Case 5: agent + inbox lists intersect ---------------------------------

export function verifyEnabledToolIntersection(): void {
	const inbox = makeInbox({
		enabledToolIds: ["draft_reply", "get_email", "get_thread"],
	});
	const agent = makeAgent({ enabledToolIds: ["get_email", "list_emails"] });
	const ctx = makeCtx(inbox, agent, "agent");
	const tools = getAvailableToolCapabilities(ctx, "agent");
	if (tools.length !== 1 || tools[0].id !== "get_email") {
		throw new Error("intersection narrowing did not produce expected set");
	}
}

export function verifyExplicitEmptyAgentPolicyDisablesAllTools(): void {
	const agent = makeAgent({ enabledToolIds: [] });
	const inbox = makeInbox({
		enabledToolIds: [],
		settings: {
			agentProfiles: {
				[agent.id]: {
					id: agent.id,
					enabledToolIds: [],
				},
			},
		},
	});
	for (const surface of ["agent", "mcp"] as const) {
		const tools = getAvailableToolCapabilities(
			makeCtx(inbox, agent, surface),
			surface,
		);
		if (tools.length !== 0) {
			throw new Error(
				`explicit empty tool policy should expose no ${surface} tools`,
			);
		}
	}
}

// --- Case 6: unregistered or unauthorized tool ids resolve to null ---------

export function verifyUnregisteredAndUnauthorizedRejection(): void {
	const inbox = makeInbox({ enabledToolIds: ["get_email"] });
	const agent = makeAgent();
	const ctx = makeCtx(inbox, agent, "agent");

	if (resolveExecutableCapability("not_a_tool", ctx, "agent") !== null) {
		throw new Error("unregistered tool id should resolve to null");
	}
	// Registered, but not in the inbox allow-list.
	if (resolveExecutableCapability("send_email", ctx, "agent") !== null) {
		throw new Error("unauthorized tool id should resolve to null");
	}
	// Registered, in registry, but wrong surface.
	if (resolveExecutableCapability("send_email", ctx, "agent") !== null) {
		throw new Error("agent-incompatible tool should resolve to null");
	}
	// Look-up still works.
	if (!getToolCapability("send_email")) {
		throw new Error("send_email should still be registered globally");
	}
}

// --- Case 7: agent tool set shape is AI-SDK compatible ---------------------

export function verifyAgentToolSetShape(): void {
	const ctx = makeCtx(makeInbox(), makeAgent(), "agent");
	const set = createAgentToolSet(ctx);
	for (const id of EXPECTED_AGENT_TOOL_IDS) {
		const entry = set[id];
		if (!entry) throw new Error(`agent tool set missing ${id}`);
		if (typeof entry.description !== "string") {
			throw new Error(`tool ${id} missing description`);
		}
		if (typeof entry.execute !== "function") {
			throw new Error(`tool ${id} missing execute fn`);
		}
		if (!entry.inputSchema) {
			throw new Error(`tool ${id} missing inputSchema`);
		}
	}
}

// --- Case 8: every built-in declares at least one surface adapter ----------

export function verifyEveryBuiltinHasAdapter(): void {
	for (const cap of listBuiltinCapabilities()) {
		if (cap.surfaces.includes("agent") && !cap.agent) {
			throw new Error(`${cap.id} declares agent surface but lacks adapter`);
		}
		if (cap.surfaces.includes("mcp") && !cap.mcp) {
			throw new Error(`${cap.id} declares mcp surface but lacks adapter`);
		}
	}
}

export type ToolCapabilityVerificationCases = {
	surface: _SurfaceShape;
	capability: _CapabilityShape;
	executionContext: _ExecutionContextShape;
};
