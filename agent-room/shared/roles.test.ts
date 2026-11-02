import { describe, expect, it } from "vitest";

import {
  type Role,
  AGENT_TITLE_MAX_LENGTH,
  DEFAULT_SETTINGS,
  ROLE_NAME_MAX_LENGTH,
  parseRoleTitle,
  roleByName,
  roleForLegacyMarker,
  roleSeat,
  roomSettingsSchema,
  seatTitleForRole,
} from "./roles";

const roles = DEFAULT_SETTINGS.roles;

/**
 * The mode ids each provider actually accepts. A role that names another
 * provider's mode fails to launch, so this table is the guard against a Codex
 * role carrying a Claude-only id.
 */
const MODES_BY_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  claude: ["bypassPermissions", "acceptEdits", "plan", "default"],
  codex: ["auto", "auto-review", "full-access"],
};

describe("DEFAULT_SETTINGS", () => {
  it.each(DEFAULT_SETTINGS.roles.map((role) => [role.id, role] as const))(
    "%s names a mode its provider offers",
    (_id, role) => {
      const modes = MODES_BY_PROVIDER[role.provider];
      expect(modes).toBeDefined();
      // A role that leaves the mode unset lets the provider pick its default.
      if (role.modeId === undefined || modes === undefined) return;
      expect(modes).toContain(role.modeId);
    },
  );

  it("puts each Codex role in full-access, not the Claude mode", () => {
    for (const role of roles.filter((candidate) => candidate.provider === "codex")) {
      expect(role.modeId).toBe("full-access");
    }
  });
});

describe("parseRoleTitle", () => {
  it.each([
    ["Supervisor: fix auth", "supervisor", "fix auth"],
    ["Lead: billing migration", "lead", "billing migration"],
    ["Reviewer: audit the diff", "reviewer", "audit the diff"],
    ["reviewer: lower case", "reviewer", "lower case"],
    ["  Implementer:  pad  ", "implementer", "pad"],
    ["Lead:", "lead", ""],
  ])("parses %s", (title, roleId, rest) => {
    const parsed = parseRoleTitle(title, roles);
    expect(parsed?.role.id).toBe(roleId);
    expect(parsed?.rest).toBe(rest);
  });

  it.each([null, undefined, "", "Fix it", "Reviewer audit", "Boss: x", "Data migration: phase 2", ": no role"])(
    "ignores %s",
    (title) => expect(parseRoleTitle(title, roles)).toBeNull(),
  );

  it("matches names case-insensitively but returns the canonical role", () => {
    expect(parseRoleTitle("SUPERVISOR: x", roles)?.role.name).toBe("Supervisor");
  });
});

describe("seatTitleForRole", () => {
  it("writes the canonical role name, a colon and the text", () => {
    const supervisor = roleByName("Supervisor", roles)!;
    expect(seatTitleForRole(supervisor, "fix auth")).toBe("Supervisor: fix auth");
  });

  it("keeps the role name when the text is capped at 60", () => {
    const supervisor = roleByName("Supervisor", roles)!;
    const title = seatTitleForRole(supervisor, "x".repeat(200));
    expect(title).toHaveLength(AGENT_TITLE_MAX_LENGTH);
    expect(title.startsWith("Supervisor: ")).toBe(true);
    expect(parseRoleTitle(title, roles)?.role.id).toBe("supervisor");
  });

  it("handles an empty outcome", () => {
    const lead = roleByName("Lead", roles)!;
    expect(seatTitleForRole(lead, "   ")).toBe("Lead:");
  });
});

describe("roleForLegacyMarker", () => {
  it("maps each legacy marker shape", () => {
    expect(roleForLegacyMarker({ seat: "supervisor" }, roles).role.id).toBe("supervisor");
    expect(roleForLegacyMarker({ seat: "lead" }, roles).role.id).toBe("lead");
    expect(roleForLegacyMarker({ seat: "peer", tier: "review" }, roles).role.id).toBe("reviewer");
    expect(roleForLegacyMarker({ seat: "peer", tier: "default" }, roles).role.id).toBe("implementer");
    expect(roleForLegacyMarker({ seat: "peer", tier: "cheap" }, roles).role.id).toBe("mechanic");
  });

  it("falls back to the first worker role and reports the tier", () => {
    const mapped = roleForLegacyMarker({ seat: "peer", tier: "gone" }, roles);
    expect(mapped.role.kind).toBe("worker");
    expect(mapped.fallbackFrom).toBe("gone");
  });

  it("throws when the catalog has no worker role", () => {
    const emptyCatalog = [] as Role[];
    expect(() => roleForLegacyMarker({ seat: "peer", tier: "default" }, emptyCatalog)).toThrow(
      "role catalog has no worker role",
    );
  });
});

describe("roleSeat", () => {
  it("returns only the seat fields", () => {
    const reviewer = roleByName("Reviewer", roles)!;
    expect(roleSeat(reviewer)).toEqual({
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
    });
  });
});

describe("roomSettingsSchema", () => {
  it("accepts DEFAULT_SETTINGS", () => {
    expect(roomSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it("requires exactly one supervisor, at least one lead and one worker", () => {
    expect(
      roomSettingsSchema.safeParse({ roles: roles.filter((role) => role.kind !== "worker") }).success,
    ).toBe(false);
    expect(
      roomSettingsSchema.safeParse({ roles: roles.filter((role) => role.kind !== "lead") }).success,
    ).toBe(false);
    expect(
      roomSettingsSchema.safeParse({
        roles: [...roles, roles.find((role) => role.kind === "supervisor")],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate ids and duplicate names case-insensitively", () => {
    const lead = roles.find((role) => role.kind === "lead")!;
    expect(roomSettingsSchema.safeParse({ roles: [...roles, lead] }).success).toBe(false);
    expect(
      roomSettingsSchema.safeParse({ roles: [...roles, { ...lead, id: "lead-2", name: "LEAD" }] }).success,
    ).toBe(false);
  });

  it("rejects a role name longer than 20 characters", () => {
    const lead = roles.find((role) => role.kind === "lead")!;
    expect(
      roomSettingsSchema.safeParse({
        roles: [...roles.filter((role) => role.id !== lead.id), { ...lead, name: "a".repeat(ROLE_NAME_MAX_LENGTH + 1) }],
      }).success,
    ).toBe(false);
  });

  it("rejects a role name containing a colon", () => {
    const lead = roles.find((role) => role.kind === "lead")!;
    expect(
      roomSettingsSchema.safeParse({
        roles: [...roles.filter((role) => role.id !== lead.id), { ...lead, name: "Data: Migration" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a role name with surrounding whitespace", () => {
    const lead = roles.find((role) => role.kind === "lead")!;
    for (const name of [" Lead", "Lead ", " Lead "]) {
      expect(
        roomSettingsSchema.safeParse({
          roles: [...roles.filter((role) => role.id !== lead.id), { ...lead, name }],
        }).success,
      ).toBe(false);
    }
  });

  it("transforms a legacy seats document into roles", () => {
    const legacy = {
      supervisor: { provider: "codex", model: "gpt-5.6-sol", modeId: "full-access" },
      lead: { provider: "claude", model: "claude-opus-5-5" },
      peerTiers: [
        { id: "default", provider: "claude", model: "claude-sonnet-5-5", useFor: "Implementation" },
        { id: "review", provider: "claude", model: "claude-sonnet-5-5", useFor: "Review" },
      ],
    };
    const parsed = roomSettingsSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.roles.find((role) => role.kind === "supervisor")?.provider).toBe("codex");
    expect(parsed.data.roles.find((role) => role.id === "review")?.kind).toBe("worker");
    expect(parsed.data.roles.find((role) => role.id === "review")?.useFor).toBe("Review");
  });

  it("keeps a legacy document whose peer-tier ids collide with supervisor and lead", () => {
    // A legal v1 document: tier ids are arbitrary kebab-case, so `lead` and
    // `supervisor` are allowed. Copying them verbatim would duplicate the role
    // ids the catalog already holds and reject the whole document, dropping the
    // user back to defaults.
    const legacy = {
      supervisor: { provider: "claude", model: "claude-opus-5-5" },
      lead: { provider: "claude", model: "claude-opus-5-5" },
      peerTiers: [
        { id: "lead", provider: "claude", model: "claude-sonnet-5-5", useFor: "A second lead" },
        { id: "supervisor", provider: "claude", model: "claude-sonnet-5-5", useFor: "A second supervisor" },
        { id: "default", provider: "claude", model: "claude-sonnet-5-5", useFor: "Implementation" },
      ],
    };

    const parsed = roomSettingsSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const migrated = parsed.data.roles;

    const ids = migrated.map((role) => role.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The real supervisor and lead keep their ids and kinds.
    expect(migrated.filter((role) => role.kind === "supervisor")).toHaveLength(1);
    expect(migrated.find((role) => role.kind === "supervisor")?.id).toBe("supervisor");
    expect(migrated.find((role) => role.kind === "lead")?.id).toBe("lead");

    // The colliding tiers survive as worker roles with ids of their own.
    const workers = migrated.filter((role) => role.kind === "worker");
    expect(workers).toHaveLength(3);
    expect(workers.map((role) => role.id)).toEqual(["lead-0", "supervisor-1", "default"]);
    expect(workers.map((role) => role.useFor)).toEqual([
      "A second lead",
      "A second supervisor",
      "Implementation",
    ]);
    expect(new Set(workers.map((role) => role.name.toLowerCase())).size).toBe(3);
  });
});
