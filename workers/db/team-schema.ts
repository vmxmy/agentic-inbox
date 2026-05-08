// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * D1 schema for the admin-managed team/user mailbox model.
 *
 * These global control-plane rows derive valid mailbox addresses. The
 * transitional `mailbox_id` remains the full email address used with
 * `MAILBOX.idFromName(...)` until a future address-registry -> inbox-id cutover.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema";

export const teams = sqliteTable(
	"teams",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		displayName: text("display_name").notNull(),
		primaryAddress: text("primary_address").notNull(),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	(t) => ({
		slugIdx: uniqueIndex("teams_slug_active_idx").on(t.slug)
			.where(sql`${t.disabledAt} IS NULL`),
		primaryAddressIdx: uniqueIndex("teams_primary_address_active_idx").on(t.primaryAddress)
			.where(sql`${t.disabledAt} IS NULL`),
		createdByIdx: index("teams_created_by_idx").on(t.createdByUserId),
	}),
);

export const teamUsers = sqliteTable(
	"team_users",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id").notNull().references(() => teams.id, {
			onDelete: "cascade",
		}),
		userId: text("user_id").notNull().references(() => users.id, {
			onDelete: "cascade",
		}),
		slug: text("slug").notNull(),
		mailboxAddress: text("mailbox_address").notNull(),
		createdByUserId: text("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	(t) => ({
		teamSlugIdx: uniqueIndex("team_users_team_slug_active_idx").on(t.teamId, t.slug)
			.where(sql`${t.disabledAt} IS NULL`),
		userIdx: uniqueIndex("team_users_user_active_idx").on(t.userId)
			.where(sql`${t.disabledAt} IS NULL`),
		mailboxAddressIdx: uniqueIndex("team_users_mailbox_address_active_idx").on(t.mailboxAddress)
			.where(sql`${t.disabledAt} IS NULL`),
		teamIdx: index("team_users_team_idx").on(t.teamId),
		createdByIdx: index("team_users_created_by_idx").on(t.createdByUserId),
	}),
);

export const addressRegistry = sqliteTable(
	"address_registry",
	{
		address: text("address").primaryKey(),
		kind: text("kind").notNull(),
		teamId: text("team_id").references(() => teams.id, {
			onDelete: "cascade",
		}),
		teamUserId: text("team_user_id").references(() => teamUsers.id, {
			onDelete: "cascade",
		}),
		mailboxId: text("mailbox_id").notNull(),
		active: integer("active").notNull().default(1),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		disabledAt: integer("disabled_at"),
	},
	(t) => ({
		mailboxIdx: index("address_registry_mailbox_idx").on(t.mailboxId),
		teamIdx: index("address_registry_team_idx").on(t.teamId),
		teamUserIdx: index("address_registry_team_user_idx").on(t.teamUserId),
		kindActiveIdx: index("address_registry_kind_active_idx").on(t.kind, t.active),
	}),
);

export type TeamRow = typeof teams.$inferSelect;
export type TeamUserRow = typeof teamUsers.$inferSelect;
export type AddressRegistryRow = typeof addressRegistry.$inferSelect;
