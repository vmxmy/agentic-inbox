import { describe, it, expect } from "vitest";
import {
	serializeInternalAuthContext,
	parseInternalAuthContext,
} from "../workers/lib/auth";
import type { Env } from "../workers/types";

const mkEnv = (secret: string) =>
	({
		INTERNAL_SECRET: secret,
	}) as unknown as Env;

describe("internal auth context envelope", () => {
	it("round-trips a regular user", async () => {
		const env = mkEnv("test-secret-vitest");
		const user = {
			id: "usr_alice",
			email: "alice@example.com",
			role: "user" as const,
		};
		const token = await serializeInternalAuthContext(user, env);
		const parsed = await parseInternalAuthContext(token, env);
		expect(parsed.id).toBe("usr_alice");
		expect(parsed.email).toBe("alice@example.com");
		expect(parsed.role).toBe("user");
		expect(parsed.system).toBeUndefined();
	});

	it("preserves admin role and system flag", async () => {
		const env = mkEnv("test-secret-vitest");
		const user = {
			id: "__system__",
			email: "__system__",
			role: "admin" as const,
			system: true,
		};
		const token = await serializeInternalAuthContext(user, env);
		const parsed = await parseInternalAuthContext(token, env);
		expect(parsed.role).toBe("admin");
		expect(parsed.system).toBe(true);
	});

	it("rejects a token signed with a different secret", async () => {
		const minter = mkEnv("secret-A");
		const verifier = mkEnv("secret-B");
		const user = {
			id: "usr_alice",
			email: "alice@example.com",
			role: "user" as const,
		};
		const token = await serializeInternalAuthContext(user, minter);
		await expect(parseInternalAuthContext(token, verifier)).rejects.toThrow();
	});

	it("normalizes email casing on serialize", async () => {
		const env = mkEnv("test-secret-vitest");
		const user = {
			id: "usr_alice",
			email: "Alice@Example.COM",
			role: "user" as const,
		};
		const token = await serializeInternalAuthContext(user, env);
		const parsed = await parseInternalAuthContext(token, env);
		expect(parsed.email).toBe("alice@example.com");
	});
});
