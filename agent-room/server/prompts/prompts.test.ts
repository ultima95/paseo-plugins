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

  it("makes the heartbeat a 15-minute adoption detector, not a 2-minute poll", () => {
    expect(PROMPTS.supervisor).toContain("*/15 * * * *");
    expect(PROMPTS.supervisor).not.toContain("*/2 * * * *");
    expect(PROMPTS.supervisor).toMatch(/event-driven/i);
    expect(PROMPTS.supervisor).toMatch(/stall detector/i);
    expect(PROMPTS.supervisor).toMatch(/10–60 minutes/);
  });

  it("gives the Supervisor a progress probe and a stall heuristic", () => {
    expect(PROMPTS.supervisor).toContain("Progress probe");
    expect(PROMPTS.supervisor).toContain("git status --porcelain | wc -l");
    expect(PROMPTS.supervisor).toContain("elapsed large relative to that count");
    expect(PROMPTS.supervisor).toContain("report a finding instead of continuing");
  });

  it("shows elapsed, cost and progress on the status card", () => {
    expect(PROMPTS.supervisor).toContain("~<elapsed>");
    expect(PROMPTS.supervisor).toContain("$<cost>");
    expect(PROMPTS.supervisor).toContain("progress: <n> files, <n> commits");
    expect(PROMPTS.protocol).toContain("~<elapsed>");
  });

  it("keeps verdicts and dispositions distinct, and requires owner evidence", () => {
    expect(PROMPTS.protocol).toContain("## Verdicts and dispositions");
    expect(PROMPTS.protocol).toMatch(/never a silent\s+`PASS`/);
    expect(PROMPTS.protocol).toContain("recorded Human turn");
    expect(PROMPTS.protocol).toContain("accepted-by-supervisor");
  });

  it("carries a bound into every worker brief and worker prompt", () => {
    expect(PROMPTS.lead).toContain("Budget: <investigation cycles");
    expect(PROMPTS.lead).toMatch(/3 investigation cycles/);
    expect(PROMPTS.peer).toContain("## Budget and stopping");
  });
});
