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
import { getMailboxAcl, isAdmin, normalizeEmail, type AuthUser } from "../auth";

/**
 * Middleware wraps every `invoke` call. Chains in registration order; the
 * last middleware's `next()` invokes the underlying capability through the
 * permission / input-validation / run / output-validation pipeline.
 *
 * Use cases: logging, metrics, rate-limiting, tracing, ACL hooks. Keep
 * middleware lean — every capability invocation pays the cost.
 */
export type CapabilityMiddleware = (
	ctx: CapabilityContext,
	cap: Capability,
	rawInput: unknown,
	next: () => Promise<CapabilityResult>,
) => Promise<CapabilityResult>;

const ID_REGEX = /^[a-z]+:[a-z][a-z0-9-]*$/;

const registry = new Map<string, Capability>();
const middlewares: CapabilityMiddleware[] = [];

/** Register a middleware at module load time. Order matters — earlier-added
 *  middlewares wrap later-added ones, with the capability run at the centre. */
export function addMiddleware(mw: CapabilityMiddleware): void {
	middlewares.push(mw);
}

export function register<I, O>(cap: Capability<I, O>): void {
	if (!ID_REGEX.test(cap.id)) {
		throw new Error(
			`Capability id "${cap.id}" does not match /^[a-z]+:[a-z][a-z0-9-]*$/`,
		);
	}
	if (registry.has(cap.id)) {
		throw new Error(`Capability "${cap.id}" is already registered`);
	}
	// All three surfaces now thread an authenticated user into
	// CapabilityContext when one is available:
	//   - rule-action: rule-triggered calls bypass the owner gate (rules were
	//     authored under PUT-time fingerprint checks).
	//   - agent-tool: workers/agent/index.ts:EmailAgent decodes the signed
	//     INTERNAL_AUTH_CONTEXT_HEADER in fetch() and forwards `user` to
	//     invoke().
	//   - mcp-tool: workers/mcp/index.ts does the same — admin role is
	//     carried inside the signed token so no D1 round-trip is needed.
	// System-triggered agent dispatch (auto-draft from receiveEmail) leaves
	// `user` null — owner-only capabilities will deny in that path, which
	// is intentional (the system isn't authorised to invoke owner power).
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
 *
 * Every call walks the registered middleware chain (see `addMiddleware`)
 * before reaching the core permission / validate / run / validate-output
 * pipeline. Composed calls (via `ctx.invoke`) walk the same chain, so a
 * logging middleware sees nested invocations as separate entries.
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
	// Koa-style chain dispatch with a per-position called guard. Calling
	// `next()` twice from the same middleware advances the chain twice and
	// would otherwise re-run downstream middleware (and runCore) — log loudly
	// and reject the second call rather than execute the capability twice.
	let i = -1;
	let lastCalled = -1;
	const dispatch = async (): Promise<CapabilityResult> => {
		i += 1;
		if (i <= lastCalled) {
			console.error(
				`Capability ${cap.id}: middleware called next() multiple times`,
			);
			return {
				ok: false,
				error: `middleware misuse: next() called multiple times`,
				code: "middleware_misuse",
			};
		}
		lastCalled = i;
		if (i < middlewares.length) {
			return middlewares[i](ctx, cap, rawInput, dispatch);
		}
		return runCore(ctx, cap, rawInput);
	};
	return dispatch() as Promise<CapabilityResult<O>>;
}

/** Core pipeline: permission → input validate → run → output validate.
 *  Reached after all middlewares have called `next()`. */
async function runCore(
	ctx: CapabilityContext,
	cap: Capability,
	rawInput: unknown,
): Promise<CapabilityResult> {
	// Permission gate. Rule-triggered invocations bypass — the rule itself
	// was authored under PUT-time ownership rules (see workers/index.ts:
	// PUT /api/v1/mailboxes/:id and PUT .../rules), so re-checking here
	// would also block legitimate rules from running.
	if (cap.permission === "owner" && ctx.triggeredBy !== "rule") {
		const denied = await checkOwnerPermission(ctx);
		if (denied) return denied;
	}

	const parsed = cap.inputSchema.safeParse(rawInput);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid input for ${cap.id}: ${parsed.error.message}`,
			code: "invalid_input",
		};
	}
	// Synthesise ctx.invoke so the capability can compose calls to siblings
	// without re-plumbing env / mailboxId / user. Composed calls re-enter
	// `invoke` and therefore walk the middleware chain (logging sees them
	// as nested invocations) and the permission gate.
	const childCtx: CapabilityContext = {
		...ctx,
		invoke: <O>(id: string, input: unknown) => invoke<O>(childCtx, id, input),
	};
	try {
		const value = await cap.run(childCtx, parsed.data);
		// Warn-only output validation. A capability that misdeclares its
		// outputSchema (or returns garbage on an edge case) should not blow
		// up the rule pipeline — log and pass the raw value through so the
		// downstream consumer can either coerce or shrug.
		if (cap.outputSchema) {
			const out = cap.outputSchema.safeParse(value);
			if (!out.success) {
				console.warn(
					`Capability ${cap.id} v${cap.version} return shape did not match outputSchema: ${out.error.message}`,
				);
			}
		}
		return { ok: true, value };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : `Capability ${cap.id} failed`,
			code: "run_failed",
		};
	}
}

/**
 * Owner-permission check used by `invoke` for capabilities that declare
 * `permission: "owner"`. Returns a `permission_denied` failure result when
 * the caller is not the mailbox owner (and not a global admin); returns
 * `null` when the caller is allowed to proceed.
 */
async function checkOwnerPermission(
	ctx: CapabilityContext,
): Promise<CapabilityResult | null> {
	if (!ctx.user) {
		return {
			ok: false,
			error: "Owner-only capability requires an authenticated caller",
			code: "permission_denied",
		};
	}
	// Admins bypass — same policy the rest of the codebase applies (see
	// workers/lib/auth.ts:assertMailboxOwner).
	if (isAdmin(ctx.env, ctx.user as AuthUser)) return null;
	const acl = await getMailboxAcl(ctx.env, ctx.mailboxId);
	if (!acl?.owner) {
		return {
			ok: false,
			error: `Mailbox "${ctx.mailboxId}" has no owner — owner-only capability cannot be invoked`,
			code: "permission_denied",
		};
	}
	if (normalizeEmail(ctx.user.email) !== acl.owner) {
		return {
			ok: false,
			error: "Owner-only capability requires the mailbox owner",
			code: "permission_denied",
		};
	}
	return null;
}
