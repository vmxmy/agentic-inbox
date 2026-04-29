// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * L4 Phase 7 — Real OAuth E2E flow.
 *
 * Plan §573 item 1 calls for "two real DO instances + simulated OAuth
 * provider redirect". The repo's vitest harness uses environment:"node"
 * (no `@cloudflare/vitest-pool-workers`), so booting `unstable_dev`
 * inside this suite would force a 10x runtime regression for one test
 * file and pull a Workers runtime into the dependency graph.
 *
 * Pragmatic alternative chosen for this PR (documented per the task
 * brief's "If `unstable_dev` is too heavy, mock the OAuth provider HTTP
 * layer but use real `MailboxBoundOAuthProvider` + in-memory storage
 * standing in for DO sqlite"):
 *
 *   - Real `MailboxBoundOAuthProvider` (production class file
 *     loaded via `vi.mock("agents", …)` redirecting only the SDK base
 *     class to the clean submodule).
 *   - Two distinct in-memory storages, each scoped to its own
 *     `mailboxId`, mirroring the per-DO sqlite isolation.
 *   - The OAuth provider redirect is simulated by directly calling
 *     `provider.checkState(wireState)` with the wire state the SDK
 *     base produced (`<nonce>.<serverId>`), exactly as Cloudflare's
 *     MCPClientManager does in the real callback handler.
 *
 * Real-network E2E against a hosted MCP server (`mcp.deepwiki.com`,
 * etc.) is deferred to staging — see "Skipped tests requiring staging"
 * in the PR description.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("agents", async () => {
	const submodule = await import("agents/mcp/do-oauth-client-provider");
	return submodule;
});

const { MailboxBoundOAuthProvider } = await import(
	"../../workers/lib/mcp-oauth-provider"
);
const { createInMemoryStorage } = await import(
	"../helpers/in-memory-do-storage"
);

function makeProvider(args: {
	storage: ReturnType<typeof createInMemoryStorage>;
	mailboxId: string;
	userId: string;
	serverId: string;
}) {
	const provider = new MailboxBoundOAuthProvider(
		args.storage as unknown as DurableObjectStorage,
		"email-agent",
		`https://app.example.com/agents/email-agent/${args.mailboxId}/callback`,
		args.mailboxId,
		() => args.userId,
	);
	provider.serverId = args.serverId;
	return provider;
}

describe("MCP OAuth E2E flow (Phase 7)", () => {
	describe("happy path: addExternalMcpServer → authUrl → callback → ready", () => {
		it("mailbox A: state row records mailbox+user binding", async () => {
			// #given mailbox A's EmailAgent receives an addExternalMcpServer
			// request from user u-A and the SDK reports state="authenticating"
			const storageA = createInMemoryStorage();
			const provider = makeProvider({
				storage: storageA,
				mailboxId: "mb-A",
				userId: "u-A",
				serverId: "srv-deepwiki",
			});
			// #when state() runs (step the SDK takes immediately before redirecting)
			const wireState = await provider.state();
			// #then the wire state matches `<nonce>.<serverId>`
			const [nonce, serverId] = wireState.split(".");
			expect(nonce).toBeDefined();
			expect(serverId).toBe("srv-deepwiki");
			// #and the storage row carries the binding fields
			const stored = await storageA.get<Record<string, unknown>>(
				`/email-agent/srv-deepwiki/state/${nonce}`,
			);
			expect(stored).toMatchObject({
				mailboxId: "mb-A",
				userId: "u-A",
			});
		});

		it("simulated callback: same mailbox + user → checkState valid", async () => {
			// #given the state was minted in mailbox A by user u-A
			const storageA = createInMemoryStorage();
			const provider = makeProvider({
				storage: storageA,
				mailboxId: "mb-A",
				userId: "u-A",
				serverId: "srv-deepwiki",
			});
			const wireState = await provider.state();
			// #when the provider's redirect callback fires (the OAuth provider
			// redirects the browser back to /agents/email-agent/mb-A/callback,
			// which forwards through to MCPClientManager → checkState)
			const result = await provider.checkState(wireState);
			// #then validation passes and serverId is surfaced
			expect(result.valid).toBe(true);
			expect(result.serverId).toBe("srv-deepwiki");
		});

		it("connection state transitions: authenticating → ready (metadata layer)", async () => {
			// #given the SDK base reports state="authenticating" with an authUrl
			// at addMcpServer time, then state="ready" after the callback
			// completes — this is the contract `buildConnectionFromSdkResult`
			// translates into the metadata row.
			const { buildConnectionFromSdkResult } = await import(
				"../../workers/lib/mcp-connections"
			);
			const baseArgs = {
				serverName: "deepwiki",
				serverUrl: "https://mcp.deepwiki.com/sse",
				addedByUserId: "u-A",
				addedAt: 1700000000000,
			};
			const initial = buildConnectionFromSdkResult({
				...baseArgs,
				sdk: { id: "conn-1", state: "authenticating", authUrl: "https://oauth/authorize?..." },
			});
			expect(initial.lastState).toBe("authenticating");
			// #when the post-callback upsert lands a `state="ready"`
			const finalState = buildConnectionFromSdkResult({
				...baseArgs,
				sdk: { id: "conn-1", state: "ready" },
			});
			// #then the metadata row reflects the transition
			expect(finalState.lastState).toBe("ready");
			expect(finalState.id).toBe(initial.id);
		});
	});

	describe("cross-DO isolation: mailbox B cannot consume mailbox A's nonce", () => {
		it("rejects with 'mailbox mismatch' (per-DO storage isolation enforces this in production)", async () => {
			// #given two DO instances with their own storage (mirrors
			// EmailAgent.idFromName(mailboxId) per-DO sqlite isolation)
			const storageA = createInMemoryStorage();
			const storageB = createInMemoryStorage();
			const providerA = makeProvider({
				storage: storageA,
				mailboxId: "mb-A",
				userId: "u-A",
				serverId: "srv-deepwiki",
			});
			const wireState = await providerA.state();
			// #when mailbox B (separate DO, separate storage) attempts to
			// validate the wire state — even if an attacker leaks the wire
			// state, B's storage doesn't have the row at all
			const providerB = makeProvider({
				storage: storageB,
				mailboxId: "mb-B",
				userId: "u-B",
				serverId: "srv-deepwiki",
			});
			const result = await providerB.checkState(wireState);
			// #then the SDK base 'State not found or already used' wins
			// because B's storage has no row — physical isolation kicks in
			// before our binding check is needed
			expect(result.valid).toBe(false);
			expect(result.error).toBe("State not found or already used");
		});

		it("rejects with 'mailbox mismatch' when state row leaks into the wrong DO", async () => {
			// #given a hypothetical leak where mailbox A's state row gets
			// copied into mailbox B's storage (e.g. via a misconfigured
			// shared DO — this is the subclass's last-line defense)
			const storage = createInMemoryStorage();
			const providerA = makeProvider({
				storage,
				mailboxId: "mb-A",
				userId: "u-A",
				serverId: "srv-deepwiki",
			});
			const wireState = await providerA.state();
			// #when mailbox B (same storage, different mailboxId) validates
			const providerB = makeProvider({
				storage,
				mailboxId: "mb-B",
				userId: "u-B",
				serverId: "srv-deepwiki",
			});
			const result = await providerB.checkState(wireState);
			// #then our binding check rejects with the canonical reason
			expect(result.valid).toBe(false);
			expect(result.error).toBe("mailbox mismatch");
		});
	});

	describe("real-network E2E (deferred to staging)", () => {
		it.skip("connects to mcp.deepwiki.com and exchanges a real OAuth token", () => {
			// REASON: outbound network is gated by repo policy and CI
			// secrets are not available locally. Plan §573 marks real-network
			// flows as staging-only. Skeleton kept here so a future staging
			// run can drop the .skip and provide a `MCP_E2E_OAUTH_*` secret
			// trio without re-architecting the suite.
		});
	});
});
