import { describe, expect, it } from "vitest";

import {
  EPISODE_SIGNAL_KINDS,
  candidatesFromFacts,
  episodeFactFor,
  redactSecrets,
} from "./episode";

const event = (label: string, text = "x") => ({
  at: "2026-11-02T10:00:00.000Z",
  label,
  text,
});

describe("episodeFactFor", () => {
  it("maps only the five signals", () => {
    expect(episodeFactFor(event("DECISION_NEEDED"), "lead")?.fact.kind).toBe("decision");
    expect(episodeFactFor(event("REJECT"), "lead")?.fact.kind).toBe("rejected");
    expect(episodeFactFor(event("BLOCKED"), "lead")?.fact.kind).toBe("blocked");
    expect(episodeFactFor(event("ACCEPT"), "lead")?.fact.kind).toBe("outcome");
    expect(episodeFactFor(event("DONE"), "lead")?.fact.kind).toBe("outcome");
  });

  it("ignores every other label", () => {
    for (const label of ["CANDIDATE", "REVIEW", "STATUS", "task", "instruction"]) {
      expect(episodeFactFor(event(label), "lead")).toBeNull();
    }
  });

  it("ignores worker turns even when the signal matches", () => {
    expect(episodeFactFor(event("DONE"), "worker")).toBeNull();
    expect(episodeFactFor(event("DONE"), undefined)).toBeNull();
  });

  it("keeps the signal, stamps the event time and redacts the text", () => {
    const result = episodeFactFor(event("DONE", "shipped with sk-abcdefgh1234"), "supervisor");
    expect(result).toEqual({
      fact: {
        at: "2026-11-02T10:00:00.000Z",
        kind: "outcome",
        signal: "DONE",
        text: "shipped with [redacted]",
      },
      redactions: 1,
    });
  });

  it("drops a signal with no text, which would not parse as a fact", () => {
    expect(episodeFactFor(event("DONE", "   "), "lead")).toBeNull();
  });
});

describe("EPISODE_SIGNAL_KINDS", () => {
  it("maps exactly the five signals", () => {
    expect(EPISODE_SIGNAL_KINDS).toEqual({
      DECISION_NEEDED: "decision",
      REJECT: "rejected",
      BLOCKED: "blocked",
      ACCEPT: "outcome",
      DONE: "outcome",
    });
  });
});

describe("redactSecrets", () => {
  it("redacts obvious token shapes and counts them", () => {
    const result = redactSecrets(
      "key sk-abcdefgh1234 and ghp_abcdefghijklmnopqrst and AKIAABCDEFGHIJKLMNOP",
    );
    expect(result.text).not.toContain("sk-");
    expect(result.text).not.toContain("ghp_");
    expect(result.text).not.toContain("AKIA");
    expect(result.redactions).toBe(3);
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("use pnpm for tests")).toEqual({
      text: "use pnpm for tests",
      redactions: 0,
    });
  });

  it("redacts PEM armour", () => {
    expect(redactSecrets("paste -----BEGIN RSA PRIVATE KEY----- next")).toEqual({
      text: "paste [redacted] next",
      redactions: 1,
    });
  });
});

describe("candidatesFromFacts", () => {
  const fact = (kind: "decision" | "rejected" | "outcome", text: string) => ({
    at: "2026-11-02T10:00:00.000Z",
    kind,
    text,
  });

  it("uses only decision and rejected facts", () => {
    expect(
      candidatesFromFacts(
        [fact("decision", "a"), fact("rejected", "b"), fact("outcome", "c")],
        { scope: "repo:8f3c1a2b", sourceRoomId: "R1" },
      ).map((candidate) => candidate.text),
    ).toEqual(["a", "b"]);
  });

  it("dedupes by normalized text and caps the lesson length", () => {
    const long = `  ${"x".repeat(300)}  `;
    const candidates = candidatesFromFacts(
      [fact("decision", "Use  pnpm"), fact("rejected", "use pnpm"), fact("decision", long)],
      { scope: "repo:8f3c1a2b", sourceRoomId: "R1" },
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[1]!.text).toHaveLength(240);
    expect(candidates[0]!.id).toBe(candidates[0]!.id.toLowerCase());
  });
});
