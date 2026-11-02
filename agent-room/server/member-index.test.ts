import { describe, expect, it } from "vitest";

import { memberRecordSchema } from "../shared/member";
import { indexMembers } from "./member-index";

const member = (id: string, role: "supervisor" | "lead", provider = "claude", model = "claude-opus-5-5") =>
  memberRecordSchema.parse({
    id,
    name: id,
    role,
    provider,
    model,
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  });

describe("indexMembers", () => {
  it("looks members up by id and by seat", () => {
    const index = indexMembers([member("sup", "supervisor"), member("lead", "lead")]);
    expect(index.byId("lead")?.id).toBe("lead");
    expect(index.forSeat("lead", "claude", "claude-opus-5-5")?.id).toBe("lead");
    expect(index.forSeat("supervisor", "claude", "claude-opus-5-5")?.id).toBe("sup");
    expect(index.forSeat("worker", "claude", "claude-opus-5-5")).toBeUndefined();
  });

  it("returns undefined for a seat no member matches", () => {
    const index = indexMembers([member("lead", "lead")]);
    expect(index.forSeat("lead", "codex", "gpt-5.6-sol")).toBeUndefined();
    expect(index.byId("missing")).toBeUndefined();
  });
});
