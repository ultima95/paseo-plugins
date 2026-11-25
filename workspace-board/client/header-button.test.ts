import { describe, expect, it } from "vitest";
import {
  boardButtonId,
  buttonWorkspaces,
  pillCounts,
  pillLabel,
} from "./header-button";

describe("boardButtonId", () => {
  it("prefixes the workspace id with a letter", () => {
    expect(boardButtonId("0f3a1c2e-9b7d-4a11-8c3e-2d5f6a7b8c9d")).toBe(
      "board-0f3a1c2e-9b7d-4a11-8c3e-2d5f6a7b8c9d",
    );
  });

  it("lowercases and replaces anything a button id cannot hold", () => {
    expect(boardButtonId("A/B_C.D")).toBe("board-a-b-c-d");
  });
});

describe("buttonWorkspaces", () => {
  it("names every open workspace", () => {
    expect(buttonWorkspaces([{ id: "a" }, { id: "b", background: false }])).toEqual(["a", "b"]);
  });

  it("leaves background workspaces out", () => {
    expect(buttonWorkspaces([{ id: "a", background: true }, { id: "b" }])).toEqual(["b"]);
  });
});

describe("pillCounts", () => {
  it("counts blocked, failed and finished workspaces as needing the user", () => {
    expect(
      pillCounts([
        { id: "a", status: "needs_input" },
        { id: "b", status: "failed" },
        { id: "c", status: "attention" },
      ]),
    ).toEqual({ needYou: 3, running: 0 });
  });

  it("counts only running workspaces as running", () => {
    expect(pillCounts([{ id: "a", status: "running" }, { id: "b", status: "done" }])).toEqual({
      needYou: 0,
      running: 1,
    });
  });

  it("keeps a parked workspace out of the counts until it needs someone", () => {
    expect(pillCounts([{ id: "a", status: "done", labels: ["Parked"] }])).toEqual({
      needYou: 0,
      running: 0,
    });
    expect(pillCounts([{ id: "a", status: "needs_input", labels: ["Parked"] }])).toEqual({
      needYou: 1,
      running: 0,
    });
  });

  it("skips background and archiving workspaces", () => {
    expect(
      pillCounts([
        { id: "a", status: "running", background: true },
        { id: "b", status: "needs_input", archivingAt: "2026-11-25T00:00:00Z" },
        { id: "c", status: "running" },
      ]),
    ).toEqual({ needYou: 0, running: 1 });
  });

  it("skips a child workspace the board never draws", () => {
    expect(
      pillCounts([
        { id: "a", status: "running", parentWorkspaceId: "parent" },
        { id: "b", status: "needs_input", parentWorkspaceId: "parent" },
      ]),
    ).toEqual({ needYou: 0, running: 0 });
  });
});

describe("pillLabel", () => {
  it("says both counts when there are both", () => {
    expect(pillLabel({ needYou: 2, running: 3 })).toBe("2 need you · 3 running");
  });

  it("reads right for one", () => {
    expect(pillLabel({ needYou: 1, running: 0 })).toBe("1 needs you");
    expect(pillLabel({ needYou: 0, running: 1 })).toBe("1 running");
  });

  it("says nothing when the board is quiet", () => {
    expect(pillLabel({ needYou: 0, running: 0 })).toBeUndefined();
  });
});
