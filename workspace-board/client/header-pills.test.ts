import { describe, expect, it } from "vitest";
import {
  boardButtonId,
  buttonWorkspaces,
  pillCounts,
  pillSpecs,
} from "./header-pills";

describe("boardButtonId", () => {
  it("prefixes the workspace id with the pill kind", () => {
    expect(boardButtonId("0f3a1c2e-9b7d-4a11", "need")).toBe("board-need-0f3a1c2e-9b7d-4a11");
    expect(boardButtonId("0f3a1c2e-9b7d-4a11", "board")).toBe("board-board-0f3a1c2e-9b7d-4a11");
  });

  it("lowercases and replaces anything a button id cannot hold", () => {
    expect(boardButtonId("A/B_C.D", "run")).toBe("board-run-a-b-c-d");
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

describe("pillSpecs", () => {
  function shown(specs: ReturnType<typeof pillSpecs>) {
    return specs.filter((spec) => spec.visible).map((spec) => `${spec.kind}:${spec.count}`);
  }

  it("shows the two counts as their own pills", () => {
    expect(shown(pillSpecs({ needYou: 2, running: 3 }))).toEqual(["need:2", "run:3"]);
  });

  it("hides a pill whose count is zero", () => {
    expect(shown(pillSpecs({ needYou: 1, running: 0 }))).toEqual(["need:1"]);
    expect(shown(pillSpecs({ needYou: 0, running: 3 }))).toEqual(["run:3"]);
  });

  it("falls back to the board button when nothing is happening", () => {
    expect(shown(pillSpecs({ needYou: 0, running: 0 }))).toEqual(["board:0"]);
  });

  it("names the counts in each pill's title", () => {
    expect(pillSpecs({ needYou: 1, running: 2 }).map((spec) => spec.title)).toEqual([
      "Workspace board · 1 workspace needs you",
      "Workspace board · 2 workspaces are running",
      "Workspace board",
    ]);
  });

  it("carries the count each pill shows", () => {
    expect(pillSpecs({ needYou: 2, running: 1 }).map((spec) => spec.count)).toEqual([2, 1, 0]);
  });
});
