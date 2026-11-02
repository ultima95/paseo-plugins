import { describe, expect, it } from "vitest";

import { formatMarker, parseSeatMarker, seatTitle } from "./seats";

describe("parseSeatMarker (legacy)", () => {
  it.each([
    ["[room:supervisor] Fix auth", { seat: "supervisor" }, "Fix auth"],
    ["[room:lead] API", { seat: "lead" }, "API"],
    ["[room:peer:cheap] format logs", { seat: "peer", tier: "cheap" }, "format logs"],
    ["[Room:Lead] API", { seat: "lead" }, "API"],
    ["  [room:peer] x", { seat: "peer", tier: "default" }, "x"],
  ])("parses %s", (title, marker, rest) => {
    expect(parseSeatMarker(title)).toEqual({ marker, rest });
  });

  it.each([null, undefined, "", "Reviewer: x", "Fix [room:lead] x", "[room:boss] x"])(
    "ignores %s",
    (title) => expect(parseSeatMarker(title)).toBeNull(),
  );
});

describe("legacy title helpers", () => {
  it("still renders a legacy marker for tests and migration", () => {
    expect(formatMarker({ seat: "peer", tier: "review" })).toBe("[room:peer:review]");
    expect(seatTitle({ seat: "lead" }, "API")).toBe("[room:lead] API");
  });

  it("caps a legacy title at 60", () => {
    const title = seatTitle({ seat: "supervisor" }, "x".repeat(200));
    expect(title).toHaveLength(60);
    expect(parseSeatMarker(title)?.marker).toEqual({ seat: "supervisor" });
  });
});
