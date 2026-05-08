import { describe, expect, it } from "vitest";
import { addressRegistry, teams, teamUsers } from "../workers/db/team-schema";

describe("team D1 schema", () => {
	it("exports team/user/address tables with expected names", () => {
		expect(teams[Symbol.for("drizzle:Name") as keyof typeof teams]).toBe("teams");
		expect(teamUsers[Symbol.for("drizzle:Name") as keyof typeof teamUsers]).toBe("team_users");
		expect(addressRegistry[Symbol.for("drizzle:Name") as keyof typeof addressRegistry]).toBe("address_registry");
	});
});
