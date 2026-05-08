// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { GearSixIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";

function friendlyModelName(id: string): string {
	const claude = id.match(/^claude-(\w+)-(\d+)-(\d+)/);
	if (claude) {
		const tier = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
		return `Claude ${tier} ${claude[2]}.${claude[3]}`;
	}
	if (id === "gpt-4o") return "GPT-4o";
	if (id === "gpt-4o-mini") return "GPT-4o mini";
	if (id.startsWith("gpt-4")) return id.replace("gpt-4", "GPT-4").replace(/-/g, " ");
	if (/^o\d+(-\w+)?$/.test(id)) return id.toUpperCase().replace(/-/g, " ");
	const gemini = id.match(/^gemini-(.+)/);
	if (gemini) return `Gemini ${gemini[1].split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")}`;
	return id;
}

export default function AdminLlmProvidersRoute() {
	return <LlmProvidersCard />;
}

// ── LlmProvidersCard ───────────────────────────────────────────────
//
// Admin-only registry of OpenAI-compatible LLM endpoints. Exactly one row may
// carry isDefault=1 and that's the provider EmailAgent / InvoiceAgent stream
// against. When the table is empty the worker falls back to the env-var
// configuration (LLM_BASE_URL / LLM_API_KEY / LLM_DEFAULT_MODEL).

interface LlmProviderPublic {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyMasked: string;
	defaultModel: string;
	enabled: boolean;
	isDefault: boolean;
	createdAt: number;
	updatedAt: number;
}

function LlmProvidersCard() {
	const toastManager = useKumoToastManager();
	const qc = useQueryClient();
	const { data: providers, isLoading } = useQuery({
		queryKey: queryKeys.adminLlmProviders,
		queryFn: () => api.adminListLlmProviders(),
	});

	const [editing, setEditing] = useState<LlmProviderPublic | null>(null);
	const [creating, setCreating] = useState(false);

	const refetch = () => {
		qc.invalidateQueries({ queryKey: queryKeys.adminLlmProviders });
		// Stale model dropdown caches need to drop too — switching the default
		// provider changes the catalog seen by the Settings → Agents tab.
		qc.invalidateQueries({ queryKey: queryKeys.models });
	};

	const handleDelete = async (p: LlmProviderPublic) => {
		if (!confirm(`Delete provider "${p.name}"?`)) return;
		try {
			await api.adminDeleteLlmProvider(p.id);
			toastManager.add({ title: `Deleted ${p.name}` });
			refetch();
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Delete failed",
				variant: "error",
			});
		}
	};

	const handleSetDefault = async (p: LlmProviderPublic) => {
		try {
			await api.adminUpdateLlmProvider(p.id, { makeDefault: true });
			toastManager.add({ title: `${p.name} is now the default` });
			refetch();
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Failed",
				variant: "error",
			});
		}
	};

	const handleTest = async (p: LlmProviderPublic) => {
		try {
			const res = await api.adminTestLlmProvider(p.id);
			toastManager.add({
				title: res.ok
					? `${p.name}: ${res.modelCount} models reachable`
					: `${p.name}: connection failed`,
				variant: res.ok ? "default" : "error",
			});
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Test failed",
				variant: "error",
			});
		}
	};

	return (
		<div className="bg-kumo-base border border-kumo-line rounded-lg p-4 space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<GearSixIcon size={16} />
					<span className="text-sm font-medium text-kumo-default">LLM providers</span>
				</div>
				<Button
					variant="primary"
					size="sm"
					icon={<PlusIcon size={14} />}
					onClick={() => { setCreating(true); setEditing(null); }}
				>
					Add provider
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle">
				OpenAI-compatible endpoints (LiteLLM, OpenRouter, vendor APIs). Exactly one
				provider can be marked as default — that's the one EmailAgent / InvoiceAgent
				route to. When the list is empty the worker falls back to the
				<code className="px-1 py-0.5 mx-1 rounded bg-kumo-recessed">LLM_BASE_URL</code>
				env var configuration.
			</p>

			{(creating || editing) && (
				<LlmProviderForm
					initial={editing}
					onClose={() => { setEditing(null); setCreating(false); }}
					onSaved={() => { setEditing(null); setCreating(false); refetch(); }}
				/>
			)}

			{isLoading ? (
				<div className="flex justify-center py-4"><Loader size="sm" /></div>
			) : !providers || providers.length === 0 ? (
				<p className="text-xs text-kumo-subtle italic">
					No providers configured. Worker is using <code>LLM_BASE_URL</code> env var.
				</p>
			) : (
				<div className="overflow-x-auto rounded border border-kumo-line">
					<table className="min-w-full text-xs">
						<thead className="bg-kumo-recessed text-kumo-subtle uppercase tracking-wide text-[10px]">
							<tr>
								<th className="px-3 py-2 text-left">Name</th>
								<th className="px-3 py-2 text-left">Endpoint</th>
								<th className="px-3 py-2 text-left">Default model</th>
								<th className="px-3 py-2 text-left">API key</th>
								<th className="px-3 py-2 text-left">Status</th>
								<th className="px-3 py-2" />
							</tr>
						</thead>
						<tbody>
							{providers.map((p) => (
								<tr key={p.id} className="border-t border-kumo-line">
									<td className="px-3 py-2 font-medium text-kumo-default">{p.name}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle break-all">{p.baseUrl}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle">{p.defaultModel}</td>
									<td className="px-3 py-2 font-mono text-kumo-subtle">{p.apiKeyMasked}</td>
									<td className="px-3 py-2">
										<div className="flex items-center gap-1">
											{p.isDefault && <Badge variant="success">default</Badge>}
											{!p.enabled && <Badge variant="secondary">disabled</Badge>}
										</div>
									</td>
									<td className="px-3 py-2 text-right">
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="xs"
												onClick={() => handleTest(p)}
												aria-label={`Test ${p.name}`}
											>
												Test
											</Button>
											{!p.isDefault && (
												<Button
													variant="ghost"
													size="xs"
													onClick={() => handleSetDefault(p)}
												>
													Set default
												</Button>
											)}
											<Button
												variant="ghost"
												size="xs"
												onClick={() => { setEditing(p); setCreating(false); }}
											>
												Edit
											</Button>
											<Button
												variant="ghost"
												size="xs"
												icon={<TrashIcon size={14} />}
												onClick={() => handleDelete(p)}
												aria-label={`Delete ${p.name}`}
											>
												Delete
											</Button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function LlmProviderForm({
	initial,
	onClose,
	onSaved,
}: {
	initial: LlmProviderPublic | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const toastManager = useKumoToastManager();
	const isEdit = !!initial;
	const [name, setName] = useState(initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
	const [enabled, setEnabled] = useState(initial?.enabled ?? true);
	const [makeDefault, setMakeDefault] = useState(initial?.isDefault ?? !isEdit);
	const [saving, setSaving] = useState(false);
	const [discoveredModels, setDiscoveredModels] = useState<string[]>(() =>
		// On open in edit mode, seed with the saved default model so the
		// dropdown isn't empty before the first /v1/models round-trip lands.
		initial?.defaultModel ? [initial.defaultModel] : [],
	);
	const [discovering, setDiscovering] = useState(false);

	const handleDiscover = async () => {
		setDiscovering(true);
		try {
			let modelIds: string[];
			if (isEdit && initial && !apiKey.trim()) {
				// Edit mode without a fresh key entered — use the stored creds via
				// the per-id test endpoint.
				const res = await api.adminTestLlmProvider(initial.id);
				modelIds = res.modelIds;
			} else {
				const u = baseUrl.trim();
				if (!u) {
					toastManager.add({ title: "Endpoint URL is required first", variant: "error" });
					return;
				}
				if (!apiKey.trim() && !isEdit) {
					toastManager.add({ title: "API key is required first", variant: "error" });
					return;
				}
				const res = await api.adminDiscoverLlmModels(u, apiKey);
				modelIds = res.models.map((m) => m.id);
			}
			if (modelIds.length === 0) {
				toastManager.add({ title: "Endpoint reachable but returned no models", variant: "error" });
				return;
			}
			setDiscoveredModels(modelIds);
			// Auto-pick the existing default if it exists in the catalog,
			// otherwise leave whatever the user typed.
			if (defaultModel && !modelIds.includes(defaultModel)) {
				toastManager.add({
					title: `Current model "${defaultModel}" is not in the endpoint's catalog`,
				});
			}
			toastManager.add({ title: `Found ${modelIds.length} models` });
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Discover failed",
				variant: "error",
			});
		} finally {
			setDiscovering(false);
		}
	};

	// Auto-discover on open for edit mode (uses stored creds, no extra typing).
	useEffect(() => {
		if (!isEdit || !initial) return;
		void handleDiscover();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleSubmit = async () => {
		const n = name.trim();
		const u = baseUrl.trim();
		const m = defaultModel.trim();
		if (!n || !u || !m) {
			toastManager.add({ title: "Name, endpoint and default model are required", variant: "error" });
			return;
		}
		if (!isEdit && !apiKey.trim()) {
			toastManager.add({ title: "API key is required for new providers", variant: "error" });
			return;
		}
		setSaving(true);
		try {
			if (isEdit && initial) {
				await api.adminUpdateLlmProvider(initial.id, {
					name: n,
					baseUrl: u,
					...(apiKey ? { apiKey } : {}),
					defaultModel: m,
					enabled,
					makeDefault,
				});
			} else {
				await api.adminCreateLlmProvider({
					name: n,
					baseUrl: u,
					apiKey: apiKey,
					defaultModel: m,
					enabled,
					makeDefault,
				});
			}
			toastManager.add({ title: isEdit ? `Updated ${n}` : `Added ${n}` });
			onSaved();
		} catch (e) {
			toastManager.add({
				title: e instanceof ApiError ? e.message : "Save failed",
				variant: "error",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="rounded border border-kumo-line bg-kumo-recessed p-3 space-y-3">
			<div className="text-sm font-medium text-kumo-default">
				{isEdit ? `Edit "${initial!.name}"` : "Add LLM provider"}
			</div>
			<Input
				label="Name"
				placeholder="e.g. LiteLLM main"
				value={name}
				onChange={(e) => setName(e.target.value)}
			/>
			<Input
				label="Endpoint base URL"
				placeholder="https://litellm.example.com"
				value={baseUrl}
				onChange={(e) => setBaseUrl(e.target.value)}
			/>
			<Input
				label={isEdit ? "API key (leave blank to keep current)" : "API key"}
				type="password"
				placeholder={isEdit ? initial?.apiKeyMasked ?? "" : "sk-..."}
				value={apiKey}
				onChange={(e) => setApiKey(e.target.value)}
				autoComplete="new-password"
			/>
			<div>
				<div className="flex items-end justify-between gap-2 mb-1">
					<label className="block text-xs text-kumo-subtle">Default model</label>
					<button
						type="button"
						onClick={handleDiscover}
						disabled={discovering || !baseUrl.trim() || (!isEdit && !apiKey.trim())}
						className="text-[11px] text-kumo-link hover:underline disabled:opacity-40 disabled:no-underline"
					>
						{discovering ? "Discovering…" : "Discover from /v1/models"}
					</button>
				</div>
				{discoveredModels.length > 0 ? (
					<select
						value={defaultModel}
						onChange={(e) => setDefaultModel(e.target.value)}
						className="w-full bg-kumo-base border border-kumo-line rounded px-2 py-1 text-xs text-kumo-default"
					>
						<option value="">(none — pick one)</option>
						{defaultModel && !discoveredModels.includes(defaultModel) && (
							<option value={defaultModel}>{defaultModel} (not in catalog)</option>
						)}
						{discoveredModels.map((m) => (
							<option key={m} value={m}>{friendlyModelName(m)}</option>
						))}
					</select>
				) : (
					<Input
						placeholder="e.g. glm-5.1 — or fill base URL + key, then click Discover"
						value={defaultModel}
						onChange={(e) => setDefaultModel(e.target.value)}
					/>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-4">
				<label className="flex items-center gap-2 text-xs text-kumo-default">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
					/>
					Enabled
				</label>
				<label className="flex items-center gap-2 text-xs text-kumo-default">
					<input
						type="checkbox"
						checked={makeDefault}
						onChange={(e) => setMakeDefault(e.target.checked)}
					/>
					Set as default
				</label>
			</div>
			<div className="flex justify-end gap-2 pt-1">
				<Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
				<Button variant="primary" size="sm" onClick={handleSubmit} loading={saving}>
					{isEdit ? "Save" : "Add provider"}
				</Button>
			</div>
		</div>
	);
}
