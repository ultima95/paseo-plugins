import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PROMPTS } from "./generated";

const FORBIDDEN = [
  "install.sh",
  "claude-lead",
  "claude-peer",
  "claude-supervisor",
  "codex-peer",
  "slp-wait",
  "CLAUDE_CONFIG_DIR",
  "ROOM_DIR",
  "$ARGUMENTS",
  "list_profiles",
  "output style",
];

const PROMPT_NAMES = ["protocol", "supervisor", "lead", "peer"] as const;

describe("room prompts", () => {
  it("bundles exactly the four prompt sources", () => {
    expect(Object.keys(PROMPTS).sort()).toEqual([...PROMPT_NAMES].sort());
  });

  it.each(Object.entries(PROMPTS))("%s has no Claude/installer residue", (_name, text) => {
    for (const word of FORBIDDEN) expect(text).not.toContain(word);
  });

  it("protocol keeps the signal vocabulary", () => {
    for (const s of [
      "CANDIDATE",
      "REVIEW",
      "REOPEN_REQUEST",
      "DEPENDENCY_REQUEST",
      "BLOCKED",
      "QUESTION",
      "ACK",
      "ACCEPT",
      "REJECT",
      "REVISED BRIEF",
      "HOLD",
      "ANSWER",
      "DEFER",
      "DONE",
      "STATUS",
      "DECISION_NEEDED",
    ])
      expect(PROMPTS.protocol).toContain(s);
  });

  it("roles name the room markers", () => {
    expect(PROMPTS.supervisor).toContain("[room:lead]");
    expect(PROMPTS.lead).toContain("[room:peer:");
  });

  it("protocol opens with a markdown heading", () => {
    expect(PROMPTS.protocol.split("\n")[0]).toMatch(/^# \S/);
  });

  it("generated.ts matches the markdown sources", async () => {
    for (const name of PROMPT_NAMES)
      expect(PROMPTS[name]).toBe(await readFile(new URL(`./${name}.md`, import.meta.url), "utf8"));
  });
});
