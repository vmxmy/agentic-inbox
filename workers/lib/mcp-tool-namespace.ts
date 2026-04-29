// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure helpers for translating between three tool-key namespaces:
 *
 *   1. SDK shape   — `tool_${stripped}_${toolName}`, where `stripped` is the
 *                    connection id with dashes removed (Cloudflare Agents SDK,
 *                    `node_modules/agents/dist/client-K8Z-u76l.js:1308`).
 *   2. Internal    — capability-registry tool names (e.g. `list_emails`).
 *   3. Namespaced  — `mcp__${connId}__${toolName}` (this module's output),
 *                    used as the LLM-visible tool key after the merge in
 *                    `EmailAgent` / `InvoiceAgent` `onChatMessage`.
 *
 * Plan reference: §391. Greedy-prefix matching (longest stripped connId wins)
 * is required because plain `split("_")` cannot disambiguate when a tool name
 * itself contains underscores (plan §51).
 *
 * Purity contract: this module has no runtime dependencies — no `agents`,
 * no `@cloudflare/ai-chat`, no DO bindings. Anything that would couple it
 * to those layers belongs in `workers/agent/` or `workers/durableObject/`.
 */

const SDK_TOOL_PREFIX = "tool_";
const NS_PREFIX = "mcp__";
const NS_SEP = "__";

export function parseSdkToolKey(
	sdkKey: string,
	knownConnIds: readonly string[],
): { connId: string; toolName: string } | null {
	if (!sdkKey.startsWith(SDK_TOOL_PREFIX)) return null;
	const rest = sdkKey.slice(SDK_TOOL_PREFIX.length);

	let bestConnId: string | null = null;
	let bestStrippedLength = -1;
	for (const connId of knownConnIds) {
		const stripped = connId.replace(/-/g, "");
		const probe = stripped + "_";
		if (!rest.startsWith(probe)) continue;
		if (stripped.length > bestStrippedLength) {
			bestConnId = connId;
			bestStrippedLength = stripped.length;
		}
	}

	if (bestConnId === null) return null;
	return {
		connId: bestConnId,
		toolName: rest.slice(bestStrippedLength + 1),
	};
}

export function namespaceTool(connId: string, toolName: string): string {
	return `${NS_PREFIX}${connId}${NS_SEP}${toolName}`;
}

export function parseNamespacedKey(
	key: string,
): { connId: string; toolName: string } | null {
	if (!key.startsWith(NS_PREFIX)) return null;
	const rest = key.slice(NS_PREFIX.length);
	const sepIndex = rest.indexOf(NS_SEP);
	if (sepIndex < 0) return null;
	return {
		connId: rest.slice(0, sepIndex),
		toolName: rest.slice(sepIndex + NS_SEP.length),
	};
}
