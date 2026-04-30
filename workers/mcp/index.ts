// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types";
import { loadInboxProfile } from "../lib/inbox-profile";
import { resolveAgentProfile } from "../lib/agent-profile";
import {
	registerMcpToolsFromRegistry,
	type McpProfileResolver,
} from "../lib/tool-capabilities";

/**
 * EmailMCP — exposes email tools over the Model Context Protocol.
 *
 * Tools are sourced from the shared tool capability registry
 * (`workers/lib/tool-capabilities.ts`) so the MCP and chat agent
 * surfaces stay in lockstep on schema, descriptions, and execution.
 *
 * Per-request inbox/agent profiles are resolved on demand and passed
 * into the registry so policy changes take effect without re-init.
 */
export class EmailMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "agentic-inbox",
		version: "1.0.0",
	});

	async init() {
		const env = this.env;

		const resolveProfiles: McpProfileResolver = async (mailboxId) => {
			const inboxProfile = await loadInboxProfile(env, mailboxId);
			if (!inboxProfile) return null;
			const agentProfile = resolveAgentProfile(env, inboxProfile);
			return { inboxProfile, agentProfile };
		};

		registerMcpToolsFromRegistry(this.server, env, resolveProfiles);
	}
}
