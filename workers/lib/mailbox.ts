// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation
 * AND per-mailbox authorization. Checks existence + ACL, then instantiates
 * the DO stub and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import {
	assertMailboxAccess,
	AuthzError,
	getUserFromRequest,
	type AuthUser,
} from "./auth";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		user: AuthUser;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// User is normally attached by the outer Hono middleware in workers/app.ts.
	// Re-resolve defensively in case this middleware is mounted elsewhere.
	let user = c.get("user");
	if (!user) {
		try {
			user = getUserFromRequest(c);
			c.set("user", user);
		} catch (e) {
			if (e instanceof AuthzError) return c.json({ error: e.message }, e.status);
			throw e;
		}
	}

	// Existence + ACL check (also performs claim-on-first-access for legacy blobs).
	try {
		await assertMailboxAccess(c.env, mailboxId, user);
	} catch (e) {
		if (e instanceof AuthzError) return c.json({ error: e.message }, e.status);
		throw e;
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);

	await next();
});
