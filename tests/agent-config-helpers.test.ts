import { describe, it, expect } from "vitest";
import {
	AGENT_CONFIG_FIELDS,
	agentSettingsPatchFromRaw,
	mailboxSettingsRowToR2Shape,
} from "../workers/lib/agent-config";
import type { MailboxSettingsRow } from "../workers/durableObject";

describe("AGENT_CONFIG_FIELDS", () => {
	it("includes the agent-config slice and excludes non-agent fields", () => {
		expect(AGENT_CONFIG_FIELDS).toContain("autoDraft");
		expect(AGENT_CONFIG_FIELDS).toContain("agentModel");
		expect(AGENT_CONFIG_FIELDS).toContain("agentSystemPrompt");
		expect(AGENT_CONFIG_FIELDS).toContain("invoiceSourceDomains");
		// Non-agent UI fields stay on the R2 omnibus blob:
		expect(AGENT_CONFIG_FIELDS as readonly string[]).not.toContain("fromName");
		expect(AGENT_CONFIG_FIELDS as readonly string[]).not.toContain("forwarding");
		expect(AGENT_CONFIG_FIELDS as readonly string[]).not.toContain("signature");
		// Rules live in their own D1 table:
		expect(AGENT_CONFIG_FIELDS as readonly string[]).not.toContain("rules");
		// ACL fields live in mailbox-directory:
		expect(AGENT_CONFIG_FIELDS as readonly string[]).not.toContain("owner");
		expect(AGENT_CONFIG_FIELDS as readonly string[]).not.toContain("members");
	});
});

describe("agentSettingsPatchFromRaw", () => {
	it("emits patch entries only for keys present on the input", () => {
		const patch = agentSettingsPatchFromRaw({ autoDraft: false });
		expect(patch).toEqual({ autoDraft: false });
	});

	it("trims model strings and coerces blanks to null", () => {
		const patch = agentSettingsPatchFromRaw({
			agentModel: "  glm-5.1  ",
			emailReplyModel: "",
			invoiceModel: "   ",
		});
		expect(patch.agentModel).toBe("glm-5.1");
		expect(patch.emailReplyModel).toBeNull();
		expect(patch.invoiceModel).toBeNull();
	});

	it("filters skill arrays to strings", () => {
		const patch = agentSettingsPatchFromRaw({
			emailReplyEnabledSkills: ["core:draft-reply", 123, null, "core:summarise"],
		});
		expect(patch.emailReplyEnabledSkills).toEqual([
			"core:draft-reply",
			"core:summarise",
		]);
	});

	it("ignores unknown keys", () => {
		const patch = agentSettingsPatchFromRaw({
			autoDraft: true,
			rules: [{ if: {}, then: {} }],
			fromName: "Finance",
		} as Record<string, unknown>);
		expect(patch).toEqual({ autoDraft: true });
	});
});

describe("mailboxSettingsRowToR2Shape", () => {
	const row = (overrides: Partial<MailboxSettingsRow>): MailboxSettingsRow =>
		({
			autoDraft: null,
			agentModel: null,
			emailReplyModel: null,
			invoiceModel: null,
			agentSystemPrompt: null,
			invoiceAgentSystemPrompt: null,
			invoiceSourceDomains: null,
			emailReplyEnabledSkills: null,
			invoiceEnabledSkills: null,
			updatedAt: 0,
			...overrides,
		}) as MailboxSettingsRow;

	it("omits null columns", () => {
		const shape = mailboxSettingsRowToR2Shape(row({}));
		expect(shape).toEqual({});
	});

	it("emits set columns and copies array values", () => {
		const shape = mailboxSettingsRowToR2Shape(
			row({
				autoDraft: false,
				agentModel: "glm-5.1",
				invoiceSourceDomains: [".example.com"],
			}),
		);
		expect(shape).toEqual({
			autoDraft: false,
			agentModel: "glm-5.1",
			invoiceSourceDomains: [".example.com"],
		});
	});
});
