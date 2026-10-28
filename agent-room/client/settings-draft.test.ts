import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema } from "../shared/seats";
import type { PeerTier, RoomSettings, SeatConfig } from "../shared/seats";
import {
  addTier,
  changeProvider,
  removeTier,
  setSeat,
  setTier,
  validateDraft,
} from "./settings-draft";

const parses = (draft: unknown): boolean => roomSettingsSchema.safeParse(draft).success;

const defaultTier = (settings: RoomSettings): PeerTier => {
  const tier = settings.peerTiers.find((candidate) => candidate.id === "default");
  if (!tier) throw new Error("DEFAULT_SETTINGS lost its default tier");
  return tier;
};

describe("changeProvider", () => {
  it("clears the model, the mode, the thinking option and the features", () => {
    const seat: SeatConfig = {
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      features: { webSearch: true },
    };

    expect(changeProvider(seat, "codex")).toEqual({ provider: "codex" });
  });

  it("keeps the seat when the provider does not change", () => {
    const seat: SeatConfig = { provider: "claude", model: "claude-opus-5-5" };

    expect(changeProvider(seat, "claude")).toEqual(seat);
  });
});

describe("setSeat", () => {
  it("keeps the document valid when only the model moves", () => {
    const next = setSeat(DEFAULT_SETTINGS, "lead", { model: "claude-sonnet-5-5" });

    expect(next.lead.model).toBe("claude-sonnet-5-5");
    expect(parses(next)).toBe(true);
  });

  it("clears the provider-specific fields when the provider moves", () => {
    const next = setSeat(DEFAULT_SETTINGS, "supervisor", { provider: "codex" });

    expect(next.supervisor).toEqual({ provider: "codex" });
    expect(defaultTier(DEFAULT_SETTINGS).provider).toBe("claude");
    expect(parses(next)).toBe(false);
  });

  it("passes the schema again once the new provider has a model", () => {
    const switched = setSeat(DEFAULT_SETTINGS, "supervisor", { provider: "codex" });
    const completed = setSeat(switched, "supervisor", { model: "gpt-5.6-sol" });

    expect(completed.supervisor).toEqual({ provider: "codex", model: "gpt-5.6-sol" });
    expect(parses(completed)).toBe(true);
  });

  it("leaves the other seat alone", () => {
    const next = setSeat(DEFAULT_SETTINGS, "lead", { model: "claude-sonnet-5-5" });

    expect(next.supervisor).toEqual(DEFAULT_SETTINGS.supervisor);
  });
});

describe("setTier", () => {
  it("patches one tier and keeps the document valid", () => {
    const next = setTier(DEFAULT_SETTINGS, "cheap", { useFor: "Log triage only" });
    const tier = next.peerTiers.find((candidate) => candidate.id === "cheap");

    expect(tier?.useFor).toBe("Log triage only");
    expect(parses(next)).toBe(true);
  });

  it("never renames a tier, because seat markers point at the id", () => {
    const next = setTier(DEFAULT_SETTINGS, "cheap", { id: "renamed" });

    expect(next.peerTiers.map((tier) => tier.id)).toEqual(
      DEFAULT_SETTINGS.peerTiers.map((tier) => tier.id),
    );
  });

  it("returns the draft unchanged for an unknown tier", () => {
    expect(setTier(DEFAULT_SETTINGS, "missing", { useFor: "x" })).toBe(DEFAULT_SETTINGS);
  });
});

describe("addTier", () => {
  it("copies the default tier's config under the new id with an empty useFor", () => {
    const source = defaultTier(DEFAULT_SETTINGS);
    const next = addTier(DEFAULT_SETTINGS, "triage");
    const added = next.peerTiers.find((candidate) => candidate.id === "triage");

    expect(added).toEqual({
      id: "triage",
      provider: source.provider,
      model: source.model,
      modeId: source.modeId,
      thinkingOptionId: source.thinkingOptionId,
      useFor: "",
    });
    expect(next.peerTiers).toHaveLength(DEFAULT_SETTINGS.peerTiers.length + 1);
    expect(DEFAULT_SETTINGS.peerTiers).toHaveLength(6);
  });

  it("produces a tier the schema rejects until it has a useFor", () => {
    const next = addTier(DEFAULT_SETTINGS, "triage");

    expect(parses(next)).toBe(false);
    const filled = setTier(next, "triage", { useFor: "Mechanical edits" });
    expect(parses(filled)).toBe(true);
  });

  it("refuses an id that is already taken", () => {
    expect(addTier(DEFAULT_SETTINGS, "cheap")).toBe(DEFAULT_SETTINGS);
  });

  it("refuses an id that is not lowercase kebab-case", () => {
    expect(addTier(DEFAULT_SETTINGS, "Bad_Tier")).toBe(DEFAULT_SETTINGS);
    expect(addTier(DEFAULT_SETTINGS, "9lives")).toBe(DEFAULT_SETTINGS);
  });

  it("does not share the copied feature map with the default tier", () => {
    // Built from the stored document, not from a draft: `TierDraft` allows a
    // missing model, and this fixture has to be a savable `RoomSettings`.
    const source: RoomSettings = {
      ...DEFAULT_SETTINGS,
      peerTiers: DEFAULT_SETTINGS.peerTiers.map((tier) =>
        tier.id === "default" ? { ...tier, features: { webSearch: true } } : tier,
      ),
    };

    const next = addTier(source, "triage");
    const added = next.peerTiers.find((candidate) => candidate.id === "triage");
    const original = defaultTier(source);

    expect(added?.features).toEqual({ webSearch: true });
    expect(added?.features).not.toBe(original.features);
  });
});

describe("removeTier", () => {
  it("refuses the default tier", () => {
    expect(removeTier(DEFAULT_SETTINGS, "default")).toBe(DEFAULT_SETTINGS);
  });

  it("drops a peer tier and keeps the document valid", () => {
    const next = removeTier(DEFAULT_SETTINGS, "cheap");

    expect(next.peerTiers.some((tier) => tier.id === "cheap")).toBe(false);
    expect(parses(next)).toBe(true);
  });

  it("returns the draft unchanged for an unknown tier", () => {
    expect(removeTier(DEFAULT_SETTINGS, "missing")).toBe(DEFAULT_SETTINGS);
  });
});

describe("reducers never mutate the draft", () => {
  it("leaves the input untouched", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);

    setSeat(DEFAULT_SETTINGS, "lead", { provider: "codex" });
    setTier(DEFAULT_SETTINGS, "cheap", { useFor: "changed" });
    addTier(DEFAULT_SETTINGS, "triage");
    removeTier(DEFAULT_SETTINGS, "cheap");
    changeProvider(DEFAULT_SETTINGS.supervisor, "codex");

    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});

describe("validateDraft", () => {
  it("returns the parsed settings for a valid draft", () => {
    const result = validateDraft(DEFAULT_SETTINGS);

    expect(result.ok).toBe(true);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("reports the blocking field for a new tier without a useFor", () => {
    const result = validateDraft(addTier(DEFAULT_SETTINGS, "triage"));

    expect(result.ok).toBe(false);
    expect(result.settings).toBeNull();
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toContain("useFor");
  });

  it("reports a seat that is waiting for a model", () => {
    const result = validateDraft(setSeat(DEFAULT_SETTINGS, "lead", { provider: "codex" }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("model");
  });
});
