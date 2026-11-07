import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, roomSettingsSchema } from "../shared/roles";
import type { RoomSettings, SeatConfig } from "../shared/roles";
import type { RoleDraft, RoomDraft } from "./settings-draft";
import {
  addRole,
  changeProvider,
  removeRole,
  setRole,
  validateDraft,
} from "./settings-draft";

/** A draft built from the shipped catalog, so it is savable as it stands. */
const draft: RoomDraft = DEFAULT_SETTINGS;

const parses = (candidate: unknown): boolean => roomSettingsSchema.safeParse(candidate).success;

const roleById = (value: RoomDraft, id: string): RoleDraft => {
  const role = value.roles.find((candidate) => candidate.id === id);
  if (role === undefined) throw new Error(`draft has no role "${id}"`);
  return role;
};

const workerIds = (value: RoomDraft): string[] =>
  value.roles.filter((role) => role.kind === "worker").map((role) => role.id);

/** A catalog with exactly one worker, so "the last worker" can be tested. */
const oneWorkerDraft: RoomDraft = {
  roles: draft.roles.filter((role) => role.kind !== "worker" || role.id === "implementer"),
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

describe("setRole", () => {
  it("patches one role without touching the others", () => {
    const next = setRole(draft, "reviewer", { thinkingOptionId: "medium" });

    expect(next.roles.find((role) => role.id === "reviewer")?.thinkingOptionId).toBe("medium");
    expect(next.roles.find((role) => role.id === "lead")).toBe(
      draft.roles.find((role) => role.id === "lead"),
    );
  });

  it("sets and clears a worker budget like the brief", () => {
    const set = setRole(draft, "reviewer", { budget: "one review cycle, then report" });
    expect(roleById(set, "reviewer").budget).toBe("one review cycle, then report");

    const kept = setRole(set, "reviewer", { name: "Auditor" });
    expect(roleById(kept, "reviewer").budget).toBe("one review cycle, then report");

    const cleared = setRole(kept, "reviewer", { budget: "" });
    expect(roleById(cleared, "reviewer").budget).toBeUndefined();
    expect(parses(cleared)).toBe(true);
  });

  it("keeps the document valid when only the model moves", () => {
    const next = setRole(draft, "lead", { model: "claude-sonnet-5-5" });

    expect(roleById(next, "lead").model).toBe("claude-sonnet-5-5");
    expect(parses(next)).toBe(true);
  });

  it("clears the provider-specific fields when the provider moves", () => {
    const next = setRole(draft, "supervisor", { provider: "codex" });
    const supervisor = roleById(next, "supervisor");

    expect(supervisor.model).toBeUndefined();
    expect(supervisor.modeId).toBeUndefined();
    expect(supervisor.thinkingOptionId).toBeUndefined();
    expect(supervisor.provider).toBe("codex");
    expect(parses(next)).toBe(false);
  });

  it("passes the schema again once the new provider has a model", () => {
    const switched = setRole(draft, "supervisor", { provider: "codex" });
    const completed = setRole(switched, "supervisor", { model: "gpt-5.6-sol" });

    expect(roleById(completed, "supervisor")).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    expect(parses(completed)).toBe(true);
  });

  it("keeps the role's identity when only the seat moves", () => {
    const next = setRole(draft, "reviewer", { thinkingOptionId: "low" });

    expect(roleById(next, "reviewer")).toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      kind: "worker",
      useFor: roleById(draft, "reviewer").useFor,
    });
  });

  it("never renames a role by id, because titles resolve roles by name", () => {
    const next = setRole(draft, "reviewer", { id: "renamed" });

    expect(next.roles.map((role) => role.id)).toEqual(draft.roles.map((role) => role.id));
  });

  it("patches the name, the kind, the use-for and the brief", () => {
    const next = setRole(draft, "reviewer", {
      name: "Auditor",
      kind: "worker",
      useFor: "Audit a candidate diff",
      brief: "Read only.",
    });

    expect(roleById(next, "reviewer")).toMatchObject({
      name: "Auditor",
      kind: "worker",
      useFor: "Audit a candidate diff",
      brief: "Read only.",
    });
    expect(parses(next)).toBe(true);
  });

  it("leaves a role that never had a brief without one", () => {
    const next = setRole(draft, "implementer", { thinkingOptionId: "low" });

    expect("brief" in roleById(next, "implementer")).toBe(false);
  });

  it("drops the brief when the field is cleared", () => {
    const next = setRole(draft, "reviewer", { brief: "" });

    expect("brief" in roleById(next, "reviewer")).toBe(false);
    expect(parses(next)).toBe(true);
  });

  it("refuses to demote the only supervisor", () => {
    expect(setRole(draft, "supervisor", { kind: "worker" })).toBe(draft);
    expect(setRole(draft, "supervisor", { kind: "lead" })).toBe(draft);
  });

  it("refuses to demote the only lead", () => {
    expect(setRole(draft, "lead", { kind: "worker" })).toBe(draft);
    expect(setRole(draft, "lead", { kind: "supervisor" })).toBe(draft);
  });

  it("allows promoting a worker to lead", () => {
    const next = setRole(draft, "reviewer", { kind: "lead" });

    expect(roleById(next, "reviewer").kind).toBe("lead");
    expect(parses(next)).toBe(true);
  });

  it("refuses to demote the last worker", () => {
    expect(setRole(oneWorkerDraft, "implementer", { kind: "lead" })).toBe(oneWorkerDraft);
  });

  it("returns the draft unchanged for an unknown role", () => {
    expect(setRole(draft, "missing", { useFor: "x" })).toBe(draft);
  });
});

describe("addRole", () => {
  it("adds a worker role copied from the first worker", () => {
    const template = roleById(draft, workerIds(draft)[0]!);
    const next = addRole(draft, "triage");
    const added = roleById(next, "triage");

    expect(added.kind).toBe("worker");
    expect(added.useFor).toBe("");
    expect(added.provider).toBe(template.provider);
    expect(added.model).toBe(template.model);
    expect(added.modeId).toBe(template.modeId);
    expect(added.thinkingOptionId).toBe(template.thinkingOptionId);
    expect(next.roles).toHaveLength(draft.roles.length + 1);
  });

  it("gives the new role a display name the title can carry", () => {
    const next = addRole(draft, "triage");

    expect(roleById(next, "triage").name).toBe("triage");
  });

  it("produces a role the schema rejects until it has a useFor", () => {
    const next = addRole(draft, "triage");

    expect(parses(next)).toBe(false);
    expect(parses(setRole(next, "triage", { useFor: "Mechanical edits" }))).toBe(true);
  });

  it("refuses an id that is already taken", () => {
    expect(addRole(draft, "reviewer")).toBe(draft);
  });

  it("refuses an id that is not lowercase kebab-case", () => {
    expect(addRole(draft, "Bad_Role")).toBe(draft);
    expect(addRole(draft, "9lives")).toBe(draft);
  });

  it("does not share the copied feature map with the worker it copied", () => {
    // Built from the stored document, not from a draft: `RoleDraft` allows a
    // missing model, and this fixture has to be a savable `RoomSettings`.
    const source: RoomSettings = {
      ...DEFAULT_SETTINGS,
      roles: DEFAULT_SETTINGS.roles.map((role) =>
        role.id === "implementer" ? { ...role, features: { webSearch: true } } : role,
      ),
    };

    const next = addRole(source, "triage");
    const added = roleById(next, "triage");
    const original = roleById(source, "implementer");

    expect(added.features).toEqual({ webSearch: true });
    expect(added.features).not.toBe(original.features);
  });
});

describe("removeRole", () => {
  it("refuses to remove the only supervisor or lead", () => {
    expect(removeRole(draft, "supervisor")).toBe(draft);
    expect(removeRole(draft, "lead")).toBe(draft);
    expect(removeRole(draft, "reviewer").roles.some((role) => role.id === "reviewer")).toBe(false);
  });

  it("refuses to remove the last worker", () => {
    expect(removeRole(oneWorkerDraft, "implementer")).toBe(oneWorkerDraft);
  });

  it("keeps the document valid after dropping a worker", () => {
    expect(parses(removeRole(draft, "reviewer"))).toBe(true);
  });

  it("returns the draft unchanged for an unknown role", () => {
    expect(removeRole(draft, "missing")).toBe(draft);
  });
});

describe("reducers never mutate the draft", () => {
  it("leaves the input untouched", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);

    setRole(draft, "reviewer", { useFor: "changed" });
    addRole(draft, "triage");
    removeRole(draft, "reviewer");
    changeProvider(roleById(draft, "supervisor"), "codex");

    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });
});

describe("validateDraft", () => {
  it("returns the parsed settings for a valid draft", () => {
    const result = validateDraft(draft);

    expect(result.ok).toBe(true);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("reports the blocking field for a new role without a useFor", () => {
    const result = validateDraft(addRole(draft, "triage"));

    expect(result.ok).toBe(false);
    expect(result.settings).toBeNull();
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).toContain("useFor");
  });

  it("reports a role that is waiting for a model", () => {
    const result = validateDraft(setRole(draft, "lead", { provider: "codex" }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("model");
  });

  it("rejects a duplicate role name", () => {
    const next = setRole(draft, "reviewer", { name: "Lead" });

    expect(validateDraft(next).ok).toBe(false);
  });

  it("rejects a role name a title cannot carry", () => {
    const next = setRole(draft, "reviewer", { name: "Review: only" });

    expect(validateDraft(next).ok).toBe(false);
  });
});
