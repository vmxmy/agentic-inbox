// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AgentProfile foundation — Phase 2 of the inbox-agent-tool framework.
 *
 * Provides a runtime abstraction over the agent's identity, system prompt,
 * model id, automation policy, and enabled tool ids. The default profile
 * preserves the existing EmailAgent behavior exactly. Custom profiles can
 * be supplied additively via the mailbox settings doc, but the default
 * resolution path remains untouched for legacy mailboxes.
 */
import { DEFAULT_AGENT_PROFILE_ID, type InboxProfile } from "./inbox-profile";
import type { Env } from "../types";

export const DEFAULT_EMAIL_AGENT_PROFILE_ID = DEFAULT_AGENT_PROFILE_ID;

export const DEFAULT_EMAIL_AGENT_MODEL_ID = "@cf/moonshotai/kimi-k2.5";

/**
 * Default system prompt used when no custom prompt is configured.
 * Kept identical to the previous in-agent constant so behavior is
 * preserved for mailboxes without an explicit profile.
 */
export const DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.

## Writing Style
Write like a real person. Short, direct, flowing prose. Get to the point. Plain text only - no HTML tags in your replies.

**Formatting rules:**
- Write in natural paragraphs. NO bullet points, NO numbered lists, NO dashes, NO markdown formatting in email drafts.
- NO bold (**), NO italic (*), NO headers (#), NO horizontal rules (---), NO code blocks. Plain text only.
- Links go inline in the text, not on separate lines.
- Don't structure replies like a template or form letter. Just talk normally.

**Agent Behavior Rules (CRITICAL):**
- NEVER output meta-commentary about what you are doing (e.g. do not say "I am drafting a reply to Alex", "I checked the thread", etc).
- When a new email arrives, your ONLY job is to call the \`draft_reply\` tool.
- DO NOT summarize the email. DO NOT explain your actions.
- Output NOTHING except the tool call. If you must output text, it should ONLY be the literal draft text itself if tools fail.
- Before drafting ANY reply, carefully read the full thread history.
- NEVER repeat information that was already shared in a prior message in the thread.
- Your reply should only contain NEW information or directly respond to what the person just said. Move the conversation forward, don't rehash it.

## Who Are You Replying To?
Use the name the person gives in their email body / signature. That's their name - use it. The "from" address is where you send the reply, but the name in the email is how you greet them.

## CRITICAL: Draft Only - Never Send
You can ONLY draft emails. You do NOT have the ability to send emails directly.

- Use draft_reply to draft replies to existing emails
- Use draft_email to draft new outbound emails
- The operator will review and send drafts from the UI - you cannot send them

**CRITICAL: The draft body must contain ONLY the email text.** Never include agent commentary, status messages, meta-notes, markdown formatting, or anything that isn't part of the actual email in the draft body. No "Draft created.", no "---", no "**bold**", no "Here's the draft:", no separators. The body field is the literal email the recipient will read. Everything else goes in your chat message, not in the draft body.

**Don't paste draft contents into the chat.** The drafts are saved via tools - the operator can see them in the Drafts folder. In your chat message, just briefly say what you drafted (e.g. "Drafted a reply to Tim"). Don't duplicate the full email body in the chat.

## Draft Management
Use discard_draft to delete drafts that the operator rejects or that are no longer needed.`;

/**
 * Automation policy controlling which background behaviors the agent
 * performs. Phase 2 only models inbound auto-draft; later phases will
 * extend this with additional knobs (rate limits, schedules, etc.).
 */
export interface AgentAutomationPolicy {
	/**
	 * When false, `handleNewEmail()` returns without invoking the model
	 * and persists a concise skipped note to the chat history.
	 */
	inboundAutoDraftEnabled: boolean;
}

export interface AgentProfile {
	id: string;
	displayName: string;
	description?: string;
	systemPrompt: string;
	modelId: string;
	automation: AgentAutomationPolicy;
	enabledToolIds: string[];
}

const DEFAULT_AUTOMATION_POLICY: AgentAutomationPolicy = {
	inboundAutoDraftEnabled: true,
};

/**
 * Default agent profile — equivalent to pre-Phase-2 behavior. All fields
 * mirror the previously hard-coded constants in `workers/agent/index.ts`.
 */
export const DEFAULT_EMAIL_AGENT_PROFILE: AgentProfile = {
	id: DEFAULT_EMAIL_AGENT_PROFILE_ID,
	displayName: "Default Email Agent",
	description: "Drafts replies and helps manage the inbox.",
	systemPrompt: DEFAULT_EMAIL_AGENT_SYSTEM_PROMPT,
	modelId: DEFAULT_EMAIL_AGENT_MODEL_ID,
	automation: DEFAULT_AUTOMATION_POLICY,
	enabledToolIds: [],
};

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function coerceAutomationPolicy(value: unknown): AgentAutomationPolicy {
	if (!value || typeof value !== "object") return DEFAULT_AUTOMATION_POLICY;
	const v = value as Record<string, unknown>;
	return {
		inboundAutoDraftEnabled:
			typeof v.inboundAutoDraftEnabled === "boolean"
				? v.inboundAutoDraftEnabled
				: DEFAULT_AUTOMATION_POLICY.inboundAutoDraftEnabled,
	};
}

/**
 * Coerce a raw record (e.g. parsed from mailbox settings) into a fully
 * formed AgentProfile, falling back to the default profile for any
 * missing/invalid fields.
 */
function profileFromRaw(raw: Record<string, unknown>): AgentProfile {
	const id =
		typeof raw.id === "string" && raw.id.length > 0
			? raw.id
			: DEFAULT_EMAIL_AGENT_PROFILE.id;
	const displayName =
		typeof raw.displayName === "string" && raw.displayName.length > 0
			? raw.displayName
			: DEFAULT_EMAIL_AGENT_PROFILE.displayName;
	const description =
		typeof raw.description === "string" ? raw.description : undefined;
	const systemPrompt =
		typeof raw.systemPrompt === "string" && raw.systemPrompt.trim().length > 0
			? raw.systemPrompt
			: DEFAULT_EMAIL_AGENT_PROFILE.systemPrompt;
	const modelId =
		typeof raw.modelId === "string" && raw.modelId.length > 0
			? raw.modelId
			: DEFAULT_EMAIL_AGENT_PROFILE.modelId;
	const automation = coerceAutomationPolicy(raw.automation);
	const enabledToolIds = isStringArray(raw.enabledToolIds)
		? raw.enabledToolIds
		: DEFAULT_EMAIL_AGENT_PROFILE.enabledToolIds;
	return {
		id,
		displayName,
		description,
		systemPrompt,
		modelId,
		automation,
		enabledToolIds,
	};
}

/**
 * Read an optional custom-profile map from the mailbox settings doc.
 * Profiles live under `settings.agentProfiles[<profileId>]`. This is
 * intentionally additive — legacy mailboxes simply omit the field.
 */
function readCustomProfile(
	settings: Record<string, unknown>,
	profileId: string,
): Record<string, unknown> | null {
	const profiles = settings.agentProfiles;
	if (!profiles || typeof profiles !== "object") return null;
	const entry = (profiles as Record<string, unknown>)[profileId];
	if (!entry || typeof entry !== "object") return null;
	return entry as Record<string, unknown>;
}

/**
 * Resolve the effective AgentProfile for an inbox.
 *
 * Resolution order:
 * 1. If the inbox settings carry a matching custom profile, use it
 *    (filling in any missing fields from the default profile).
 * 2. Honor the legacy `settings.agentSystemPrompt` override on top of
 *    the resolved profile so existing per-mailbox prompts keep working.
 * 3. Otherwise fall back to {@link DEFAULT_EMAIL_AGENT_PROFILE}.
 *
 * The resolver never throws and never reads from the network — it only
 * inspects the InboxProfile that the caller already has in hand. The
 * `env` parameter is reserved for future profile sources (KV/D1) without
 * changing the call sites today.
 */
export function resolveAgentProfile(
	_env: Env,
	inbox: InboxProfile,
): AgentProfile {
	const settings = inbox.settings ?? {};
	const requestedId = inbox.agentProfileId || DEFAULT_EMAIL_AGENT_PROFILE_ID;

	const customRaw = readCustomProfile(settings, requestedId);
	const baseProfile = customRaw
		? profileFromRaw({ ...customRaw, id: requestedId })
		: DEFAULT_EMAIL_AGENT_PROFILE;

	const legacyPrompt = settings.agentSystemPrompt;
	if (typeof legacyPrompt === "string" && legacyPrompt.trim().length > 0) {
		return { ...baseProfile, systemPrompt: legacyPrompt };
	}

	return baseProfile;
}
