// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Default logging middleware for the capability registry. Emits one line per
 * invocation with the capability id, version, outcome (ok / failure code),
 * and elapsed wall-clock time.
 *
 * Registered via the barrel (`../index.ts`) so it runs at module load time,
 * before any route handler reaches `invokeCapability`.
 */
import { addMiddleware, type CapabilityMiddleware } from "../registry";

const loggingMiddleware: CapabilityMiddleware = async (ctx, cap, _input, next) => {
	const start = Date.now();
	const result = await next();
	const elapsed = Date.now() - start;
	const tag = result.ok ? "ok" : result.code;
	console.log(
		`[capability] ${cap.id} v${cap.version} | ${tag} | ${elapsed}ms | trigger=${ctx.triggeredBy}`,
	);
	return result;
};

addMiddleware(loggingMiddleware);
