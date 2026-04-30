// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compile-only verification for request identity extraction. Production
 * requests trust Cloudflare Access JWT claims; dev requests may use the
 * documented X-Dev-User impersonation header.
 */
import {
	extractVerifiedEmailFromAccessClaims,
	requestIdentityFromAccessClaims,
	requestIdentityFromDevUserHeader,
	type RequestIdentity,
} from "./request-identity";

// --- Type-level helpers ----------------------------------------------------

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

type Expect<T extends true> = T;

type _RequestIdentityShape = Expect<
	Equal<keyof RequestIdentity, "email" | "source">
>;

// --- Inert scenarios -------------------------------------------------------

export function verifyAccessEmailClaimIsNormalized(): RequestIdentity {
	const identity = requestIdentityFromAccessClaims({ email: "Alice@Example.COM" });
	if (!identity || identity.email !== "alice@example.com") {
		throw new Error("Access email claim should normalize to lowercase email");
	}
	if (identity.source !== "cloudflare-access") {
		throw new Error("Access identity source drift");
	}
	return identity;
}

export function verifyNestedAccessEmailClaimIsAccepted(): string {
	const email = extractVerifiedEmailFromAccessClaims({
		identity: { email: "Nested@Example.com" },
	});
	if (email !== "nested@example.com") {
		throw new Error("nested Access email claim should be accepted");
	}
	return email;
}

export function verifyMissingEmailClaimFailsClosed(): void {
	const identity = requestIdentityFromAccessClaims({ sub: "not-an-email-subject" });
	if (identity !== null) {
		throw new Error("missing verified email should fail closed");
	}
}

export function verifyDevHeaderIdentity(): RequestIdentity {
	const identity = requestIdentityFromDevUserHeader("Dev@Example.com");
	if (!identity || identity.email !== "dev@example.com") {
		throw new Error("dev user header should normalize email");
	}
	if (identity.source !== "dev-header") {
		throw new Error("dev identity source drift");
	}
	return identity;
}

export type RequestIdentityVerificationCases = {
	identityShape: _RequestIdentityShape;
};
