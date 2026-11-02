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

  it("roles use the role-title grammar, never the old markers", () => {
    expect(PROMPTS.supervisor).toContain("`Lead: <workstream>`");
    expect(PROMPTS.lead).toContain("`<WorkerRole>: <outcome>`");
    for (const text of Object.values(PROMPTS)) expect(text).not.toContain("[room:");
  });

  it("protocol opens with a markdown heading", () => {
    expect(PROMPTS.protocol.split("\n")[0]).toMatch(/^# \S/);
  });

  it("tells every seat that member memory may be stale", () => {
    expect(PROMPTS.protocol).toMatch(/member memory may be stale/i);
    expect(PROMPTS.protocol).toMatch(/verify .*repository/i);
  });

  it("generated.ts matches the markdown sources", async () => {
    for (const name of PROMPT_NAMES)
      expect(PROMPTS[name]).toBe(await readFile(new URL(`./${name}.md`, import.meta.url), "utf8"));
  });
});
