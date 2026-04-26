// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Renders a per-capability parameter form derived from the capability's
 * (JSON-schema-serialised) input schema. Supports the 5 leaf types we
 * actually use across the built-in capabilities — string, number, boolean,
 * string-enum, string-array — and falls back to a JSON textarea for anything
 * richer (nested objects, mixed unions). The fallback is intentional: the
 * Phase-1 capabilities are flat objects, so users see proper inputs; Phase-2
 * capabilities can declare richer schemas and degrade gracefully.
 */
import { Input } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import type { CapabilityDescriptor } from "~/queries/capabilities";

interface JsonSchemaLeaf {
	type?: string;
	enum?: unknown[];
	default?: unknown;
	items?: { type?: string };
	description?: string;
	minimum?: number;
	maximum?: number;
}

interface JsonSchemaObject {
	type?: "object";
	properties?: Record<string, JsonSchemaLeaf>;
	required?: string[];
}

interface Props {
	capability: CapabilityDescriptor;
	value: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}

export default function CapabilityActionEditor({
	capability,
	value,
	onChange,
}: Props) {
	const schema = capability.inputSchema as JsonSchemaObject;
	const properties = schema?.properties ?? {};
	const required = useMemo(() => new Set(schema?.required ?? []), [schema]);

	if (!schema || schema.type !== "object" || Object.keys(properties).length === 0) {
		return (
			<p className="text-[11px] text-kumo-subtle italic">
				This action takes no parameters.
			</p>
		);
	}

	const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

	return (
		<div className="space-y-2">
			{Object.entries(properties).map(([key, prop]) => {
				const label =
					(prop.description?.split("\n")[0] ?? key) +
					(required.has(key) ? " *" : "");
				const current = value[key];
				return (
					<FieldRow
						key={key}
						name={key}
						label={label}
						prop={prop}
						value={current}
						onChange={(v) => set(key, v)}
					/>
				);
			})}
		</div>
	);
}

function FieldRow({
	name,
	label,
	prop,
	value,
	onChange,
}: {
	name: string;
	label: string;
	prop: JsonSchemaLeaf;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	// String enum → <select>
	if (prop.type === "string" && Array.isArray(prop.enum)) {
		return (
			<label className="block text-[11px] text-kumo-subtle">
				{label}
				<select
					value={typeof value === "string" ? value : (prop.default as string) ?? ""}
					onChange={(e) => onChange(e.target.value)}
					className="mt-1 w-full bg-kumo-base border border-kumo-line rounded px-2 py-1 text-xs text-kumo-default"
				>
					{prop.enum.map((opt) => (
						<option key={String(opt)} value={String(opt)}>
							{String(opt)}
						</option>
					))}
				</select>
			</label>
		);
	}
	// Boolean → checkbox
	if (prop.type === "boolean") {
		const checked = typeof value === "boolean" ? value : !!prop.default;
		return (
			<label className="flex items-center gap-2 text-[11px] text-kumo-subtle">
				<input
					type="checkbox"
					checked={checked}
					onChange={(e) => onChange(e.target.checked)}
				/>
				{label}
			</label>
		);
	}
	// Number → number input
	if (prop.type === "number" || prop.type === "integer") {
		return (
			<label className="block text-[11px] text-kumo-subtle">
				{label}
				<Input
					type="number"
					value={typeof value === "number" ? String(value) : ""}
					min={prop.minimum}
					max={prop.maximum}
					onChange={(e) =>
						onChange(e.target.value === "" ? undefined : Number(e.target.value))
					}
					className="mt-1 w-full"
				/>
			</label>
		);
	}
	// String array → comma separated
	if (prop.type === "array" && prop.items?.type === "string") {
		const arr = Array.isArray(value) ? (value as string[]) : [];
		return (
			<label className="block text-[11px] text-kumo-subtle">
				{label} (comma-separated)
				<Input
					value={arr.join(", ")}
					onChange={(e) =>
						onChange(
							e.target.value
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
						)
					}
					className="mt-1 w-full"
				/>
			</label>
		);
	}
	// String → text input
	if (prop.type === "string") {
		return (
			<label className="block text-[11px] text-kumo-subtle">
				{label}
				<Input
					type="text"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
					className="mt-1 w-full"
				/>
			</label>
		);
	}
	// Fallback: JSON textarea
	return (
		<JsonFallback name={name} label={label} value={value} onChange={onChange} />
	);
}

function JsonFallback({
	name: _name,
	label,
	value,
	onChange,
}: {
	name: string;
	label: string;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	const [text, setText] = useState(() =>
		value === undefined ? "" : JSON.stringify(value, null, 2),
	);
	const [error, setError] = useState<string | null>(null);
	return (
		<label className="block text-[11px] text-kumo-subtle">
			{label} (JSON)
			<textarea
				value={text}
				onChange={(e) => {
					const t = e.target.value;
					setText(t);
					if (!t.trim()) {
						setError(null);
						onChange(undefined);
						return;
					}
					try {
						onChange(JSON.parse(t));
						setError(null);
					} catch (err) {
						setError((err as Error).message);
					}
				}}
				className="mt-1 w-full bg-kumo-base border border-kumo-line rounded px-2 py-1 text-xs font-mono text-kumo-default"
				rows={3}
			/>
			{error && <span className="text-red-400">{error}</span>}
		</label>
	);
}
