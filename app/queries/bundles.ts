// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useBundles(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId ? queryKeys.bundles.list(mailboxId) : ["bundles", "_disabled"],
		queryFn: () => api.listBundles(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useBundle(mailboxId: string | undefined, bundleId: string | undefined) {
	return useQuery({
		queryKey:
			mailboxId && bundleId
				? queryKeys.bundles.detail(mailboxId, bundleId)
				: ["bundles", "_disabled"],
		queryFn: () => api.getBundle(mailboxId!, bundleId!),
		enabled: !!mailboxId && !!bundleId,
	});
}

export function useCreateBundle(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (args: { name: string; note?: string | null }) =>
			api.createBundle(mailboxId!, args),
		onSuccess: () => {
			if (!mailboxId) return;
			qc.invalidateQueries({ queryKey: queryKeys.bundles.list(mailboxId) });
		},
	});
}

export function useUpdateBundle(mailboxId: string | undefined, bundleId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: { name?: string; note?: string | null; status?: string }) =>
			api.updateBundle(mailboxId!, bundleId!, patch),
		onSuccess: () => {
			if (!mailboxId || !bundleId) return;
			qc.invalidateQueries({ queryKey: queryKeys.bundles.list(mailboxId) });
			qc.invalidateQueries({
				queryKey: queryKeys.bundles.detail(mailboxId, bundleId),
			});
		},
	});
}

export function useDeleteBundle(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (bundleId: string) => api.deleteBundle(mailboxId!, bundleId),
		onSuccess: (_, bundleId) => {
			if (!mailboxId) return;
			qc.invalidateQueries({ queryKey: queryKeys.bundles.list(mailboxId) });
			qc.removeQueries({
				queryKey: queryKeys.bundles.detail(mailboxId, bundleId),
			});
		},
	});
}

export function useAddToBundle(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (args: { bundleId: string; invoiceId: string }) =>
			api.addInvoiceToBundle(mailboxId!, args.bundleId, args.invoiceId),
		onSuccess: (_, { bundleId }) => {
			if (!mailboxId) return;
			qc.invalidateQueries({ queryKey: queryKeys.bundles.list(mailboxId) });
			qc.invalidateQueries({
				queryKey: queryKeys.bundles.detail(mailboxId, bundleId),
			});
		},
	});
}

export function useRemoveFromBundle(
	mailboxId: string | undefined,
	bundleId: string | undefined,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (invoiceId: string) =>
			api.removeInvoiceFromBundle(mailboxId!, bundleId!, invoiceId),
		onSuccess: () => {
			if (!mailboxId || !bundleId) return;
			qc.invalidateQueries({ queryKey: queryKeys.bundles.list(mailboxId) });
			qc.invalidateQueries({
				queryKey: queryKeys.bundles.detail(mailboxId, bundleId),
			});
		},
	});
}
