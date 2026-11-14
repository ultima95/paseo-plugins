import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  classify,
  formatAge,
  groupBoard,
  isChildWorkspace,
  isOnBoard,
  matchesFilter,
  needsYou,
  type BoardWorkspace,
} from "./board-model";

function ws(overrides: Partial<BoardWorkspace> = {}): BoardWorkspace {
  return {
    indicator: "done",
    labels: [],
    background: false,
    archivingAt: null,
    ...overrides,
  } as BoardWorkspace;
}

const ind = (indicator: string) => ({ indicator }) as Partial<BoardWorkspace>;

describe("classify", () => {
  it("maps indicators to columns", () => {
    expect(classify(ws(ind("needs_input")))).toBe("needs-you");
    expect(classify(ws(ind("failed")))).toBe("needs-you");
    expect(classify(ws(ind("running")))).toBe("running");
    expect(classify(ws(ind("attention")))).toBe("review");
    expect(classify(ws(ind("done")))).toBe("idle");
  });

  it("parks done and running workspaces labelled Parked", () => {
    expect(classify(ws({ ...ind("done"), labels: ["Parked"] }))).toBe("parked");
    expect(classify(ws({ ...ind("running"), labels: ["Parked"] }))).toBe("parked");
  });

  it("compares the Parked label case-insensitively", () => {
    expect(classify(ws({ ...ind("done"), labels: ["parked"] }))).toBe("parked");
    expect(classify(ws({ ...ind("done"), labels: ["Other"] }))).toBe("idle");
  });

  it("lets urgent indicators leave Parked", () => {
    expect(classify(ws({ ...ind("needs_input"), labels: ["Parked"] }))).toBe("needs-you");
    expect(classify(ws({ ...ind("failed"), labels: ["Parked"] }))).toBe("needs-you");
    expect(classify(ws({ ...ind("attention"), labels: ["Parked"] }))).toBe("review");
  });
});

describe("isOnBoard", () => {
  it("excludes background and archiving workspaces", () => {
    expect(isOnBoard(ws({ background: true }))).toBe(false);
    expect(isOnBoard(ws({ archivingAt: "2026-11-14T00:00:00Z" }))).toBe(false);
    expect(isOnBoard(ws())).toBe(true);
  });
});

describe("needsYou", () => {
  it("is true for needs_input, failed, attention, even parked", () => {
    for (const i of ["needs_input", "failed", "attention"]) {
      expect(needsYou(ws(ind(i)))).toBe(true);
      expect(needsYou(ws({ ...ind(i), labels: ["Parked"] }))).toBe(true);
    }
  });

  it("is false for running, done and parked done", () => {
    expect(needsYou(ws(ind("running")))).toBe(false);
    expect(needsYou(ws(ind("done")))).toBe(false);
    expect(needsYou(ws({ ...ind("done"), labels: ["Parked"] }))).toBe(false);
  });

  it("is false for background workspaces", () => {
    expect(needsYou(ws({ ...ind("needs_input"), background: true }))).toBe(false);
  });
});

describe("isChildWorkspace", () => {
  it("marks a workspace with a parent", () => {
    expect(isChildWorkspace({ parentWorkspaceId: "wks_parent" })).toBe(true);
  });

  it("treats a missing or null parent as a root workspace", () => {
    expect(isChildWorkspace({ parentWorkspaceId: null })).toBe(false);
    expect(isChildWorkspace({})).toBe(false);
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it("returns null for null and unparsable input", () => {
    expect(formatAge(null, now)).toBeNull();
    expect(formatAge("garbage", now)).toBeNull();
  });

  it("formats each unit", () => {
    expect(formatAge(ago(30_000), now)).toBe("now");
    expect(formatAge(ago(5 * MIN), now)).toBe("5m");
    expect(formatAge(ago(59 * MIN), now)).toBe("59m");
    expect(formatAge(ago(2 * HOUR), now)).toBe("2h");
    expect(formatAge(ago(23 * HOUR), now)).toBe("23h");
    expect(formatAge(ago(48 * HOUR), now)).toBe("2d");
  });

  it("treats future timestamps as now", () => {
    expect(formatAge(new Date(now + HOUR).toISOString(), now)).toBe("now");
  });
});

describe("matchesFilter", () => {
  const item = { title: "Pre-order feature", name: "wks-1", projectDisplayName: "CRM" };

  it("matches everything for an empty or blank query", () => {
    expect(matchesFilter(item, "")).toBe(true);
    expect(matchesFilter(item, "   ")).toBe(true);
  });

  it("matches title, name and project case-insensitively", () => {
    expect(matchesFilter(item, "pre-ORDER")).toBe(true);
    expect(matchesFilter(item, "crm")).toBe(true);
    expect(matchesFilter(item, "wks")).toBe(true);
  });

  it("falls back to the name when the title is null", () => {
    expect(matchesFilter({ ...item, title: null }, "wks-1")).toBe(true);
  });

  it("rejects a query found nowhere and trims the query", () => {
    expect(matchesFilter(item, "billing")).toBe(false);
    expect(matchesFilter(item, "  crm  ")).toBe(true);
  });
});

describe("groupBoard", () => {
  const card = (id: string, overrides: Partial<BoardWorkspace> = {}, statusEnteredAt: string | null = null) => ({
    ...ws(overrides),
    id,
    statusEnteredAt,
  });

  it("returns all five columns even when empty", () => {
    const grouped = groupBoard([]);
    expect(Object.keys(grouped)).toEqual(["needs-you", "running", "review", "idle", "parked"]);
    expect(Object.values(grouped).every((items) => items.length === 0)).toBe(true);
  });

  it("puts each workspace in its classified column", () => {
    const grouped = groupBoard([
      card("a", ind("needs_input")),
      card("b", ind("running")),
      card("c", ind("attention")),
      card("d", ind("done")),
      card("e", { ...ind("done"), labels: ["Parked"] }),
    ]);
    expect(grouped["needs-you"].map((c) => c.id)).toEqual(["a"]);
    expect(grouped.running.map((c) => c.id)).toEqual(["b"]);
    expect(grouped.review.map((c) => c.id)).toEqual(["c"]);
    expect(grouped.idle.map((c) => c.id)).toEqual(["d"]);
    expect(grouped.parked.map((c) => c.id)).toEqual(["e"]);
  });

  it("leaves out background and archiving workspaces", () => {
    const grouped = groupBoard([
      card("bg", { background: true }),
      card("gone", { archivingAt: "2026-11-14T00:00:00Z" }),
      card("kept"),
    ]);
    expect(Object.values(grouped).flat().map((c) => c.id)).toEqual(["kept"]);
  });

  it("orders a column newest state first, nulls last, ties in input order", () => {
    const grouped = groupBoard([
      card("none", {}, null),
      card("old", {}, "2026-11-14T08:00:00Z"),
      card("new", {}, "2026-11-14T11:00:00Z"),
      card("tie-1", {}, "2026-11-14T09:00:00Z"),
      card("tie-2", {}, "2026-11-14T09:00:00Z"),
      card("bad", {}, "garbage"),
    ]);
    expect(grouped.idle.map((c) => c.id)).toEqual(["new", "tie-1", "tie-2", "old", "none", "bad"]);
  });
});

describe("COLUMNS", () => {
  it("has the five columns in order", () => {
    expect(COLUMNS.map((c) => c.id)).toEqual(["needs-you", "running", "review", "idle", "parked"]);
    expect(COLUMNS.map((c) => c.title)).toEqual(["Needs you", "Running", "Review", "Idle", "Parked"]);
  });
});
