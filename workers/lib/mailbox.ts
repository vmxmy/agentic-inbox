// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Resolves the mailbox id to an InboxProfile (which may be a default for
 * legacy mailboxes), then attaches both the profile and the matching
 * MailboxDO stub to the Hono context.
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import {
	getMailboxStubForInbox,
	loadInboxProfile,
	type InboxProfile,
} from "./inbox-profile";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		inboxProfile: InboxProfile;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	const profile = await loadInboxProfile(c.env, mailboxId);
	if (!profile) {
		return c.json({ error: "Not found" }, 404);
	}

	const stub = getMailboxStubForInbox(c.env, profile);

	c.set("inboxProfile", profile);
	c.set("mailboxStub", stub);

	await next();
});
