// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Drizzle schema for the native auth layer that lives in Cloudflare D1.
 * Replaces the previous Cloudflare Access dependency for identifying users.
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	emailVerifiedAt: integer("email_verified_at"),
	passwordHash: text("password_hash"),
	role: text("role").notNull().default("user"),
	displayName: text("display_name"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		expiresAt: integer("expires_at").notNull(),
		createdAt: integer("created_at").notNull(),
		userAgent: text("user_agent"),
		ip: text("ip"),
	},
	(t) => ({
		userIdx: index("sessions_user_idx").on(t.userId),
	}),
);

export const emailTokens = sqliteTable(
	"email_tokens",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// "verify" | "magic" | "reset"
		purpose: text("purpose").notNull(),
		// sha256 of the random token; the raw token only exists in the email
		tokenHash: text("token_hash").notNull(),
		expiresAt: integer("expires_at").notNull(),
		consumedAt: integer("consumed_at"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => ({
		hashIdx: index("email_tokens_hash_idx").on(t.tokenHash),
		userPurposeIdx: index("email_tokens_user_purpose_idx").on(t.userId, t.purpose),
	}),
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type EmailTokenRow = typeof emailTokens.$inferSelect;
