// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * In-process Capability registry. Built-in capabilities self-register at
 * module load time via the barrel (`./index.ts`); the registry is a singleton
 * `Map` so register-once / lookup-many is the entire API surface.
 */
import type {
	Capability,
	CapabilityContext,
	CapabilityResult,
	CapabilitySurface,
} from "./types";

const ID_REGEX = /^[a-z]+:[a-z][a-z0-9-]*$/;

const registry = new Map<string, Capability>();

export function register<I, O>(cap: Capability<I, O>): void {
	if (!ID_REGEX.test(cap.id)) {
		throw new Error(
			`Capability id "${cap.id}" does not match /^[a-z]+:[a-z][a-z0-9-]*$/`,
		);
	}
	if (registry.has(cap.id)) {
		throw new Error(`Capability "${cap.id}" is already registered`);
	}
	registry.set(cap.id, cap as Capability);
}

export function get(id: string): Capability | undefined {
	return registry.get(id);
}

export function list(filter?: { surface?: CapabilitySurface }): Capability[] {
	const all = [...registry.values()];
	if (!filter?.surface) return all;
	return all.filter((c) => c.surfaces.includes(filter.surface!));
}

/**
 * Validate input via the capability's Zod schema, then call `run`. Errors are
 * returned as a discriminated `{ ok: false }` result rather than thrown so the
 * rule executor (which iterates many capabilities for one email) can keep
 * going if any single invocation fails.
 */
export async function invoke<O = unknown>(
	ctx: CapabilityContext,
	id: string,
	rawInput: unknown,
): Promise<CapabilityResult<O>> {
	const cap = registry.get(id);
	if (!cap) {
		return { ok: false, error: `Unknown capability: ${id}`, code: "unknown_capability" };
	}
	const parsed = cap.inputSchema.safeParse(rawInput);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid input for ${id}: ${parsed.error.message}`,
			code: "invalid_input",
		};
	}
	try {
		const value = (await cap.run(ctx, parsed.data)) as O;
		// Warn-only output validation. A capability that misdeclares its
		// outputSchema (or returns garbage on an edge case) should not blow
		// up the rule pipeline — log and pass the raw value through so the
		// downstream consumer can either coerce or shrug.
		if (cap.outputSchema) {
			const out = cap.outputSchema.safeParse(value);
			if (!out.success) {
				console.warn(
					`Capability ${id} v${cap.version} return shape did not match outputSchema: ${out.error.message}`,
				);
			}
		}
		return { ok: true, value };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : `Capability ${id} failed`,
			code: "run_failed",
		};
	}
}
