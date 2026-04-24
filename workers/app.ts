// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import {
	assertMailboxAccess,
	AuthzError,
	getUserFromRequest,
	INTERNAL_USER_HEADER,
	type AuthUser,
} from "./lib/auth";
import type { Env } from "./types";

type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<AppEnv>();

// Cloudflare Access JWT validation middleware + per-request user identity.
app.use("*", async (c, next) => {
	if (!import.meta.env.DEV) {
		const { POLICY_AUD, TEAM_DOMAIN } = c.env;

		// Fail closed in production if Access is not configured.
		if (!POLICY_AUD || !TEAM_DOMAIN) {
			return c.text(
				"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
				500,
			);
		}

		const token = c.req.header("cf-access-jwt-assertion");
		if (!token) {
			return c.text("Missing required CF Access JWT", 403);
		}

		try {
			const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
			const JWKS = createRemoteJWKSet(certsUrl);
			await jwtVerify(token, JWKS, {
				issuer,
				audience: POLICY_AUD,
			});
		} catch {
			return c.text("Invalid or expired Access token", 403);
		}
	}

	// Decode / resolve the user identity and stash it on the Hono context so
	// downstream handlers (requireMailbox, /agents, /mcp, member management)
	// can enforce per-mailbox ACL without re-parsing the JWT.
	try {
		c.set("user", getUserFromRequest(c));
	} catch (e) {
		if (e instanceof AuthzError) return c.text(e.message, e.status);
		throw e;
	}

	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all.
// We inject the authenticated user email via an internal header so the MCP DO
// can enforce per-mailbox ACL without re-parsing the Access JWT. Any client-
// supplied value of the header is stripped first so callers cannot spoof.
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
function forwardToMcp(c: import("hono").Context<AppEnv>) {
	const user = c.var.user;
	const headers = new Headers(c.req.raw.headers);
	headers.delete(INTERNAL_USER_HEADER);
	headers.set(INTERNAL_USER_HEADER, user.email);
	const req = new Request(c.req.raw, { headers });
	return mcpHandler.fetch(req, c.env, c.executionCtx as ExecutionContext);
}
app.all("/mcp", (c) => forwardToMcp(c));
app.all("/mcp/*", (c) => forwardToMcp(c));

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all.
// Enforce per-mailbox ACL before handing off to the Agents SDK.
app.all("/agents/*", async (c) => {
	const user = c.var.user;
	// URL shape: /agents/<ClassName>/<mailboxId>/...
	// The Agents SDK may lower-case / kebab-case the class segment, so we
	// ignore it and read the instance name by position.
	const url = new URL(c.req.url);
	const segments = url.pathname.split("/").filter(Boolean);
	const mailboxId = segments[2] ? decodeURIComponent(segments[2]) : undefined;
	if (mailboxId) {
		try {
			await assertMailboxAccess(c.env, mailboxId, user);
		} catch (e) {
			if (e instanceof AuthzError) return c.text(e.message, e.status);
			throw e;
		}
	}
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
