import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, roleByName } from "../shared/roles";
import { PROMPTS } from "./prompts/generated";
import { renderRoleTable, renderSystemPrompt } from "./render";

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
