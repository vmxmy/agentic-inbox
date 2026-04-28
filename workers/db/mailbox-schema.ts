// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Drizzle schema for the D1 mailbox directory + membership index.
 *
 * Shadow of the legacy R2 ACL blobs in `mailboxes/<id>.json`. PR 3 (this
 * change) only dual-writes; the per-mailbox ACL gates and `listUserMailboxes`
 * still read from R2. PR 4 will cut reads over to D1, after which R2's
 * `owner` / `members` fields become a deprecation tail.
 */
import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema";

export const mailboxes = sqliteTable(
	"mailboxes",
	{
		// Mailbox id == lowercased email address. Same value used as
		// MAILBOX.idFromName(...) in the DO routing.
		id: text("id").primaryKey(),
		// FK to users(id). Nullable for legacy ownerless mailboxes; ON DELETE
		// SET NULL so user removal does not orphan the row.
		ownerUserId: text("owner_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		// Denormalized for join-free reads + bridging the legacy email-keyed
		// ACL code path during the dual-write phase.
		ownerEmail: text("owner_email"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => ({
		ownerUserIdx: index("mailboxes_owner_user_idx").on(t.ownerUserId),
		ownerEmailIdx: index("mailboxes_owner_email_idx").on(t.ownerEmail),
	}),
);

export const mailboxMembers = sqliteTable(
	"mailbox_members",
	{
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		// Email is the canonical key. Invited members may not yet be
		// registered users at insert time.
		email: text("email").notNull(),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		addedAt: integer("added_at").notNull(),
		addedByUserId: text("added_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.mailboxId, t.email] }),
		emailIdx: index("mailbox_members_email_idx").on(t.email),
		userIdx: index("mailbox_members_user_idx").on(t.userId),
	}),
);

export type MailboxRow = typeof mailboxes.$inferSelect;
export type MailboxMemberRow = typeof mailboxMembers.$inferSelect;
