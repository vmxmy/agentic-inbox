// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * D1-backed team/user mailbox directory.
 *
 * This is the control-plane source of truth for the admin-managed team model:
 * teams own `team@root-domain` mailboxes, team users own
 * `team.user@root-domain` mailboxes, and `address_registry.mailbox_id`
 * remains the full email address used as the transitional MailboxDO name.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
	addressRegistry,
	teams,
	teamUsers,
	type AddressRegistryRow,
	type TeamRow,
	type TeamUserRow,
} from "../db/team-schema";
import {
	deriveTeamAddress,
	deriveTeamUserAddress,
	isConfiguredRootDomain,
	requireAddressSlug,
} from "./team-addresses";
import { getMailboxRecord } from "./mailbox-directory";
import { createUser, findUserByEmail, type UserRecord } from "./users";
import type { Env } from "../types";

export type AddressKind = "team" | "team_user" | "legacy_fixed";

export class TeamDirectoryError extends Error {
	constructor(
		public readonly status: 400 | 404 | 409,
		message: string,
	) {
		super(message);
		this.name = "TeamDirectoryError";
	}
}

export interface TeamRecord {
	id: string;
	slug: string;
	displayName: string;
	primaryAddress: string;
	createdByUserId: string | null;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
}

export interface TeamUserRecord {
	id: string;
	teamId: string;
	userId: string;
	slug: string;
	mailboxAddress: string;
	createdByUserId: string | null;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
}

export interface AddressRegistryRecord {
	address: string;
	kind: AddressKind;
	teamId: string | null;
	teamUserId: string | null;
	mailboxId: string;
	active: boolean;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
}

export interface TeamMailboxMeta {
	address: AddressRegistryRecord;
	team: TeamRecord;
	teamUser: TeamUserRecord | null;
}

export interface ResolvedAddress {
	address: string;
	kind: AddressKind;
	mailboxId: string;
	teamId: string | null;
	teamUserId: string | null;
}

function db(env: Env) {
	return drizzle(env.DB);
}

function now(): number {
	return Date.now();
}

function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function isExplicitLegacyAddress(
	address: string,
	env: { EMAIL_ADDRESSES?: string[] | null },
): boolean {
	const normalized = normalizeAddress(address);
	return ((env.EMAIL_ADDRESSES ?? []) as string[])
		.map(normalizeAddress)
		.includes(normalized);
}

function rowToTeam(row: TeamRow): TeamRecord {
	return {
		id: row.id,
		slug: row.slug,
		displayName: row.displayName,
		primaryAddress: row.primaryAddress,
		createdByUserId: row.createdByUserId ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		disabledAt: row.disabledAt ?? null,
	};
}

function rowToTeamUser(row: TeamUserRow): TeamUserRecord {
	return {
		id: row.id,
		teamId: row.teamId,
		userId: row.userId,
		slug: row.slug,
		mailboxAddress: row.mailboxAddress,
		createdByUserId: row.createdByUserId ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		disabledAt: row.disabledAt ?? null,
	};
}

function rowToAddress(row: AddressRegistryRow): AddressRegistryRecord {
	return {
		address: row.address,
		kind: row.kind as AddressKind,
		teamId: row.teamId ?? null,
		teamUserId: row.teamUserId ?? null,
		mailboxId: row.mailboxId,
		active: row.active === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		disabledAt: row.disabledAt ?? null,
	};
}

function activeAddressWhere(address: string) {
	return and(
		eq(addressRegistry.address, normalizeAddress(address)),
		eq(addressRegistry.active, 1),
		isNull(addressRegistry.disabledAt),
	);
}

function activeTeamWhere(teamId: string) {
	return and(eq(teams.id, teamId), isNull(teams.disabledAt));
}

function activeTeamUserWhere(teamUserId: string) {
	return and(eq(teamUsers.id, teamUserId), isNull(teamUsers.disabledAt));
}

async function getAnyAddressRecord(
	env: Env,
	address: string,
): Promise<AddressRegistryRecord | null> {
	const rows = await db(env)
		.select()
		.from(addressRegistry)
		.where(eq(addressRegistry.address, normalizeAddress(address)))
		.limit(1);
	return rows[0] ? rowToAddress(rows[0]) : null;
}

async function assertAddressAvailable(env: Env, address: string): Promise<void> {
	const normalized = normalizeAddress(address);
	if (await getAnyAddressRecord(env, normalized)) {
		throw new TeamDirectoryError(409, "Address is already registered");
	}
	if (await getMailboxRecord(env, normalized)) {
		throw new TeamDirectoryError(409, "Address already has a mailbox");
	}
}

function isConstraintError(e: unknown): boolean {
	return e instanceof Error && /unique|constraint|primary key/i.test(e.message);
}

// -- Reads ----------------------------------------------------------

export async function listTeams(env: Env): Promise<TeamRecord[]> {
	const rows = await db(env)
		.select()
		.from(teams)
		.where(isNull(teams.disabledAt))
		.orderBy(asc(teams.slug));
	return rows.map(rowToTeam);
}

export async function getTeamById(
	env: Env,
	teamId: string,
): Promise<TeamRecord | null> {
	const rows = await db(env)
		.select()
		.from(teams)
		.where(activeTeamWhere(teamId))
		.limit(1);
	return rows[0] ? rowToTeam(rows[0]) : null;
}

async function getAnyTeamById(
	env: Env,
	teamId: string,
): Promise<TeamRecord | null> {
	const rows = await db(env)
		.select()
		.from(teams)
		.where(eq(teams.id, teamId))
		.limit(1);
	return rows[0] ? rowToTeam(rows[0]) : null;
}

export async function getTeamBySlug(
	env: Env,
	slugInput: string,
): Promise<TeamRecord | null> {
	const slug = requireAddressSlug(slugInput, "team name");
	const rows = await db(env)
		.select()
		.from(teams)
		.where(and(eq(teams.slug, slug), isNull(teams.disabledAt)))
		.limit(1);
	return rows[0] ? rowToTeam(rows[0]) : null;
}

export async function listTeamUsers(
	env: Env,
	teamId: string,
): Promise<TeamUserRecord[]> {
	const team = await getTeamById(env, teamId);
	if (!team) throw new TeamDirectoryError(404, "Team not found");
	const rows = await db(env)
		.select()
		.from(teamUsers)
		.where(and(eq(teamUsers.teamId, teamId), isNull(teamUsers.disabledAt)))
		.orderBy(asc(teamUsers.slug));
	return rows.map(rowToTeamUser);
}

export async function getTeamUserById(
	env: Env,
	teamUserId: string,
): Promise<TeamUserRecord | null> {
	const rows = await db(env)
		.select()
		.from(teamUsers)
		.where(activeTeamUserWhere(teamUserId))
		.limit(1);
	return rows[0] ? rowToTeamUser(rows[0]) : null;
}

export async function getTeamUserByTeamAndId(
	env: Env,
	teamId: string,
	teamUserId: string,
): Promise<TeamUserRecord | null> {
	const rows = await db(env)
		.select()
		.from(teamUsers)
		.where(and(eq(teamUsers.teamId, teamId), eq(teamUsers.id, teamUserId)))
		.limit(1);
	return rows[0] ? rowToTeamUser(rows[0]) : null;
}

export async function getTeamUserForAuthUser(
	env: Env,
	user: { id: string },
): Promise<{ team: TeamRecord; teamUser: TeamUserRecord } | null> {
	const rows = await db(env)
		.select()
		.from(teamUsers)
		.where(and(eq(teamUsers.userId, user.id), isNull(teamUsers.disabledAt)))
		.limit(1);
	if (!rows[0]) return null;
	const teamUser = rowToTeamUser(rows[0]);
	const team = await getTeamById(env, teamUser.teamId);
	if (!team) return null;
	return { team, teamUser };
}

export async function getActiveAddressRecord(
	env: Env,
	address: string,
): Promise<AddressRegistryRecord | null> {
	const rows = await db(env)
		.select()
		.from(addressRegistry)
		.where(activeAddressWhere(address))
		.limit(1);
	return rows[0] ? rowToAddress(rows[0]) : null;
}

export async function getTeamMailboxMeta(
	env: Env,
	mailboxId: string,
): Promise<TeamMailboxMeta | null> {
	const id = normalizeAddress(mailboxId);
	const rows = await db(env)
		.select()
		.from(addressRegistry)
		.where(and(
			eq(addressRegistry.mailboxId, id),
			eq(addressRegistry.active, 1),
			isNull(addressRegistry.disabledAt),
			or(eq(addressRegistry.kind, "team"), eq(addressRegistry.kind, "team_user")),
		))
		.limit(1);
	if (!rows[0]?.teamId) return null;
	const address = rowToAddress(rows[0]);
	const team = await getTeamById(env, rows[0].teamId);
	if (!team) return null;
	const teamUser = rows[0].teamUserId
		? await getTeamUserById(env, rows[0].teamUserId)
		: null;
	if (rows[0].kind === "team_user" && !teamUser) return null;
	return { address, team, teamUser };
}

export async function isTeamManagedMailbox(
	env: Env,
	mailboxId: string,
): Promise<boolean> {
	return (await getTeamMailboxMeta(env, mailboxId)) !== null;
}

export async function listTeamMailboxesForUser(
	env: Env,
	user: { id: string },
): Promise<Array<{ id: string; email: string; teamId: string; kind: "team" | "team_user" }>> {
	const membership = await getTeamUserForAuthUser(env, user);
	if (!membership) return [];
	const result: Array<{ id: string; email: string; teamId: string; kind: "team" | "team_user" }> = [];
	const teamAddress = await getActiveAddressRecord(env, membership.team.primaryAddress);
	if (teamAddress?.kind === "team" && teamAddress.teamId === membership.team.id) {
		result.push({
			id: teamAddress.mailboxId,
			email: teamAddress.address,
			teamId: membership.team.id,
			kind: "team",
		});
	}
	const userAddress = await getActiveAddressRecord(env, membership.teamUser.mailboxAddress);
	if (
		userAddress?.kind === "team_user" &&
		userAddress.teamId === membership.team.id &&
		userAddress.teamUserId === membership.teamUser.id
	) {
		result.push({
			id: userAddress.mailboxId,
			email: userAddress.address,
			teamId: membership.team.id,
			kind: "team_user",
		});
	}
	return result;
}

// -- Writes ---------------------------------------------------------

export interface CreateTeamInput {
	name: string;
	displayName: string;
	createdByUserId: string | null;
}

export async function createTeam(
	env: Env,
	input: CreateTeamInput,
): Promise<TeamRecord> {
	const slug = requireAddressSlug(input.name, "team name");
	const displayName = input.displayName.trim();
	if (!displayName) throw new TeamDirectoryError(400, "displayName is required");
	const primaryAddress = deriveTeamAddress(slug, env);
	if (await getTeamBySlug(env, slug)) {
		throw new TeamDirectoryError(409, "Team already exists");
	}
	await assertAddressAvailable(env, primaryAddress);

	const ts = now();
	const id = crypto.randomUUID();
	try {
		await db(env).insert(teams).values({
			id,
			slug,
			displayName,
			primaryAddress,
			createdByUserId: input.createdByUserId,
			createdAt: ts,
			updatedAt: ts,
		});
		await db(env).insert(addressRegistry).values({
			address: primaryAddress,
			kind: "team",
			teamId: id,
			teamUserId: null,
			mailboxId: primaryAddress,
			active: 0,
			createdAt: ts,
			updatedAt: ts,
		});
	} catch (e) {
		await db(env).delete(teams).where(eq(teams.id, id)).catch(() => undefined);
		if (isConstraintError(e)) throw new TeamDirectoryError(409, "Team or address already exists");
		throw e;
	}
	return (await getTeamById(env, id))!;
}

export interface CreateTeamUserInput {
	teamId: string;
	userName: string;
	displayName: string;
	createdByUserId: string | null;
}

export async function createTeamUser(
	env: Env,
	input: CreateTeamUserInput,
): Promise<{ teamUser: TeamUserRecord; user: UserRecord; team: TeamRecord }> {
	const team = await getTeamById(env, input.teamId);
	if (!team) throw new TeamDirectoryError(404, "Team not found");
	const slug = requireAddressSlug(input.userName, "user name");
	const displayName = input.displayName.trim();
	if (!displayName) throw new TeamDirectoryError(400, "displayName is required");
	const mailboxAddress = deriveTeamUserAddress(team.slug, slug, env);

	const duplicateRows = await db(env)
		.select()
		.from(teamUsers)
		.where(and(
			eq(teamUsers.teamId, team.id),
			eq(teamUsers.slug, slug),
			isNull(teamUsers.disabledAt),
		))
		.limit(1);
	if (duplicateRows[0]) throw new TeamDirectoryError(409, "Team user already exists");
	await assertAddressAvailable(env, mailboxAddress);

	let user = await findUserByEmail(env, mailboxAddress);
	if (!user) {
		user = await createUser(env, {
			email: mailboxAddress,
			displayName,
			emailVerifiedAt: Date.now(),
		});
	}
	const activeForUser = await getTeamUserForAuthUser(env, user);
	if (activeForUser) {
		throw new TeamDirectoryError(409, "User is already assigned to a team");
	}

	const ts = now();
	const id = crypto.randomUUID();
	try {
		await db(env).insert(teamUsers).values({
			id,
			teamId: team.id,
			userId: user.id,
			slug,
			mailboxAddress,
			createdByUserId: input.createdByUserId,
			createdAt: ts,
			updatedAt: ts,
		});
		await db(env).insert(addressRegistry).values({
			address: mailboxAddress,
			kind: "team_user",
			teamId: team.id,
			teamUserId: id,
			mailboxId: mailboxAddress,
			active: 0,
			createdAt: ts,
			updatedAt: ts,
		});
	} catch (e) {
		await db(env).delete(teamUsers).where(eq(teamUsers.id, id)).catch(() => undefined);
		if (isConstraintError(e)) throw new TeamDirectoryError(409, "Team user or address already exists");
		throw e;
	}
	const teamUser = await getTeamUserById(env, id);
	if (!teamUser) throw new TeamDirectoryError(404, "Team user was not created");
	return { teamUser, user, team };
}


export interface UpdateTeamInput {
	displayName?: string;
	disabled?: boolean;
}

export async function updateTeam(
	env: Env,
	teamId: string,
	input: UpdateTeamInput,
): Promise<TeamRecord> {
	const existing = await getAnyTeamById(env, teamId);
	if (!existing) throw new TeamDirectoryError(404, "Team not found");

	const ts = now();
	const patch: Partial<TeamRow> = { updatedAt: ts };
	if (input.displayName !== undefined) {
		const displayName = input.displayName.trim();
		if (!displayName) throw new TeamDirectoryError(400, "displayName is required");
		patch.displayName = displayName;
	}
	if (input.disabled !== undefined) {
		patch.disabledAt = input.disabled ? ts : null;
	}

	await db(env).update(teams).set(patch).where(eq(teams.id, teamId));
	const updated = await getAnyTeamById(env, teamId);
	if (!updated) throw new TeamDirectoryError(404, "Team not found");
	return updated;
}

export interface UpdateTeamUserInput {
	displayName?: string;
	disabled?: boolean;
}

export async function updateTeamUser(
	env: Env,
	teamId: string,
	teamUserId: string,
	input: UpdateTeamUserInput,
): Promise<TeamUserRecord> {
	const team = await getAnyTeamById(env, teamId);
	if (!team) throw new TeamDirectoryError(404, "Team not found");
	const existing = await getTeamUserByTeamAndId(env, teamId, teamUserId);
	if (!existing) throw new TeamDirectoryError(404, "Team user not found");

	const ts = now();
	const patch: Partial<TeamUserRow> = { updatedAt: ts };
	if (input.displayName !== undefined) {
		const displayName = input.displayName.trim();
		if (!displayName) throw new TeamDirectoryError(400, "displayName is required");
		patch.displayName = displayName;
	}
	if (input.disabled !== undefined) {
		patch.disabledAt = input.disabled ? ts : null;
	}

	await db(env).update(teamUsers).set(patch).where(eq(teamUsers.id, teamUserId));
	const updated = await getTeamUserByTeamAndId(env, teamId, teamUserId);
	if (!updated) throw new TeamDirectoryError(404, "Team user not found");
	return updated;
}

export async function activateRegisteredAddress(
	env: Env,
	address: string,
): Promise<void> {
	const normalized = normalizeAddress(address);
	await db(env)
		.update(addressRegistry)
		.set({ active: 1, disabledAt: null, updatedAt: now() })
		.where(eq(addressRegistry.address, normalized));
}

export async function deleteTeamForProvisioningRollback(
	env: Env,
	teamId: string,
): Promise<void> {
	await db(env).delete(addressRegistry).where(eq(addressRegistry.teamId, teamId));
	await db(env).delete(teamUsers).where(eq(teamUsers.teamId, teamId));
	await db(env).delete(teams).where(eq(teams.id, teamId));
}

export async function deleteTeamUserForProvisioningRollback(
	env: Env,
	teamUserId: string,
): Promise<void> {
	await db(env).delete(addressRegistry).where(eq(addressRegistry.teamUserId, teamUserId));
	await db(env).delete(teamUsers).where(eq(teamUsers.id, teamUserId));
}

// -- Resolution and access -----------------------------------------

export async function resolveAddress(
	env: Env,
	rawAddress: string,
): Promise<ResolvedAddress | null> {
	const address = normalizeAddress(rawAddress);
	if (!address.includes("@")) return null;
	if (!isConfiguredRootDomain(address, env)) return null;

	const registered = await getActiveAddressRecord(env, address);
	if (registered) {
		return {
			address: registered.address,
			kind: registered.kind,
			mailboxId: registered.mailboxId,
			teamId: registered.teamId,
			teamUserId: registered.teamUserId,
		};
	}

	if (isExplicitLegacyAddress(address, env) && await getMailboxRecord(env, address)) {
		return { address, kind: "legacy_fixed", mailboxId: address, teamId: null, teamUserId: null };
	}

	return null;
}

export async function hasTeamMailboxAccess(
	env: Env,
	mailboxId: string,
	user: { id: string; system?: boolean },
): Promise<boolean | null> {
	const meta = await getTeamMailboxMeta(env, mailboxId);
	if (!meta) return null;
	if (user.system) return true;
	const membership = await getTeamUserForAuthUser(env, user);
	if (!membership) return false;
	if (meta.address.kind === "team") {
		return membership.team.id === meta.team.id;
	}
	return membership.teamUser.id === meta.teamUser?.id;
}
