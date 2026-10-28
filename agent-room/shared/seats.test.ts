import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseSeatMarker,
  roomSettingsSchema,
  seatConfigFor,
  seatTitle,
} from "./seats";

describe("parseSeatMarker", () => {
  it.each([
    ["[room:supervisor] Fix auth", { seat: "supervisor" }, "Fix auth"],
    ["[room:lead] API", { seat: "lead" }, "API"],
    ["[room:peer:cheap] format logs", { seat: "peer", tier: "cheap" }, "format logs"],
    ["[Room:Lead] API", { seat: "lead" }, "API"],
    ["  [room:peer] x", { seat: "peer", tier: "default" }, "x"],
    ["[room:lead]API", { seat: "lead" }, "API"],
    ["[ROOM:PEER:Review] y", { seat: "peer", tier: "review" }, "y"],
  ])("parses %s", (title, marker, rest) => {
    expect(parseSeatMarker(title)).toEqual({ marker, rest });
  });
  it.each([null, undefined, "", "[Lead] old room", "[Peer] old", "Fix [room:lead] x", "[room:boss] x", "[room:peer:Bad_Tier] x"])(
    "ignores %s", (title) => expect(parseSeatMarker(title)).toBeNull());
});
describe("seatTitle", () => {
  it("keeps the marker and caps at 60 chars", () => {
    const t = seatTitle({ seat: "supervisor" }, "x".repeat(200));
    expect(t.startsWith("[room:supervisor] ")).toBe(true);
    expect(t.length).toBe(60);
  });
  it("round-trips through parseSeatMarker", () => {
    expect(parseSeatMarker(seatTitle({ seat: "peer", tier: "review" }, "check diff"))?.marker)
      .toEqual({ seat: "peer", tier: "review" });
  });
});
describe("seatConfigFor", () => {
  it("returns the tier config", () => {
    expect(seatConfigFor({ seat: "peer", tier: "cheap" }, DEFAULT_SETTINGS).config.model).toBe("claude-haiku-4-5");
  });
  it("falls back to default for an unknown tier", () => {
    const r = seatConfigFor({ seat: "peer", tier: "nope" }, DEFAULT_SETTINGS);
    expect(r.config.model).toBe("claude-sonnet-5-5");
    expect(r.fallbackFrom).toBe("nope");
  });
});
describe("roomSettingsSchema", () => {
  it("accepts DEFAULT_SETTINGS", () => expect(roomSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true));
  it("rejects settings without a default tier", () => {
    const peerTiers = DEFAULT_SETTINGS.peerTiers.filter((t) => t.id !== "default");
    expect(roomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, peerTiers }).success).toBe(false);
  });
  it("rejects duplicate tier ids", () => {
    const peerTiers = [...DEFAULT_SETTINGS.peerTiers, DEFAULT_SETTINGS.peerTiers[0]];
    expect(roomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, peerTiers }).success).toBe(false);
  });
});
