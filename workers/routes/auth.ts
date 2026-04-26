// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Native auth API: /api/v1/auth/*
 *   POST   /register             email + password → creates user + sends verify email
 *   POST   /login                email + password → sets session cookie
 *   POST   /logout               clears the session cookie
 *   POST   /magic-link/request   email → mails one-time login link
 *   GET    /magic-link/consume   ?token=… → consumes link, sets cookie, redirects /
 *   GET    /verify-email         ?token=… → marks verified, redirects /
 *   POST   /password/forgot      email → mails reset link
 *   POST   /password/reset       token + new password
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
	createSession,
	buildSessionCookie,
	buildClearSessionCookie,
	deleteSession,
	readSessionCookie,
} from "../lib/session";
import {
	createUser,
	findUserByEmail,
	markEmailVerified,
	setPasswordHash,
} from "../lib/users";
import { hashPassword, verifyPassword } from "../lib/password";
import {
	consumeToken,
	issueToken,
	TokenError,
	type TokenPurpose,
} from "../lib/email-tokens";
import { sendEmail } from "../email-sender";

type AuthEnv = { Bindings: Env };

export const authApp = new Hono<AuthEnv>();

const EmailPasswordSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8).max(200),
	displayName: z.string().min(1).max(100).optional(),
});

const EmailOnly = z.object({ email: z.string().email() });
const ResetSchema = z.object({
	token: z.string().min(10),
	password: z.string().min(8).max(200),
});

function publicOrigin(c: import("hono").Context<AuthEnv>): string {
	const fromEnv = c.env.PUBLIC_BASE_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	return new URL(c.req.url).origin;
}

function fromAddress(c: import("hono").Context<AuthEnv>): string {
	const domains = (c.env.DOMAINS || "").split(",").map((d) => d.trim()).filter(Boolean);
	const domain = domains[0] || "localhost";
	return `no-reply@${domain}`;
}

async function deliverEmail(
	c: import("hono").Context<AuthEnv>,
	to: string,
	subject: string,
	body: string,
): Promise<void> {
	if (import.meta.env.DEV || !c.env.EMAIL) {
		console.log(`[auth-email] DEV mode — not sending. to=${to} subject=${subject}\n${body}`);
		return;
	}
	try {
		await sendEmail(c.env.EMAIL, {
			to,
			from: fromAddress(c),
			subject,
			text: body,
		});
	} catch (e) {
		console.error("Failed to send auth email:", (e as Error).message);
	}
}

function setCookie(
	c: import("hono").Context<AuthEnv>,
	id: string,
	expiresAt: number,
): void {
	c.header("Set-Cookie", buildSessionCookie(id, expiresAt));
}

// Generic enumeration-resistant response.
function ok(c: import("hono").Context<AuthEnv>, msg = "ok") {
	return c.json({ ok: true, message: msg });
}

// ── Register ──────────────────────────────────────────────────────

authApp.post("/register", async (c) => {
	const parsed = EmailPasswordSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) {
		return c.json({ error: "Invalid email or password (min 8 chars)" }, 400);
	}
	const { email, password, displayName } = parsed.data;
	const existing = await findUserByEmail(c.env, email);
	if (existing) {
		// Don't leak account existence on register.
		return ok(c, "If the email is available, a verification link has been sent.");
	}
	const passwordHash = await hashPassword(password);
	const user = await createUser(c.env, { email, passwordHash, displayName });
	const { rawToken } = await issueToken(c.env, user.id, "verify");
	const link = `${publicOrigin(c)}/api/v1/auth/verify-email?token=${rawToken}`;
	await deliverEmail(
		c,
		user.email,
		"Verify your Agentic Inbox account",
		`Hi,\n\nClick the link below to verify your email address:\n\n${link}\n\nThis link expires in 24 hours.`,
	);
	return ok(c, "Account created. Check your inbox to verify.");
});

// ── Login (password) ──────────────────────────────────────────────

authApp.post("/login", async (c) => {
	const parsed = EmailPasswordSchema.pick({ email: true, password: true })
		.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) {
		return c.json({ error: "Email and password are required" }, 400);
	}
	const { email, password } = parsed.data;
	const user = await findUserByEmail(c.env, email);
	if (!user || !user.passwordHash) {
		return c.json({ error: "Invalid email or password" }, 401);
	}
	const matches = await verifyPassword(password, user.passwordHash);
	if (!matches) {
		return c.json({ error: "Invalid email or password" }, 401);
	}
	if (!user.emailVerifiedAt) {
		return c.json({ error: "Please verify your email before signing in." }, 403);
	}
	const sess = await createSession(c.env, {
		userId: user.id,
		userAgent: c.req.header("user-agent") ?? null,
		ip: c.req.header("cf-connecting-ip") ?? null,
	});
	setCookie(c, sess.id, sess.expiresAt);
	return c.json({
		ok: true,
		user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
	});
});

// ── Logout ────────────────────────────────────────────────────────

authApp.post("/logout", async (c) => {
	const sid = readSessionCookie(c);
	if (sid) await deleteSession(c.env, sid).catch(() => {});
	c.header("Set-Cookie", buildClearSessionCookie());
	return c.json({ ok: true });
});

// ── Magic link login ──────────────────────────────────────────────

authApp.post("/magic-link/request", async (c) => {
	const parsed = EmailOnly.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: "Email required" }, 400);
	const user = await findUserByEmail(c.env, parsed.data.email);
	// Always reply identically to avoid account-enumeration via magic-link.
	if (!user) {
		return ok(c, "If that account exists, a sign-in link is on its way.");
	}
	const { rawToken } = await issueToken(c.env, user.id, "magic");
	const link = `${publicOrigin(c)}/magic?token=${rawToken}`;
	await deliverEmail(
		c,
		user.email,
		"Your Agentic Inbox sign-in link",
		`Click the link below to sign in. It expires in 15 minutes.\n\n${link}`,
	);
	return ok(c, "If that account exists, a sign-in link is on its way.");
});

authApp.get("/magic-link/consume", async (c) => {
	const token = c.req.query("token");
	if (!token) return c.json({ error: "Missing token" }, 400);
	let consumed: { userId: string; purpose: TokenPurpose };
	try {
		consumed = await consumeToken(c.env, token, "magic");
	} catch (e) {
		const msg = e instanceof TokenError ? e.message : "Invalid token";
		return c.json({ error: msg }, 400);
	}
	// Magic-link consumption also implicitly verifies the email.
	await markEmailVerified(c.env, consumed.userId);
	const sess = await createSession(c.env, {
		userId: consumed.userId,
		userAgent: c.req.header("user-agent") ?? null,
		ip: c.req.header("cf-connecting-ip") ?? null,
	});
	setCookie(c, sess.id, sess.expiresAt);
	return c.json({ ok: true });
});

// ── Verify email ──────────────────────────────────────────────────

authApp.get("/verify-email", async (c) => {
	const token = c.req.query("token");
	if (!token) return c.json({ error: "Missing token" }, 400);
	let consumed;
	try {
		consumed = await consumeToken(c.env, token, "verify");
	} catch (e) {
		const msg = e instanceof TokenError ? e.message : "Invalid token";
		return c.json({ error: msg }, 400);
	}
	await markEmailVerified(c.env, consumed.userId);
	// Redirect the GET to the login page so the click-through is friendly.
	return c.redirect(`${publicOrigin(c)}/login?verified=1`, 302);
});

// ── Password reset ────────────────────────────────────────────────

authApp.post("/password/forgot", async (c) => {
	const parsed = EmailOnly.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: "Email required" }, 400);
	const user = await findUserByEmail(c.env, parsed.data.email);
	if (user) {
		const { rawToken } = await issueToken(c.env, user.id, "reset");
		const link = `${publicOrigin(c)}/reset-password?token=${rawToken}`;
		await deliverEmail(
			c,
			user.email,
			"Reset your Agentic Inbox password",
			`We received a request to reset your password. Click the link below to set a new one (expires in 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
		);
	}
	return ok(c, "If that account exists, a reset link has been sent.");
});

authApp.post("/password/reset", async (c) => {
	const parsed = ResetSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: "Token and new password required" }, 400);
	let consumed;
	try {
		consumed = await consumeToken(c.env, parsed.data.token, "reset");
	} catch (e) {
		const msg = e instanceof TokenError ? e.message : "Invalid token";
		return c.json({ error: msg }, 400);
	}
	const passwordHash = await hashPassword(parsed.data.password);
	await setPasswordHash(c.env, consumed.userId, passwordHash);
	await markEmailVerified(c.env, consumed.userId);
	return c.json({ ok: true });
});
