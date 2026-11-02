import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, roleByName } from "../shared/roles";
import { checkSpawn } from "./guard";

const roles = DEFAULT_SETTINGS.roles;
const supervisor = roleByName("Supervisor", roles)!;
const lead = roleByName("Lead", roles)!;
const reviewer = roleByName("Reviewer", roles)!;
const implementer = roleByName("Implementer", roles)!;

describe("checkSpawn", () => {
  it.each([
    [null, null, true],
    [null, supervisor, true],
    [supervisor, lead, true],
    [supervisor, reviewer, false],
    [supervisor, null, false],
    [lead, implementer, true],
    [lead, lead, false],
    [lead, supervisor, false],
    [lead, null, false],
    [reviewer, implementer, false],
    [reviewer, null, false],
  ])("parent %j child %j → %s", (parent, child, ok) => {
    expect(checkSpawn(parent as never, child as never, roles).allowed).toBe(ok);
  });

  it("names the role the violator should have used", () => {
    const fromSupervisor = checkSpawn(supervisor, null, roles);
    const fromLead = checkSpawn(lead, null, roles);
    const fromWorker = checkSpawn(reviewer, implementer, roles);

    if (fromSupervisor.allowed || fromLead.allowed || fromWorker.allowed) throw new Error("expected denials");
    expect(fromSupervisor.rule).toContain("Lead:");
    expect(fromLead.rule).toContain("Implementer:");
    expect(fromWorker.rule).toContain("creates no agents");
  });
});
