// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Drizzle schema for the LLM provider registry. Backs the admin
 * Settings → System tab; resolves at runtime to the OpenAI-compatible
 * endpoint that EmailAgent / InvoiceAgent stream against.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const llmProviders = sqliteTable(
	"llm_providers",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		baseUrl: text("base_url").notNull(),
		apiKey: text("api_key").notNull(),
		defaultModel: text("default_model").notNull(),
		enabled: integer("enabled").notNull().default(1),
		isDefault: integer("is_default").notNull().default(0),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	// Partial unique index — at most one row may carry is_default=1 at any
	// time. The CRUD layer in `workers/lib/llm-providers.ts` writes
	// (set all to 0, then set target to 1) inside one batch to maintain it.
	(t) => ({
		oneDefaultIdx: uniqueIndex("llm_providers_one_default_idx")
			.on(t.isDefault)
			.where(sql`${t.isDefault} = 1`),
	}),
);

export type LlmProviderRow = typeof llmProviders.$inferSelect;
