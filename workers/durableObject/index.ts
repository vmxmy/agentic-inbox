// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql, gte, lte, like, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { parseChinaEInvoiceXml, type ParsedInvoice } from "../lib/invoice-parser";
import { looksLikeXml } from "../lib/attachment-extract";
import {
	processEmailForInvoices,
	type EntryUnit,
	type ExistingAttachment,
	type PipelineStub,
} from "../lib/invoice-pipeline";
import type { RuleCondition, RuleAction } from "../lib/rules";

export interface InvoiceFilters {
	dateFrom?: string;
	dateTo?: string;
	sellerContains?: string;
	buyerContains?: string;
	invoiceNumber?: string;
	minAmount?: number;
	maxAmount?: number;
	itemContains?: string;
	page?: number;
	limit?: number;
}

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}

	// ── Invoices (Drizzle) ─────────────────────────────────────────

	/**
	 * Atomically persist a parsed invoice + its line items. Returns the new
	 * invoice id. Uses storage.transactionSync so a partial write can never
	 * leave dangling header/items.
	 */
	async saveInvoice(
		emailId: string,
		attachmentId: string,
		parsed: ParsedInvoice,
		opts: { sourceKind?: "xml" | "pdf-ocr"; needsReview?: boolean } = {},
	): Promise<string> {
		const invoiceId = crypto.randomUUID();
		const createdAt = new Date().toISOString();

		const itemsRows = parsed.items.map((it, idx) => ({
			id: crypto.randomUUID(),
			invoice_id: invoiceId,
			ord: idx,
			item_name: it.item_name,
			spec: it.spec,
			unit: it.unit,
			quantity: it.quantity,
			unit_price: it.unit_price,
			amount: it.amount,
			tax_rate: it.tax_rate,
			tax_amount: it.tax_amount,
		}));

		this.ctx.storage.transactionSync(() => {
			// Check if a red invoice already points at this normal invoice number,
			// meaning this invoice should be marked voided on arrival.
			const alreadyVoided =
				parsed.original_invoice_number == null
					? (this.db
						.select({ one: sql<number>`1` })
						.from(schema.invoices)
						.where(eq(schema.invoices.original_invoice_number, parsed.invoice_number))
						.get() != null)
					: false;

			this.db
				.insert(schema.invoices)
				.values({
					id: invoiceId,
					email_id: emailId,
					attachment_id: attachmentId,
					invoice_number: parsed.invoice_number,
					invoice_code: parsed.invoice_code,
					invoice_type: parsed.invoice_type,
					issue_date: parsed.issue_date,
					seller_name: parsed.seller.name,
					seller_tax_id: parsed.seller.tax_id,
					buyer_name: parsed.buyer.name,
					buyer_tax_id: parsed.buyer.tax_id,
					amount_excl_tax: parsed.amount_excl_tax,
					tax_amount: parsed.tax_amount,
					amount_incl_tax: parsed.amount_incl_tax,
					remark: parsed.remark,
					raw_xml: parsed.raw_xml,
					created_at: createdAt,
					source_kind: opts.sourceKind ?? "xml",
					needs_review: opts.needsReview ? 1 : 0,
					original_invoice_number: parsed.original_invoice_number ?? null,
					is_voided: alreadyVoided ? 1 : 0,
				})
				.run();

			if (parsed.original_invoice_number != null) {
				// This is a red invoice — mark its predecessor as voided.
				this.db
					.update(schema.invoices)
					.set({ is_voided: 1 })
					.where(
						and(
							eq(schema.invoices.invoice_number, parsed.original_invoice_number),
							sql`${schema.invoices.id} != ${invoiceId}`,
						),
					)
					.run();
			}

			if (itemsRows.length > 0) {
				this.db.insert(schema.invoiceItems).values(itemsRows).run();
			}
		});

		return invoiceId;
	}

	async getInvoice(invoiceId: string) {
		const invoice = this.db
			.select()
			.from(schema.invoices)
			.where(eq(schema.invoices.id, invoiceId))
			.get();
		if (!invoice) return null;
		const items = this.db
			.select()
			.from(schema.invoiceItems)
			.where(eq(schema.invoiceItems.invoice_id, invoiceId))
			.orderBy(asc(schema.invoiceItems.ord))
			.all();
		return { invoice, items };
	}

	async listInvoices(filters: InvoiceFilters = {}) {
		const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
		const page = Math.max(filters.page ?? 1, 1);
		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (filters.dateFrom) {
			conditions.push(gte(schema.invoices.issue_date, filters.dateFrom));
		}
		if (filters.dateTo) {
			conditions.push(lte(schema.invoices.issue_date, filters.dateTo));
		}
		if (filters.sellerContains) {
			conditions.push(
				like(schema.invoices.seller_name, `%${filters.sellerContains}%`),
			);
		}
		if (filters.buyerContains) {
			conditions.push(
				like(schema.invoices.buyer_name, `%${filters.buyerContains}%`),
			);
		}
		if (filters.invoiceNumber) {
			conditions.push(eq(schema.invoices.invoice_number, filters.invoiceNumber));
		}
		if (filters.minAmount !== undefined) {
			conditions.push(gte(schema.invoices.amount_incl_tax, filters.minAmount));
		}
		if (filters.maxAmount !== undefined) {
			conditions.push(lte(schema.invoices.amount_incl_tax, filters.maxAmount));
		}
		if (filters.itemContains) {
			conditions.push(
				inArray(
					schema.invoices.id,
					this.db.select({ id: schema.invoiceItems.invoice_id })
						.from(schema.invoiceItems)
						.where(like(schema.invoiceItems.item_name, `%${filters.itemContains}%`)),
				),
			);
		}
		const where = conditions.length ? and(...conditions) : undefined;

		// Exclude raw_xml from list payload — bulk JSON is wasteful; callers
		// load it via getInvoice when they need the full document.
		const rows = this.db
			.select({
				id: schema.invoices.id,
				email_id: schema.invoices.email_id,
				attachment_id: schema.invoices.attachment_id,
				invoice_number: schema.invoices.invoice_number,
				invoice_code: schema.invoices.invoice_code,
				invoice_type: schema.invoices.invoice_type,
				issue_date: schema.invoices.issue_date,
				seller_name: schema.invoices.seller_name,
				seller_tax_id: schema.invoices.seller_tax_id,
				buyer_name: schema.invoices.buyer_name,
				buyer_tax_id: schema.invoices.buyer_tax_id,
				amount_excl_tax: schema.invoices.amount_excl_tax,
				tax_amount: schema.invoices.tax_amount,
				amount_incl_tax: schema.invoices.amount_incl_tax,
				currency: schema.invoices.currency,
				remark: schema.invoices.remark,
				source_kind: schema.invoices.source_kind,
				needs_review: schema.invoices.needs_review,
				original_invoice_number: schema.invoices.original_invoice_number,
				is_voided: schema.invoices.is_voided,
				created_at: schema.invoices.created_at,
			})
			.from(schema.invoices)
			.where(where)
			.orderBy(desc(schema.invoices.issue_date), desc(schema.invoices.created_at))
			.limit(limit)
			.offset(offset)
			.all();

		const totalRow = this.db
			.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
			.from(schema.invoices)
			.where(where)
			.get();

		return {
			invoices: rows,
			totalCount: totalRow?.count ?? 0,
			page,
			limit,
		};
	}

	async deleteInvoice(invoiceId: string): Promise<boolean> {
		const existing = this.db
			.select({ id: schema.invoices.id })
			.from(schema.invoices)
			.where(eq(schema.invoices.id, invoiceId))
			.get();
		if (!existing) return false;
		this.db
			.delete(schema.invoices)
			.where(eq(schema.invoices.id, invoiceId))
			.run();
		return true;
	}

	/**
	 * Insert an attachment row for a derived file (a ZIP/OFD container child,
	 * or an external-URL download). Caller must have already written the bytes
	 * to R2 at `attachments/<emailId>/<id>/<filename>`.
	 */
	async saveDerivedAttachment(
		emailId: string,
		args: {
			id: string;
			filename: string;
			mimetype: string;
			size: number;
			origin: "unpacked" | "external-url" | "manual-upload";
			parent_attachment_id?: string;
			source_url?: string;
			content_id?: string | null;
			disposition?: string | null;
		},
	): Promise<string> {
		this.db
			.insert(schema.attachments)
			.values({
				id: args.id,
				email_id: emailId,
				filename: args.filename,
				mimetype: args.mimetype,
				size: args.size,
				content_id: args.content_id ?? null,
				disposition: args.disposition ?? "attachment",
				origin: args.origin,
				source_url: args.source_url ?? null,
				parent_attachment_id: args.parent_attachment_id ?? null,
			})
			.run();
		return args.id;
	}

	/** List all attachments for an email, including derived/external-url rows. */
	async listEmailAttachments(emailId: string) {
		return this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, emailId))
			.all();
	}

	/** Look up a single attachment by id (scoped to this mailbox's DB). */
	async findAttachmentById(attachmentId: string) {
		const row = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.id, attachmentId))
			.get();
		return row ?? null;
	}

	// ── Reimbursement bundles ──────────────────────────────────────

	async createBundle(args: { name: string; note?: string | null }) {
		const id = crypto.randomUUID();
		const created_at = new Date().toISOString();
		const row = {
			id,
			name: args.name,
			note: args.note ?? null,
			status: "draft" as const,
			created_at,
		};
		this.db
			.insert(schema.bundles)
			.values(row)
			.run();
		return row;
	}

	async listBundles() {
		const rows = this.db
			.select({
				id: schema.bundles.id,
				name: schema.bundles.name,
				note: schema.bundles.note,
				status: schema.bundles.status,
				created_at: schema.bundles.created_at,
				invoice_count: sql<number>`COUNT(${schema.bundleInvoices.invoice_id})`.mapWith(Number),
				total_amount: sql<number | null>`SUM(${schema.invoices.amount_incl_tax})`.mapWith((v) =>
					v === null || v === undefined ? null : Number(v),
				),
			})
			.from(schema.bundles)
			.leftJoin(
				schema.bundleInvoices,
				eq(schema.bundleInvoices.bundle_id, schema.bundles.id),
			)
			.leftJoin(
				schema.invoices,
				eq(schema.invoices.id, schema.bundleInvoices.invoice_id),
			)
			.groupBy(schema.bundles.id)
			.orderBy(desc(schema.bundles.created_at))
			.all();
		return rows;
	}

	async getBundle(bundleId: string) {
		const bundle = this.db
			.select()
			.from(schema.bundles)
			.where(eq(schema.bundles.id, bundleId))
			.get();
		if (!bundle) return null;
		const invoices = this.db
			.select({
				id: schema.invoices.id,
				email_id: schema.invoices.email_id,
				attachment_id: schema.invoices.attachment_id,
				invoice_number: schema.invoices.invoice_number,
				invoice_code: schema.invoices.invoice_code,
				invoice_type: schema.invoices.invoice_type,
				issue_date: schema.invoices.issue_date,
				seller_name: schema.invoices.seller_name,
				seller_tax_id: schema.invoices.seller_tax_id,
				buyer_name: schema.invoices.buyer_name,
				buyer_tax_id: schema.invoices.buyer_tax_id,
				amount_excl_tax: schema.invoices.amount_excl_tax,
				tax_amount: schema.invoices.tax_amount,
				amount_incl_tax: schema.invoices.amount_incl_tax,
				currency: schema.invoices.currency,
				remark: schema.invoices.remark,
				source_kind: schema.invoices.source_kind,
				needs_review: schema.invoices.needs_review,
				original_invoice_number: schema.invoices.original_invoice_number,
				is_voided: schema.invoices.is_voided,
				created_at: schema.invoices.created_at,
				position: schema.bundleInvoices.position,
			})
			.from(schema.bundleInvoices)
			.innerJoin(
				schema.invoices,
				eq(schema.invoices.id, schema.bundleInvoices.invoice_id),
			)
			.where(eq(schema.bundleInvoices.bundle_id, bundleId))
			.orderBy(asc(schema.bundleInvoices.position), asc(schema.invoices.issue_date))
			.all();
		return { bundle, invoices };
	}

	async updateBundle(
		bundleId: string,
		patch: { name?: string; note?: string | null; status?: string },
	) {
		const data: { name?: string; note?: string | null; status?: string } = {};
		if (patch.name !== undefined) data.name = patch.name;
		if (patch.note !== undefined) data.note = patch.note;
		if (patch.status !== undefined) data.status = patch.status;
		if (Object.keys(data).length === 0) {
			return (
				this.db
					.select()
					.from(schema.bundles)
					.where(eq(schema.bundles.id, bundleId))
					.get() ?? null
			);
		}
		this.db
			.update(schema.bundles)
			.set(data)
			.where(eq(schema.bundles.id, bundleId))
			.run();
		return (
			this.db
				.select()
				.from(schema.bundles)
				.where(eq(schema.bundles.id, bundleId))
				.get() ?? null
		);
	}

	async deleteBundle(bundleId: string): Promise<boolean> {
		const existing = this.db
			.select({ id: schema.bundles.id })
			.from(schema.bundles)
			.where(eq(schema.bundles.id, bundleId))
			.get();
		if (!existing) return false;
		this.db
			.delete(schema.bundles)
			.where(eq(schema.bundles.id, bundleId))
			.run();
		return true;
	}

	/**
	 * Add an invoice to a bundle. Refuses voided invoices and red-credit
	 * (negative-correction) invoices — neither belongs in a reimbursement
	 * packet. Idempotent: re-adding an already-present invoice is a no-op.
	 */
	async addInvoiceToBundle(
		bundleId: string,
		invoiceId: string,
	): Promise<{ ok: boolean; error?: string }> {
		const bundle = this.db
			.select({ id: schema.bundles.id })
			.from(schema.bundles)
			.where(eq(schema.bundles.id, bundleId))
			.get();
		if (!bundle) return { ok: false, error: "bundle not found" };

		const invoice = this.db
			.select({
				id: schema.invoices.id,
				is_voided: schema.invoices.is_voided,
				original_invoice_number: schema.invoices.original_invoice_number,
			})
			.from(schema.invoices)
			.where(eq(schema.invoices.id, invoiceId))
			.get();
		if (!invoice) return { ok: false, error: "invoice not found" };
		if (invoice.is_voided) {
			return { ok: false, error: "此发票已被红冲，不能加入报销单" };
		}
		if (invoice.original_invoice_number) {
			return { ok: false, error: "红字发票不能单独加入报销单" };
		}

		const existing = this.db
			.select({ bundle_id: schema.bundleInvoices.bundle_id })
			.from(schema.bundleInvoices)
			.where(
				and(
					eq(schema.bundleInvoices.bundle_id, bundleId),
					eq(schema.bundleInvoices.invoice_id, invoiceId),
				),
			)
			.get();
		if (existing) return { ok: true };

		const maxRow = this.db
			.select({
				max: sql<number | null>`MAX(${schema.bundleInvoices.position})`.mapWith(
					(v) => (v === null || v === undefined ? null : Number(v)),
				),
			})
			.from(schema.bundleInvoices)
			.where(eq(schema.bundleInvoices.bundle_id, bundleId))
			.get();
		const nextPosition = (maxRow?.max ?? -1) + 1;

		this.db
			.insert(schema.bundleInvoices)
			.values({
				bundle_id: bundleId,
				invoice_id: invoiceId,
				position: nextPosition,
			})
			.run();
		return { ok: true };
	}

	async removeInvoiceFromBundle(
		bundleId: string,
		invoiceId: string,
	): Promise<boolean> {
		const existing = this.db
			.select({ bundle_id: schema.bundleInvoices.bundle_id })
			.from(schema.bundleInvoices)
			.where(
				and(
					eq(schema.bundleInvoices.bundle_id, bundleId),
					eq(schema.bundleInvoices.invoice_id, invoiceId),
				),
			)
			.get();
		if (!existing) return false;
		this.db
			.delete(schema.bundleInvoices)
			.where(
				and(
					eq(schema.bundleInvoices.bundle_id, bundleId),
					eq(schema.bundleInvoices.invoice_id, invoiceId),
				),
			)
			.run();
		return true;
	}

	/**
	 * Re-run the invoice-extraction pipeline against an existing email. Walks
	 * email-origin attachments, follows external download links in the body,
	 * unpacks ZIP/OFD containers — all via `invoice-pipeline.ts` so fresh
	 * receives and reprocess paths stay aligned. Idempotent.
	 */
	async reprocessInvoicesForEmail(
		emailId: string,
		opts: { allowedDomains: readonly string[] },
	) {
		const email = this.db
			.select({ body: schema.emails.body })
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		if (!email) {
			return { saved: [], skipped: [{ source: emailId, reason: "email not found" }] };
		}

		const allAtts = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, emailId))
			.all();

		// Entry units = email-origin attachments with their R2 bytes materialised.
		const entryUnits: EntryUnit[] = [];
		const existing: ExistingAttachment[] = [];
		for (const a of allAtts) {
			existing.push({
				id: a.id,
				filename: a.filename,
				mimetype: a.mimetype,
				size: a.size,
				origin: a.origin ?? "email",
				source_url: a.source_url ?? null,
				parent_attachment_id: a.parent_attachment_id ?? null,
			});
			if ((a.origin ?? "email") !== "email") continue;
			const key = `attachments/${emailId}/${a.id}/${a.filename}`;
			const obj = await this.env.BUCKET.get(key);
			if (!obj) continue;
			const bytes = new Uint8Array(await obj.arrayBuffer());
			entryUnits.push({
				attachmentId: a.id,
				filename: a.filename,
				mimetype: a.mimetype,
				bytes,
			});
		}

		// Self-adapter so the DO can call the pipeline without going through its
		// own stub (which would deadlock on the input gate).
		const selfStub: PipelineStub = {
			listInvoices: (f) => this.listInvoices(f),
			saveInvoice: (eId, aId, p) => this.saveInvoice(eId, aId, p),
			saveDerivedAttachment: (eId, a) => this.saveDerivedAttachment(eId, a),
		};

		return processEmailForInvoices({
			env: this.env,
			stub: selfStub,
			emailId,
			entryUnits,
			bodyHtml: email.body,
			existingAttachments: existing,
			allowedDomains: opts.allowedDomains,
		});
	}

	// ── Rules engine (persistence layer) ────────────────────────────────
	//
	// Read by `workers/lib/rules-store.ts` and the inbound-email pipeline
	// in `workers/index.ts`. Domain validation (zod RuleSchema) lives in
	// rules-store; this DO trusts inputs are well-formed and only handles
	// row identity, position ordering, version CAS, and history.

	async listRules(): Promise<DoStoredRule[]> {
		const rows = this.db
			.select()
			.from(schema.rules)
			.orderBy(asc(schema.rules.position))
			.all();
		return rows.map(rowToDoStoredRule);
	}

	async replaceRules(input: DoReplaceRulesInput): Promise<DoReplaceRulesResult> {
		// Pre-flight: read current rows + detect version conflicts before opening
		// the write transaction. A conflict means someone else wrote between the
		// caller's read and this call; we surface the offending ids and let the
		// caller decide (refresh + retry, or merge UI).
		const existingRows = this.db.select().from(schema.rules).all();
		const existingMap = new Map(existingRows.map((r) => [r.id, r]));

		const conflicts: string[] = [];
		for (const r of input.rules) {
			if (r.id && existingMap.has(r.id)) {
				const expected = input.expectedVersions[r.id];
				const actual = existingMap.get(r.id)!.version;
				if (expected !== undefined && expected !== actual) {
					conflicts.push(r.id);
				}
			}
		}
		if (conflicts.length > 0) {
			return { ok: false, reason: "version_mismatch", conflicts };
		}

		// Diff input vs. existing.
		const inputIds = new Set(
			input.rules.filter((r): r is typeof r & { id: string } => !!r.id).map((r) => r.id),
		);
		const toDelete = existingRows.filter((r) => !inputIds.has(r.id));

		const now = new Date().toISOString();
		const actor = input.actor;

		this.ctx.storage.transactionSync(() => {
			// Stage existing rows at negative positions to free 1..N for the
			// final dense numbering without tripping the UNIQUE index. SQLite
			// allows negative integers; the staging values are guaranteed not
			// to collide with the final 10/20/30… targets.
			for (const r of existingRows) {
				this.db
					.update(schema.rules)
					.set({ position: -r.position - 1 })
					.where(eq(schema.rules.id, r.id))
					.run();
			}

			// Delete rows not present in the input. History is written before
			// the row goes away so the snapshot survives.
			for (const r of toDelete) {
				this.db
					.insert(schema.ruleHistory)
					.values({
						rule_id: r.id,
						version: r.version,
						change_kind: "delete",
						snapshot_json: JSON.stringify({
							id: r.id,
							name: r.name,
							enabled: !!r.enabled,
							conditions: safeJsonParse(r.conditions_json),
							actions: safeJsonParse(r.actions_json),
							position: r.position,
						}),
						changed_at: now,
						changed_by: actor,
					})
					.run();
				this.db.delete(schema.rules).where(eq(schema.rules.id, r.id)).run();
			}

			// Walk input in order; assign dense positions 10/20/30…
			let pos = 10;
			for (const r of input.rules) {
				const conditionsJson = JSON.stringify(r.conditions ?? {});
				const actionsJson = JSON.stringify(r.actions ?? {});

				if (r.id && existingMap.has(r.id)) {
					const old = existingMap.get(r.id)!;
					const oldName = old.name;
					const newName = r.name ?? null;
					const contentChanged =
						oldName !== newName ||
						!!old.enabled !== r.enabled ||
						old.conditions_json !== conditionsJson ||
						old.actions_json !== actionsJson;
					const positionChanged = old.position !== pos;

					if (contentChanged) {
						const newVersion = old.version + 1;
						this.db
							.update(schema.rules)
							.set({
								position: pos,
								enabled: r.enabled ? 1 : 0,
								name: newName,
								conditions_json: conditionsJson,
								actions_json: actionsJson,
								version: newVersion,
								updated_at: now,
								updated_by: actor,
							})
							.where(eq(schema.rules.id, r.id))
							.run();
						this.db
							.insert(schema.ruleHistory)
							.values({
								rule_id: r.id,
								version: newVersion,
								change_kind: "update",
								snapshot_json: JSON.stringify({
									id: r.id,
									name: newName,
									enabled: r.enabled,
									conditions: r.conditions,
									actions: r.actions,
									position: pos,
								}),
								changed_at: now,
								changed_by: actor,
							})
							.run();
					} else if (positionChanged) {
						// Reorder-only: bump version and log a 'reorder' history row.
						// We still bump version because the row visibly changed; UI's
						// next read will see the new version token.
						const newVersion = old.version + 1;
						this.db
							.update(schema.rules)
							.set({
								position: pos,
								version: newVersion,
								updated_at: now,
								updated_by: actor,
							})
							.where(eq(schema.rules.id, r.id))
							.run();
						this.db
							.insert(schema.ruleHistory)
							.values({
								rule_id: r.id,
								version: newVersion,
								change_kind: "reorder",
								snapshot_json: JSON.stringify({
									id: r.id,
									position: pos,
									previousPosition: old.position,
								}),
								changed_at: now,
								changed_by: actor,
							})
							.run();
					} else {
						// No content or position change — just restore the staged
						// negative position back to its original (== pos) value.
						this.db
							.update(schema.rules)
							.set({ position: pos })
							.where(eq(schema.rules.id, r.id))
							.run();
					}
				} else {
					// New rule. Caller may pre-supply id (rare; e.g., backfill); else
					// we mint one. ULID-style would be sortable, but `position`
					// already encodes order so a UUID v4 is sufficient.
					const newId = r.id ?? `rule_${crypto.randomUUID()}`;
					this.db
						.insert(schema.rules)
						.values({
							id: newId,
							position: pos,
							enabled: r.enabled ? 1 : 0,
							name: r.name ?? null,
							conditions_json: conditionsJson,
							actions_json: actionsJson,
							version: 1,
							created_at: now,
							updated_at: now,
							updated_by: actor,
						})
						.run();
					this.db
						.insert(schema.ruleHistory)
						.values({
							rule_id: newId,
							version: 1,
							change_kind: "create",
							snapshot_json: JSON.stringify({
								id: newId,
								name: r.name ?? null,
								enabled: r.enabled,
								conditions: r.conditions,
								actions: r.actions,
								position: pos,
							}),
							changed_at: now,
							changed_by: actor,
						})
						.run();
				}
				pos += 10;
			}
		});

		const rules = await this.listRules();
		return { ok: true, rules };
	}

	async getRuleHistory(
		ruleId: string,
		limit = 20,
	): Promise<DoRuleHistoryEntry[]> {
		const cap = Math.min(Math.max(limit, 1), 100);
		const rows = this.db
			.select()
			.from(schema.ruleHistory)
			.where(eq(schema.ruleHistory.rule_id, ruleId))
			.orderBy(desc(schema.ruleHistory.seq))
			.limit(cap)
			.all();
		return rows.map((r) => ({
			seq: r.seq,
			rule_id: r.rule_id,
			version: r.version,
			change_kind: r.change_kind,
			// snapshots are written exclusively by replaceRules using one of the
			// two DoRuleSnapshot shapes — the cast is safe at this boundary.
			snapshot: safeJsonParse(r.snapshot_json) as DoRuleSnapshot,
			changed_at: r.changed_at,
			changed_by: r.changed_by,
		}));
	}

	// ── Mailbox settings (PR 5/6) ───────────────────────────────────
	//
	// Singleton row keyed by `id = 'settings'`. Mirrors the agent-config
	// slice that previously lived in the legacy R2 settings blob;
	// `workers/lib/agent-config.ts` reads through these RPCs first and
	// falls back to R2 only for un-backfilled legacy mailboxes.

	async getMailboxSettings(): Promise<MailboxSettingsRow | null> {
		const rows = this.db
			.select()
			.from(schema.mailboxSettings)
			.where(eq(schema.mailboxSettings.id, MAILBOX_SETTINGS_ROW_ID))
			.limit(1)
			.all();
		return rows[0] ? rowToMailboxSettings(rows[0]) : null;
	}

	async replaceMailboxSettings(
		input: MailboxSettingsInput,
	): Promise<MailboxSettingsRow> {
		const row = mailboxSettingsInputToColumns(input);
		this.db
			.insert(schema.mailboxSettings)
			.values(row)
			.onConflictDoUpdate({
				target: schema.mailboxSettings.id,
				set: {
					auto_draft: row.auto_draft,
					agent_model: row.agent_model,
					email_reply_model: row.email_reply_model,
					invoice_model: row.invoice_model,
					agent_system_prompt: row.agent_system_prompt,
					invoice_agent_system_prompt: row.invoice_agent_system_prompt,
					invoice_source_domains_json: row.invoice_source_domains_json,
					email_reply_enabled_skills_json: row.email_reply_enabled_skills_json,
					invoice_enabled_skills_json: row.invoice_enabled_skills_json,
					updated_at: row.updated_at,
				},
			})
			.run();
		return rowToMailboxSettings(row);
	}

	async updateMailboxSettings(
		patch: MailboxSettingsPatch,
	): Promise<MailboxSettingsRow> {
		// Read-modify-write so callers can pass a partial patch without having
		// to reconstruct the full settings shape. Undefined fields skip;
		// `null` explicitly clears.
		const existing = await this.getMailboxSettings();
		const merged: MailboxSettingsInput = {
			autoDraft:
				patch.autoDraft !== undefined ? patch.autoDraft : existing?.autoDraft ?? null,
			agentModel:
				patch.agentModel !== undefined ? patch.agentModel : existing?.agentModel ?? null,
			emailReplyModel:
				patch.emailReplyModel !== undefined
					? patch.emailReplyModel
					: existing?.emailReplyModel ?? null,
			invoiceModel:
				patch.invoiceModel !== undefined
					? patch.invoiceModel
					: existing?.invoiceModel ?? null,
			agentSystemPrompt:
				patch.agentSystemPrompt !== undefined
					? patch.agentSystemPrompt
					: existing?.agentSystemPrompt ?? null,
			invoiceAgentSystemPrompt:
				patch.invoiceAgentSystemPrompt !== undefined
					? patch.invoiceAgentSystemPrompt
					: existing?.invoiceAgentSystemPrompt ?? null,
			invoiceSourceDomains:
				patch.invoiceSourceDomains !== undefined
					? patch.invoiceSourceDomains
					: existing?.invoiceSourceDomains ?? null,
			emailReplyEnabledSkills:
				patch.emailReplyEnabledSkills !== undefined
					? patch.emailReplyEnabledSkills
					: existing?.emailReplyEnabledSkills ?? null,
			invoiceEnabledSkills:
				patch.invoiceEnabledSkills !== undefined
					? patch.invoiceEnabledSkills
					: existing?.invoiceEnabledSkills ?? null,
		};
		return this.replaceMailboxSettings(merged);
	}
}

// ── Mailbox settings helpers (module-private) ────────────────────────

const MAILBOX_SETTINGS_ROW_ID = "settings";

export interface MailboxSettingsRow {
	autoDraft: boolean | null;
	agentModel: string | null;
	emailReplyModel: string | null;
	invoiceModel: string | null;
	agentSystemPrompt: string | null;
	invoiceAgentSystemPrompt: string | null;
	invoiceSourceDomains: readonly string[] | null;
	emailReplyEnabledSkills: readonly string[] | null;
	invoiceEnabledSkills: readonly string[] | null;
	updatedAt: number;
}

export interface MailboxSettingsInput {
	autoDraft: boolean | null;
	agentModel: string | null;
	emailReplyModel: string | null;
	invoiceModel: string | null;
	agentSystemPrompt: string | null;
	invoiceAgentSystemPrompt: string | null;
	invoiceSourceDomains: readonly string[] | null;
	emailReplyEnabledSkills: readonly string[] | null;
	invoiceEnabledSkills: readonly string[] | null;
}

/** Partial update — undefined skips, null clears, value writes. */
export interface MailboxSettingsPatch {
	autoDraft?: boolean | null;
	agentModel?: string | null;
	emailReplyModel?: string | null;
	invoiceModel?: string | null;
	agentSystemPrompt?: string | null;
	invoiceAgentSystemPrompt?: string | null;
	invoiceSourceDomains?: readonly string[] | null;
	emailReplyEnabledSkills?: readonly string[] | null;
	invoiceEnabledSkills?: readonly string[] | null;
}

interface MailboxSettingsRawRow {
	id: string;
	auto_draft: number | null;
	agent_model: string | null;
	email_reply_model: string | null;
	invoice_model: string | null;
	agent_system_prompt: string | null;
	invoice_agent_system_prompt: string | null;
	invoice_source_domains_json: string | null;
	email_reply_enabled_skills_json: string | null;
	invoice_enabled_skills_json: string | null;
	updated_at: number;
}

function parseStringArrayJson(raw: string | null): readonly string[] | null {
	if (raw === null) return null;
	const parsed = safeJsonParse(raw);
	if (!Array.isArray(parsed)) return null;
	const out: string[] = [];
	for (const entry of parsed) {
		if (typeof entry === "string") out.push(entry);
	}
	return out;
}

function rowToMailboxSettings(row: MailboxSettingsRawRow): MailboxSettingsRow {
	return {
		autoDraft: row.auto_draft === null ? null : row.auto_draft !== 0,
		agentModel: row.agent_model,
		emailReplyModel: row.email_reply_model,
		invoiceModel: row.invoice_model,
		agentSystemPrompt: row.agent_system_prompt,
		invoiceAgentSystemPrompt: row.invoice_agent_system_prompt,
		invoiceSourceDomains: parseStringArrayJson(row.invoice_source_domains_json),
		emailReplyEnabledSkills: parseStringArrayJson(row.email_reply_enabled_skills_json),
		invoiceEnabledSkills: parseStringArrayJson(row.invoice_enabled_skills_json),
		updatedAt: row.updated_at,
	};
}

function mailboxSettingsInputToColumns(
	input: MailboxSettingsInput,
): MailboxSettingsRawRow {
	return {
		id: MAILBOX_SETTINGS_ROW_ID,
		auto_draft: input.autoDraft === null ? null : input.autoDraft ? 1 : 0,
		agent_model: input.agentModel,
		email_reply_model: input.emailReplyModel,
		invoice_model: input.invoiceModel,
		agent_system_prompt: input.agentSystemPrompt,
		invoice_agent_system_prompt: input.invoiceAgentSystemPrompt,
		invoice_source_domains_json:
			input.invoiceSourceDomains === null
				? null
				: JSON.stringify([...input.invoiceSourceDomains]),
		email_reply_enabled_skills_json:
			input.emailReplyEnabledSkills === null
				? null
				: JSON.stringify([...input.emailReplyEnabledSkills]),
		invoice_enabled_skills_json:
			input.invoiceEnabledSkills === null
				? null
				: JSON.stringify([...input.invoiceEnabledSkills]),
		updated_at: Date.now(),
	};
}

// ── Rules helpers (module-private) ───────────────────────────────────

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

interface RulesRow {
	id: string;
	position: number;
	enabled: number;
	name: string | null;
	conditions_json: string;
	actions_json: string;
	version: number;
	created_at: string;
	updated_at: string;
	updated_by: string | null;
}

function rowToDoStoredRule(r: RulesRow): DoStoredRule {
	// JSON columns are written by `replaceRules` after the caller (rules-store)
	// has already validated them through the zod RuleSchema, so the cast is
	// safe at the boundary. `rules-store.toStoredRule` re-parses on read for
	// defense in depth against a corrupt row from manual SQL edits.
	return {
		id: r.id,
		position: r.position,
		enabled: !!r.enabled,
		name: r.name,
		conditions: safeJsonParse(r.conditions_json) as RuleCondition,
		actions: safeJsonParse(r.actions_json) as RuleAction,
		version: r.version,
		created_at: r.created_at,
		updated_at: r.updated_at,
		updated_by: r.updated_by,
	};
}

// Plain shapes for DO RPC — structured-cloneable. `conditions` and `actions`
// are `unknown` here because the DO does not own the domain schema; the
// rules-store wrapper validates against zod RuleSchema before passing through.

export interface DoStoredRule {
	id: string;
	position: number;
	enabled: boolean;
	name: string | null;
	conditions: RuleCondition;
	actions: RuleAction;
	version: number;
	created_at: string;
	updated_at: string;
	updated_by: string | null;
}

export interface DoReplaceRulesInput {
	rules: Array<{
		id?: string;
		name?: string | null;
		enabled: boolean;
		conditions: RuleCondition;
		actions: RuleAction;
	}>;
	/** Map of ruleId → version the caller last saw. Used for row-level CAS:
	 *  any id present here whose stored version no longer matches is reported
	 *  as a conflict and the entire replace is aborted. */
	expectedVersions: Record<string, number>;
	/** Free-form actor identifier written into rule_history.changed_by. */
	actor: string;
}

export type DoReplaceRulesResult =
	| { ok: true; rules: DoStoredRule[] }
	| { ok: false; reason: "version_mismatch"; conflicts: string[] };

/** Captured rule state at the time of a history event. The full-content shape
 *  is written for create/update/delete; reorder writes a position-only delta. */
export type DoRuleSnapshot =
	| {
			id: string;
			name: string | null;
			enabled: boolean;
			conditions: RuleCondition;
			actions: RuleAction;
			position: number;
	  }
	| { id: string; position: number; previousPosition: number };

export interface DoRuleHistoryEntry {
	seq: number;
	rule_id: string;
	version: number;
	change_kind: string;
	snapshot: DoRuleSnapshot;
	changed_at: string;
	changed_by: string | null;
}
