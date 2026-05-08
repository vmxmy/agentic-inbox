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
		route("settings", "routes/settings.tsx"),
		route("search", "routes/search-results.tsx"),
	]),
	route("invite/:token", "routes/invite.tsx"),
	route("admin", "routes/admin.tsx", [
		index("routes/admin._index.tsx"),
		route("teams", "routes/admin.teams.tsx"),
		route("team-users", "routes/admin.team-users.tsx"),
		route("mailboxes", "routes/admin.mailboxes.tsx"),
		route("users", "routes/admin.users.tsx"),
		route("llm-providers", "routes/admin.llm-providers.tsx"),
	]),
	route("login", "routes/login.tsx"),
	route("register", "routes/register.tsx"),
	route("magic", "routes/magic.tsx"),
	route("forgot-password", "routes/forgot-password.tsx"),
	route("reset-password", "routes/reset-password.tsx"),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
