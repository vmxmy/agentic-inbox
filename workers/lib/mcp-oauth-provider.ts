// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * MailboxBoundOAuthProvider — a `DurableObjectOAuthClientProvider` subclass
 * that binds OAuth state rows to the EmailAgent's mailboxId and the user
 * making the current request.
 *
 * Why this exists (Phase 3, source-resolved 2026-04-29):
 *   The plan v4 strategy of stuffing an HMAC into the OAuth `state`
 *   query parameter was infeasible — Cloudflare's MCPClientManager
 *   owns the wire format (`<nonce>.<serverId>`) and validates it
 *   strictly via `extractServerIdFromState`. We bind at the storage
 *   layer instead:
 *     1. `state()` lets the SDK base mint the wire state, then layers
 *        `{mailboxId, userId}` onto the storage row written under
 *        `OAuthProvider.stateKey(nonce)`.
 *     2. `checkState()` runs SDK validation first; on success it reads
 *        the storage row and verifies both bindings match the current
 *        request context.
 *
 * Why a closure for `userId`:
 *   The SDK constructs the provider once per `addMcpServer` call and
 *   reuses the instance for the matching `checkState()` callback. If
 *   we captured `userId` in the constructor it would freeze to the
 *   user who originally added the server. Instead we close over the
 *   EmailAgent's `currentUser` field via `readCurrentUserId`, so each
 *   call reads the request user fresh — which is the actual safety
 *   property we want for Pre-mortem #1.
 *
 * Plan reference: §60-65 (Architecture Decisions), §286-322 (Phase 3
 * implementation), §410-423 (Pre-mortem #1 mitigations).
 */

import { DurableObjectOAuthClientProvider } from "agents";
import {
	applyBoundFields,
	validateBoundState,
	type BoundStateRow,
} from "./mcp-connections";
import type {
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export type ResolvedCredentials = {
	clientId: string;
	clientSecret?: string;
	scopes?: string[];
};

export class MailboxBoundOAuthProvider extends DurableObjectOAuthClientProvider {
	readonly mailboxId: string;
	private readonly readCurrentUserId: () => string;
	private readonly _resolvedCredentials?: ResolvedCredentials;

	constructor(
		storage: DurableObjectStorage,
		clientName: string,
		baseRedirectUrl: string,
		mailboxId: string,
		readCurrentUserId: () => string,
		resolvedCredentials?: ResolvedCredentials,
	) {
		super(storage, clientName, baseRedirectUrl);
		if (resolvedCredentials) {
			void this.saveClientInformation({
				client_id: resolvedCredentials.clientId,
				...(resolvedCredentials.clientSecret && {
					client_secret: resolvedCredentials.clientSecret,
				}),
			} as OAuthClientInformationFull);
		}
		this.mailboxId = mailboxId;
		this.readCurrentUserId = readCurrentUserId;
		this._resolvedCredentials = resolvedCredentials;
	}

	override get clientId(): string {
		if (this._resolvedCredentials) {
			return this._resolvedCredentials.clientId;
		}
		return super.clientId;
	}

	override get clientMetadata(): OAuthClientMetadata {
		const base = super.clientMetadata;
		if (this._resolvedCredentials?.scopes?.length) {
			return {
				...base,
				scope: this._resolvedCredentials.scopes.join(" "),
			};
		}
		return base;
	}

	override async clientInformation(): Promise<OAuthClientInformation | undefined> {
		if (this._resolvedCredentials) {
			return {
				client_id: this._resolvedCredentials.clientId,
				...(this._resolvedCredentials.clientSecret && {
					client_secret: this._resolvedCredentials.clientSecret,
				}),
			};
		}
		return super.clientInformation();
	}

	override async state(): Promise<string> {
		const wireState = await super.state();
		const [nonce] = wireState.split(".");
		if (!nonce) return wireState;
		const key = this.stateKey(nonce);
		const stored = (await this.storage.get(key)) as
			| Record<string, unknown>
			| undefined;
		if (stored) {
			const augmented = applyBoundFields(stored, {
				mailboxId: this.mailboxId,
				userId: this.readCurrentUserId(),
			});
			await this.storage.put(key, augmented);
		}
		return wireState;
	}

	override async checkState(state: string): Promise<{
		valid: boolean;
		serverId?: string;
		error?: string;
	}> {
		const baseResult = await super.checkState(state);
		if (!baseResult.valid) return baseResult;
		const [nonce] = state.split(".");
		if (!nonce) return baseResult;
		const stored = (await this.storage.get(this.stateKey(nonce))) as
			| BoundStateRow
			| undefined;
		const bindingResult = validateBoundState(stored, {
			mailboxId: this.mailboxId,
			userId: this.readCurrentUserId(),
		});
		if (!bindingResult.valid) {
			return { valid: false, error: bindingResult.error };
		}
		return baseResult;
	}
}
