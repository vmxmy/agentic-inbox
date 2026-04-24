// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import api from "~/services/api";
import type { Invoice, InvoiceFilters } from "~/types";
import { queryKeys } from "./keys";

export function useInvoices(mailboxId: string | undefined, filters: InvoiceFilters) {
	return useQuery({
		queryKey: mailboxId
			? queryKeys.invoices.list(mailboxId, filters as Record<string, unknown>)
			: ["invoices", "_disabled"],
		queryFn: () => api.listInvoices(mailboxId!, filters),
		enabled: !!mailboxId,
	});
}

export function useInvoice(mailboxId: string | undefined, invoiceId: string | undefined) {
	return useQuery({
		queryKey:
			mailboxId && invoiceId
				? queryKeys.invoices.detail(mailboxId, invoiceId)
				: ["invoices", "_disabled"],
		queryFn: () => api.getInvoice(mailboxId!, invoiceId!),
		enabled: !!mailboxId && !!invoiceId,
	});
}

export function useDeleteInvoice(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (invoiceId: string) => api.deleteInvoice(mailboxId!, invoiceId),
		onSuccess: (_, invoiceId) => {
			if (!mailboxId) return;
			qc.invalidateQueries({ queryKey: ["invoices", mailboxId] });
			qc.removeQueries({
				queryKey: queryKeys.invoices.detail(mailboxId, invoiceId),
			});
		},
	});
}

/**
 * Read a File to base64 (no `data:` prefix) via FileReader.
 * Works in the browser; safe to use directly inside a React component.
 */
export function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("Expected string result from FileReader"));
				return;
			}
			// result is `data:<mime>;base64,<payload>` — strip prefix.
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Fetch the mailbox-wide list once and project it to a map keyed by
 * `email_id`. Feeds the "已提取发票" badge in the email list + detail
 * views. Capped at 200 invoices per call, which is enough for any
 * mailbox we currently expect.
 */
export function useInvoicesIndexByEmail(mailboxId: string | undefined) {
	const query = useInvoices(mailboxId, { limit: 200 });
	const index = useMemo(() => {
		const map = new Map<string, Invoice[]>();
		for (const inv of query.data?.invoices ?? []) {
			const arr = map.get(inv.email_id);
			if (arr) arr.push(inv);
			else map.set(inv.email_id, [inv]);
		}
		return map;
	}, [query.data]);
	return { index, isLoading: query.isLoading };
}

/** Invoices associated with a single email id (derived from the index). */
export function useInvoicesForEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
): Invoice[] {
	const { index } = useInvoicesIndexByEmail(mailboxId);
	return useMemo(() => {
		if (!emailId) return [];
		return index.get(emailId) ?? [];
	}, [index, emailId]);
}

export function useUploadInvoiceFile(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (file: File) => {
			if (!mailboxId || !emailId) {
				throw new Error("mailboxId + emailId required");
			}
			const content_base64 = await fileToBase64(file);
			return api.uploadInvoiceFile(mailboxId, emailId, {
				filename: file.name,
				mimetype: file.type || undefined,
				content_base64,
			});
		},
		onSuccess: () => {
			if (!mailboxId || !emailId) return;
			qc.invalidateQueries({ queryKey: ["invoices", mailboxId] });
			qc.invalidateQueries({
				queryKey: ["emails", mailboxId, emailId],
			});
		},
	});
}
