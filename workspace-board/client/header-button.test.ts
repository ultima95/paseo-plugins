import { describe, expect, it } from "vitest";
import { boardButtonId, buttonWorkspaces } from "./header-button";

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
