import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../shared/seats";
import { PROMPTS } from "./prompts/generated";
import { renderSeatTable, renderSystemPrompt } from "./render";

describe("renderSystemPrompt", () => {
  it("supervisor prompt = protocol + supervisor role + lead seat line", () => {
    const p = renderSystemPrompt({ seat: "supervisor" }, DEFAULT_SETTINGS);
    expect(p).toContain(PROMPTS.protocol);
    expect(p).toContain(PROMPTS.supervisor);
    expect(p).toContain("[room:lead]");
    expect(p).toContain("claude/claude-opus-5-5");
    expect(p).not.toContain(PROMPTS.lead);
  });

  it("lead prompt lists every peer tier with marker, provider/model and useFor", () => {
    const p = renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS);
    for (const t of DEFAULT_SETTINGS.peerTiers) {
      expect(p).toContain(`[room:peer:${t.id}]`);
      expect(p).toContain(`${t.provider}/${t.model}`);
      expect(p).toContain(t.useFor);
    }
  });

  it("peer prompt names its tier and forbids spawning", () => {
    const p = renderSystemPrompt({ seat: "peer", tier: "cheap" }, DEFAULT_SETTINGS);
    expect(p).toContain(PROMPTS.peer);
    expect(p).toContain("cheap");
  });

  it("appends after an existing system prompt", () => {
    expect(renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS, "BASE").startsWith("BASE\n\n")).toBe(true);
  });

  it("ends with the seat table, so the seat rules are the last thing read", () => {
    const p = renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS);
    expect(p.endsWith(renderSeatTable({ seat: "lead" }, DEFAULT_SETTINGS))).toBe(true);
  });

  it("skips a blank existing system prompt", () => {
    const p = renderSystemPrompt({ seat: "peer", tier: "default" }, DEFAULT_SETTINGS, " \n\t\n");
    expect(p.startsWith("# ")).toBe(true);
  });
});

describe("renderSeatTable", () => {
  it("gives a supervisor its one creatable seat, the lead line", () => {
    const table = renderSeatTable({ seat: "supervisor" }, DEFAULT_SETTINGS);
    expect(table).toContain("## Room seats");
    expect(table).toContain("[room:lead]");
    expect(table).toContain("claude/claude-opus-5-5");
    expect(table).not.toContain("[room:peer:");
  });

  it("reads the lead seat from the settings, not from a constant", () => {
    const table = renderSeatTable(
      { seat: "supervisor" },
      { ...DEFAULT_SETTINGS, lead: { provider: "opencode", model: "opencode-big" } },
    );
    expect(table).toContain("opencode/opencode-big");
    expect(table).not.toContain("claude/claude-opus-5-5");
  });

  it("gives a lead one row per peer tier", () => {
    const table = renderSeatTable({ seat: "lead" }, DEFAULT_SETTINGS);
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && line.includes("[room:peer:"));
    expect(rows).toHaveLength(DEFAULT_SETTINGS.peerTiers.length);
  });

  it("keeps a settings-supplied useFor inside its table cell", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      peerTiers: [
        { id: "default", provider: "p", model: "m", useFor: "a|b\nc" },
      ],
    };
    const table = renderSeatTable({ seat: "lead" }, settings);
    expect(table).toContain("a\\|b c");
    expect(table.split("\n").filter((line) => line.startsWith("| "))).toHaveLength(2);
  });

  it("gives a peer its own tier and no agents to create", () => {
    const table = renderSeatTable({ seat: "peer", tier: "cheap" }, DEFAULT_SETTINGS);
    expect(table).toContain("## Room seats");
    expect(table).toContain("your tier: `cheap`");
    expect(table).toContain("claude/claude-haiku-4-5");
    expect(table).toContain("you create no agents");
    expect(table).not.toContain("[room:peer:default]");
  });

  it("says which tier an unknown peer tier falls back to", () => {
    const table = renderSeatTable({ seat: "peer", tier: "zzz" }, DEFAULT_SETTINGS);
    expect(table).toContain("zzz");
    expect(table).toContain("`default`");
  });
});
