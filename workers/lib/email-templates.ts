// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound email templates. Each helper returns `{ subject, text, html }` so
 * the caller can pass both bodies to the email binding — text for clients
 * that don't render HTML, plus the branded HTML version for everything else.
 */

export interface EmailContent {
	subject: string;
	text: string;
	html: string;
}

const APP_NAME = "Agentic Inbox";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

interface ButtonEmailParams {
	heading: string;
	intro: string;
	buttonLabel: string;
	link: string;
	footnote: string;
}

function buttonEmailHtml(p: ButtonEmailParams): string {
	const safeLink = escapeHtml(p.link);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(p.heading)}</title></head>
<body style="margin:0;padding:0;background:#0b0c0f;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0c0f;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#13151a;border:1px solid #25282f;border-radius:12px;">
<tr><td style="padding:32px;">
<div style="font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#9ca3af;margin-bottom:8px;">${escapeHtml(APP_NAME)}</div>
<div style="font-size:20px;font-weight:600;color:#f3f4f6;margin-bottom:16px;">${escapeHtml(p.heading)}</div>
<div style="font-size:15px;line-height:1.55;color:#d1d5db;margin-bottom:28px;">${p.intro}</div>
<a href="${safeLink}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(p.buttonLabel)}</a>
<div style="font-size:12px;color:#9ca3af;margin-top:32px;line-height:1.5;">Or paste this link into your browser:<br><a href="${safeLink}" style="color:#f97316;word-break:break-all;">${safeLink}</a></div>
<div style="font-size:12px;color:#6b7280;margin-top:24px;line-height:1.5;border-top:1px solid #25282f;padding-top:16px;">${escapeHtml(p.footnote)}</div>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

export function magicLinkEmail({
	link,
	ttlMinutes,
}: { link: string; ttlMinutes: number }): EmailContent {
	const subject = `Your ${APP_NAME} sign-in link`;
	const text = `Sign in to ${APP_NAME}\n\nClick the link below to sign in. It expires in ${ttlMinutes} minutes.\n\n${link}\n\nIf you didn't request this, you can safely ignore this email — no one can sign in without the link above.`;
	const html = buttonEmailHtml({
		heading: `Sign in to ${APP_NAME}`,
		intro: `Click the button below to finish signing in. The link expires in <strong>${ttlMinutes} minutes</strong>.`,
		buttonLabel: "Sign in",
		link,
		footnote:
			"If you didn't request this, you can safely ignore this email — no one can sign in without the link above.",
	});
	return { subject, text, html };
}

export function passwordResetEmail({
	link,
	ttlMinutes,
}: { link: string; ttlMinutes: number }): EmailContent {
	const subject = `Reset your ${APP_NAME} password`;
	const text = `Reset your ${APP_NAME} password\n\nWe received a request to set a new password. The link below expires in ${ttlMinutes} minutes:\n\n${link}\n\nIf you didn't request this, you can ignore this email — your password won't change without clicking the link above.`;
	const html = buttonEmailHtml({
		heading: `Reset your ${APP_NAME} password`,
		intro: `We received a request to set a new password for your account. Click the button below to choose a new one. The link expires in <strong>${ttlMinutes} minutes</strong>.`,
		buttonLabel: "Choose new password",
		link,
		footnote:
			"If you didn't request this, you can ignore this email — your password won't change without clicking the link above.",
	});
	return { subject, text, html };
}
