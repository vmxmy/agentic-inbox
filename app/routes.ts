// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder", "routes/email-list.tsx"),
		route("invoices", "routes/invoices.tsx"),
		route("invoices/:invoiceId", "routes/invoice-detail.tsx"),
		route("bundles", "routes/bundles.tsx"),
		route("bundles/:bundleId", "routes/bundle-detail.tsx"),
		route("settings", "routes/settings.tsx"),
		route("search", "routes/search-results.tsx"),
	]),
	route("invite/:token", "routes/invite.tsx"),
	route("admin", "routes/admin.tsx"),
	route("login", "routes/login.tsx"),
	route("register", "routes/register.tsx"),
	route("magic", "routes/magic.tsx"),
	route("forgot-password", "routes/forgot-password.tsx"),
	route("reset-password", "routes/reset-password.tsx"),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
