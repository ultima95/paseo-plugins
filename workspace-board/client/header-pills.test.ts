import { describe, expect, it } from "vitest";
import { columnIcon } from "./column-accent";
import {
  boardButtonId,
  buttonWorkspaces,
  PILL_ICON,
  pillCounts,
  pillSpecs,
} from "./header-pills";

describe("boardButtonId", () => {
  it("prefixes the workspace id with the pill kind", () => {
    expect(boardButtonId("0f3a1c2e-9b7d-4a11", "blocked")).toBe(
      "board-blocked-0f3a1c2e-9b7d-4a11",
    );
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
  it("counts blocked and failed workspaces separately from review", () => {
    expect(
      pillCounts([
        { id: "a", status: "needs_input" },
        { id: "b", status: "failed" },
        { id: "c", status: "attention" },
      ]),
    ).toEqual({ blocked: 2, review: 1, running: 0, finished: 0 });
  });

  it("counts running and finished workspaces apart", () => {
    expect(
      pillCounts([
        { id: "a", status: "running" },
        { id: "b", status: "running" },
        { id: "c", status: "done" },
        { id: "d", status: "done" },
        { id: "e", status: "done" },
      ]),
    ).toEqual({ blocked: 0, review: 0, running: 2, finished: 3 });
  });

  it("keeps a parked workspace out of the counts until it needs someone", () => {
    expect(pillCounts([{ id: "a", status: "done", labels: ["Parked"] }])).toEqual({
      blocked: 0,
      review: 0,
      running: 0,
      finished: 0,
    });
    expect(pillCounts([{ id: "a", status: "needs_input", labels: ["Parked"] }])).toEqual({
      blocked: 1,
      review: 0,
      running: 0,
      finished: 0,
    });
  });

  it("skips background and archiving workspaces", () => {
    expect(
      pillCounts([
        { id: "a", status: "running", background: true },
        { id: "b", status: "needs_input", archivingAt: "2026-11-25T00:00:00Z" },
        { id: "c", status: "running" },
      ]),
    ).toEqual({ blocked: 0, review: 0, running: 1, finished: 0 });
  });

  it("skips a child workspace the board never draws", () => {
    expect(
      pillCounts([
        { id: "a", status: "running", parentWorkspaceId: "parent" },
        { id: "b", status: "needs_input", parentWorkspaceId: "parent" },
      ]),
    ).toEqual({ blocked: 0, review: 0, running: 0, finished: 0 });
  });
});

describe("pillSpecs", () => {
  const counts = { blocked: 2, review: 1, running: 3, finished: 4 };
  const zero = { blocked: 0, review: 0, running: 0, finished: 0 };

  function shown(specs: ReturnType<typeof pillSpecs>) {
    return specs.filter((spec) => spec.visible).map((spec) => `${spec.kind}:${spec.count}`);
  }

  it("shows each column as its own pill", () => {
    expect(shown(pillSpecs(counts))).toEqual(["blocked:2", "review:1", "run:3", "done:4"]);
  });

  it("hides a pill whose count is zero", () => {
    expect(shown(pillSpecs({ ...zero, blocked: 1 }))).toEqual(["blocked:1"]);
    expect(shown(pillSpecs({ ...zero, review: 2 }))).toEqual(["review:2"]);
    expect(shown(pillSpecs({ ...zero, running: 3 }))).toEqual(["run:3"]);
    expect(shown(pillSpecs({ ...zero, finished: 2 }))).toEqual(["done:2"]);
  });

  it("falls back to the board button when nothing is happening", () => {
    expect(shown(pillSpecs(zero))).toEqual(["board:0"]);
  });

  it("names the counts in each pill's title", () => {
    expect(pillSpecs({ blocked: 1, review: 2, running: 3, finished: 4 }).map((s) => s.title)).toEqual(
      [
        "Workspace board · 1 workspace needs input",
        "Workspace board · 2 workspaces to review",
        "Workspace board · 3 workspaces are running",
        "Workspace board · 4 workspaces finished",
        "Workspace board",
      ],
    );
  });

  it("carries the count and label each pill shows", () => {
    const specs = pillSpecs(counts);
    expect(specs.map((spec) => spec.count)).toEqual([2, 1, 3, 4, 0]);
    expect(specs.map((spec) => spec.label)).toEqual(["2", "1", "3", "4", undefined]);
  });

  it("uses the board's own column glyph for every pill", () => {
    expect(PILL_ICON.blocked).toBe(columnIcon("needs-you"));
    expect(PILL_ICON.review).toBe(columnIcon("review"));
    expect(PILL_ICON.run).toBe(columnIcon("running"));
    expect(PILL_ICON.done).toBe(columnIcon("idle"));
  });
});
