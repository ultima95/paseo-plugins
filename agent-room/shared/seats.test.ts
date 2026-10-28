import { describe, expect, it } from "vitest";
import {
  AGENT_TITLE_MAX_LENGTH,
  DEFAULT_SETTINGS,
  PEER_TIER_ID_MAX_LENGTH,
  formatMarker,
  parseSeatMarker,
  peerTierIdSchema,
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
describe("peerTierIdSchema", () => {
  it("accepts the longest allowed tier id", () => {
    const id = "a".repeat(PEER_TIER_ID_MAX_LENGTH);
    expect(peerTierIdSchema.safeParse(id).success).toBe(true);
  });

  it("round-trips the longest allowed id through seatTitle and parseSeatMarker", () => {
    const id = "a".repeat(PEER_TIER_ID_MAX_LENGTH);
    // The cap exists so the closing bracket survives the 60-character slice.
    expect(formatMarker({ seat: "peer", tier: id }).length + 1).toBeLessThanOrEqual(
      AGENT_TITLE_MAX_LENGTH,
    );

    const title = seatTitle({ seat: "peer", tier: id }, "probe");
    expect(parseSeatMarker(title)).toEqual({ marker: { seat: "peer", tier: id }, rest: "probe" });

    // A padded title is truncated as designed, and the marker still parses: this
    // is the case that used to lose the closing bracket.
    const long = seatTitle({ seat: "peer", tier: id }, "bounded outcome");
    expect(long).toHaveLength(AGENT_TITLE_MAX_LENGTH);
    expect(parseSeatMarker(long)?.marker).toEqual({ seat: "peer", tier: id });
  });

  it("rejects an id one character past the cap", () => {
    const id = "a".repeat(PEER_TIER_ID_MAX_LENGTH + 1);
    expect(peerTierIdSchema.safeParse(id).success).toBe(false);
  });

  it("fails the settings schema for an over-long tier id", () => {
    const peerTiers = DEFAULT_SETTINGS.peerTiers.map((tier) =>
      tier.id === "default" ? { ...tier, id: "a".repeat(PEER_TIER_ID_MAX_LENGTH + 1) } : tier,
    );
    expect(roomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, peerTiers }).success).toBe(false);
  });

  it("still enforces kebab-case", () => {
    expect(peerTierIdSchema.safeParse("Cross_Family").success).toBe(false);
    expect(peerTierIdSchema.safeParse("cross-family").success).toBe(true);
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
