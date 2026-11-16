import { describe, expect, it } from "vitest";
import {
  buildQuote,
  formatTimestamp,
  ownerLabel,
  QUOTE_MAX_CHARS,
  QUOTE_MAX_LINES,
  rowForReply,
} from "./message-row";

describe("buildQuote", () => {
  it("quotes each line and leaves a blank line for the answer", () => {
    expect(buildQuote("hello\nthere")).toBe("> hello\n> there\n\n");
  });

  it("returns null when there is nothing to quote", () => {
    expect(buildQuote("")).toBeNull();
    expect(buildQuote("  \n\t\n")).toBeNull();
  });

  it("skips leading blank lines but keeps indentation", () => {
    expect(buildQuote("\n\n  indented  \n")).toBe(">   indented\n\n");
  });

  it("keeps the first lines only, and marks the cut", () => {
    const text = Array.from({ length: QUOTE_MAX_LINES + 4 }, (_, index) => `line ${index}`).join(
      "\n",
    );
    const quote = buildQuote(text);
    const lines = quote?.split("\n") ?? [];
    expect(lines.slice(0, QUOTE_MAX_LINES)).toEqual(
      Array.from({ length: QUOTE_MAX_LINES }, (_, index) => `> line ${index}`),
    );
    expect(lines[QUOTE_MAX_LINES]).toBe("> …");
  });

  it("keeps a long single line under the character budget", () => {
    const quote = buildQuote("x".repeat(QUOTE_MAX_CHARS * 2));
    expect(quote).not.toBeNull();
    expect(quote!.split("\n")[0]).toBe(`> ${"x".repeat(QUOTE_MAX_CHARS)}`);
    expect(quote).toContain("> …");
  });

  it("drops trailing blank lines inside the quoted window", () => {
    expect(buildQuote("word\n\n\n")).toBe("> word\n\n");
  });

  it("names the owner as the first quoted line", () => {
    expect(buildQuote("hello\nthere", "Reviewer: audit the diff")).toBe(
      "> **Reviewer: audit the diff** wrote:\n> hello\n> there\n\n",
    );
  });

  it("quotes without an attribution when the owner is unknown", () => {
    expect(buildQuote("hello", null)).toBe("> hello\n\n");
  });
});

describe("ownerLabel", () => {
  it("names the agent by its model", () => {
    expect(ownerLabel({ provider: "claude", model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });

  it("falls back to the provider when the model is unknown", () => {
    expect(ownerLabel({ provider: "claude", model: null })).toBe("claude");
    expect(ownerLabel({ provider: "claude", model: "   " })).toBe("claude");
  });

  it("shows nothing when the agent is gone", () => {
    expect(ownerLabel(null)).toBeNull();
  });
});

describe("rowForReply", () => {
  it("draws a reply, settled or streaming", () => {
    expect(rowForReply("hi", "streaming")).toEqual({ text: "hi", phase: "streaming" });
    expect(rowForReply("hi", "complete")).toEqual({ text: "hi", phase: "complete" });
  });

  it("leaves a reply with no text to Paseo", () => {
    // Drawing nothing here would still cost the completed-turn footer.
    expect(rowForReply("", "complete")).toBeNull();
    expect(rowForReply("   \n ", "complete")).toBeNull();
  });

  it("keeps a reply's text untouched, including a spoken envelope", () => {
    // Only a user prompt carries the voice envelope; a reply is never one.
    const text = "<spoken-input>keep</spoken-input>";
    expect(rowForReply(text, "complete")?.text).toBe(text);
  });
});

describe("formatTimestamp", () => {
  const now = new Date(2026, 10, 15, 18, 0, 0);

  it("shows the clock time alone for today", () => {
    const label = formatTimestamp(new Date(2026, 10, 15, 9, 5, 0), now);
    expect(label).toMatch(/9:05/);
    expect(label).not.toMatch(/Nov|November/);
  });

  it("adds the weekday within the last week", () => {
    const label = formatTimestamp(new Date(2026, 10, 12, 9, 5, 0), now);
    expect(label).toMatch(/Thursday/);
    expect(label).toMatch(/9:05/);
  });

  it("adds the date once it is older than a week", () => {
    const when = new Date(2026, 10, 1, 9, 5, 0);
    const expectedDate = when.toLocaleDateString([], {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const label = formatTimestamp(when, now);
    expect(label).toContain(expectedDate);
    expect(label).toMatch(/9:05/);
  });
});
