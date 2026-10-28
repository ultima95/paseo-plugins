import { describe, expect, it } from "vitest";

import { checkSpawn } from "./guard";

describe("checkSpawn", () => {
  it.each([
    [null, null, true],
    [null, { seat: "lead" }, true],
    [{ seat: "supervisor" }, { seat: "lead" }, true],
    [{ seat: "supervisor" }, { seat: "peer", tier: "default" }, false],
    [{ seat: "supervisor" }, null, false],
    [{ seat: "lead" }, { seat: "peer", tier: "cheap" }, true],
    [{ seat: "lead" }, { seat: "lead" }, false],
    [{ seat: "lead" }, { seat: "supervisor" }, false],
    [{ seat: "lead" }, null, false],
    [{ seat: "peer", tier: "default" }, { seat: "peer", tier: "default" }, false],
    [{ seat: "peer", tier: "default" }, null, false],
  ])("parent %j child %j → %s", (p, c, ok) => {
    expect(checkSpawn(p as never, c as never).allowed).toBe(ok);
  });

  it("lets any child through when the parent is not a room seat", () => {
    for (const child of [null, { seat: "supervisor" }, { seat: "lead" }, { seat: "peer", tier: "cheap" }]) {
      expect(checkSpawn(null, child as never)).toEqual({ allowed: true });
    }
  });

  it("names the correct marker in the broken rule", () => {
    const supervisor = checkSpawn({ seat: "supervisor" }, null);
    const lead = checkSpawn({ seat: "lead" }, null);
    const peer = checkSpawn({ seat: "peer", tier: "cheap" }, { seat: "lead" });

    expect(supervisor.allowed).toBe(false);
    expect(lead.allowed).toBe(false);
    expect(peer.allowed).toBe(false);
    if (supervisor.allowed || lead.allowed || peer.allowed) return;

    expect(supervisor.rule).toContain("[room:lead]");
    expect(lead.rule).toContain("[room:peer:");
    expect(peer.rule).toContain("[room:peer");
    expect(peer.rule).toContain("no agents");
  });
});
