import { describe, expect, it } from "vitest";

import { CHARTER_PROMPT_CAP, MEMBER_SECTION_CAP } from "../shared/member";
import { DEFAULT_SETTINGS, roleByName } from "../shared/roles";
import { PROMPTS } from "./prompts/generated";
import { renderMemberSection, renderRoleTable, renderSystemPrompt } from "./render";

const roles = DEFAULT_SETTINGS.roles;
const supervisor = roleByName("Supervisor", roles)!;
const lead = roleByName("Lead", roles)!;
const reviewer = roleByName("Reviewer", roles)!;

describe("renderSystemPrompt", () => {
  it("supervisor prompt = protocol + supervisor role + lead roles", () => {
    const p = renderSystemPrompt(supervisor, DEFAULT_SETTINGS);
    expect(p).toContain(PROMPTS.protocol);
    expect(p).toContain(PROMPTS.supervisor);
    expect(p).toContain("Lead:");
    expect(p).toContain("claude/claude-opus-5-5");
    expect(p).not.toContain(PROMPTS.lead);
  });

  it("lead prompt lists every worker role", () => {
    const p = renderSystemPrompt(lead, DEFAULT_SETTINGS);
    for (const role of roles.filter((candidate) => candidate.kind === "worker")) {
      expect(p).toContain(`${role.name}:`);
      expect(p).toContain(`${role.provider}/${role.model}`);
      expect(p).toContain(role.useFor);
    }
  });

  it("appends the role brief after the kind prompt", () => {
    const p = renderSystemPrompt(reviewer, DEFAULT_SETTINGS);
    expect(p).toContain(PROMPTS.peer);
    expect(p).toContain("Review only.");
    expect(p.indexOf(PROMPTS.peer)).toBeLessThan(p.indexOf("Review only."));
  });

  it("puts an existing system prompt first and the role table last", () => {
    const p = renderSystemPrompt(lead, DEFAULT_SETTINGS, "BASE");
    expect(p.startsWith("BASE\n\n")).toBe(true);
    expect(p.endsWith(renderRoleTable(lead, DEFAULT_SETTINGS))).toBe(true);
  });
});

describe("renderRoleTable", () => {
  it("gives the supervisor one creatable role", () => {
    const table = renderRoleTable(supervisor, DEFAULT_SETTINGS);
    expect(table).toContain("## Room roles");
    expect(table).toContain("Lead:");
    expect(table).not.toContain("Reviewer:");
  });

  it("gives the lead one row per worker role", () => {
    const table = renderRoleTable(lead, DEFAULT_SETTINGS);
    const workers = roles.filter((role) => role.kind === "worker");
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && line.includes(":"));
    expect(rows).toHaveLength(workers.length);
  });

  it("keeps a settings-supplied useFor inside its table cell", () => {
    const leadRole = roleByName("Lead", DEFAULT_SETTINGS.roles)!;
    const reviewerRole = roleByName("Reviewer", DEFAULT_SETTINGS.roles)!;
    const settings = {
      roles: DEFAULT_SETTINGS.roles.map((role) =>
        role.id === reviewerRole.id ? { ...role, useFor: "a|b\nc" } : role,
      ),
    };
    const table = renderRoleTable(leadRole, settings);
    expect(table).toContain("a\\|b c");
    const workers = settings.roles.filter((role) => role.kind === "worker");
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && line.includes(":"));
    expect(rows).toHaveLength(workers.length);
  });

  it("gives a worker its own role and no agents to create", () => {
    const table = renderRoleTable(reviewer, DEFAULT_SETTINGS);
    expect(table).toContain("Reviewer");
    expect(table).toContain("you create no agents");
  });
});

describe("renderMemberSection", () => {
  it("renders name, charter and dated lessons", () => {
    const section = renderMemberSection({
      name: "Lead",
      charter: "Use pnpm.",
      lessons: [
        {
          at: "2026-11-02T10:00:00.000Z",
          scope: "repo:8f3c1a2b",
          text: "use pnpm",
          sourceRoomId: "R1",
          promotedBy: "human",
        },
      ],
    });
    expect(section.truncated).toBe(false);
    expect(section.text).toContain("## Member");
    expect(section.text).toContain("Name: Lead.");
    expect(section.text).toContain("Use pnpm.");
    expect(section.text).toContain("[repo:8f3c1a2b] use pnpm");
  });

  it("puts the member section after the role brief and before the role table", () => {
    const member = renderMemberSection({ name: "Lead", charter: "x", lessons: [] });
    const p = renderSystemPrompt(lead, DEFAULT_SETTINGS, "BASE", { member });
    expect(p.startsWith("BASE\n\n")).toBe(true);
    expect(p.indexOf(PROMPTS.lead)).toBeLessThan(p.indexOf("## Member\n"));
    expect(p.indexOf("## Member\n")).toBeLessThan(p.indexOf("## Room roles"));
  });

  it("keeps the newest 12 lessons and flags the drop", () => {
    const lessons = Array.from({ length: 15 }, (_, i) => ({
      at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      scope: "global",
      text: `lesson ${i}`,
      sourceRoomId: "R1",
      promotedBy: "auto" as const,
    }));
    const section = renderMemberSection({ name: "Lead", charter: "", lessons });
    expect(section.truncated).toBe(true);
    expect(section.text).toContain("lesson 14");
    expect(section.text).not.toContain("lesson 0");
    expect(section.text.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(12);
  });

  it("truncates an oversized charter deterministically", () => {
    const section = renderMemberSection({
      name: "Lead",
      charter: "x".repeat(CHARTER_PROMPT_CAP + 100),
      lessons: [],
    });
    expect(section.truncated).toBe(true);
    expect(section.text).toContain("[charter truncated]");
    expect(section.text.length).toBeLessThanOrEqual(MEMBER_SECTION_CAP + 32);
  });

  it("shows the bound lead member's seat in the supervisor table", () => {
    const table = renderRoleTable(supervisor, DEFAULT_SETTINGS, {
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    expect(table).toContain("codex/gpt-5.6-sol");
    expect(table).not.toContain("claude/claude-opus-5-5");
  });
});
