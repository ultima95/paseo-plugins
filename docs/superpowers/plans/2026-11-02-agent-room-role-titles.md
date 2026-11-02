# Agent Room role titles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `[room:…]` title markers with human-readable role names (`Supervisor:`, `Lead:`, `Reviewer:`) and a single role catalog that owns each role's seat, prompt brief, and kind.

**Architecture:** A new `shared/roles.ts` owns role records, role-name parsing, title rendering, the settings schema, and legacy-marker conversion. `shared/seats.ts` shrinks to the legacy marker reader used only for in-flight rooms. `applySeat` resolves a role by title, forces its seat, and renders the kind prompt plus the role brief. The guard enforces by `role.kind`. The store records `roleId`/`roleName`/`roleKind` alongside the legacy marker. The client edits a `roles` list instead of supervisor/lead/peerTiers.

**Tech Stack:** TypeScript, zod 4, vitest 4, React Native plugin UI, `@getpaseo/plugin` 0.13.1.

**Spec:** `docs/superpowers/specs/2026-11-02-agent-room-role-titles-design.md`

## Global Constraints

- Agent titles are capped at 60 characters (Paseo limit); role names at 20; role ids match `^[a-z][a-z0-9-]*$`.
- Title grammar is `<RoleName>: <text>`, anchored, case-insensitive name match, ASCII colon required.
- Legacy `[room:…]` titles are read but never written. No in-flight title is rewritten.
- The hierarchy is fixed: supervisor → lead → worker → nothing.
- A role not in the catalog is unmanaged; an unmarked child of a room seat is a guard violation.
- Provider and model are stored as bare ids; the create request combines them as `provider/model`.
- A role or profile that leaves a control unset drops that control from the request; `providerOptions` is dropped only when the provider changes; `mcpServers`, `toolPolicy`, and `env` are always left alone.
- No new dependencies. No commits unless the user explicitly asks for one.
- Validation for every task: `cd agent-room && npm test && npm run typecheck`.

## Review Focus

- An ordinary title that starts with a configured role name and a colon is claimed by the plugin. Test: `Reviewer: notes` is a room seat; `Review notes: x` is not.
- A legacy room mid-flight keeps working after the switch. Test: each old marker resolves to the mapped role, and an unknown tier records `fallbackFrom`.
- A malformed or unknown role token must not be treated as a valid seat. Test: `[room:boss]` and `Boss: x` are unmanaged; as a child of a seat they are guard violations.
- The role name must survive the 60-character title slice. Test: a 200-character outcome still round-trips the role.
- A stored legacy settings document (`supervisor`/`lead`/`peerTiers`) must not be lost when the new schema loads. Test: the schema transforms it into roles with the same providers and models.

---

### Task 1: Role catalog and title parser

**Files:**
- Create: `agent-room/shared/roles.ts`
- Test: `agent-room/shared/roles.test.ts`

**Interfaces:**
- Produces: `Role`, `RoleKind`, `SeatConfig`, `RoomSettings`, `roleSchema`, `seatConfigSchema`, `roleKindSchema`, `roleIdSchema`, `roomSettingsSchema`, `roomSettings`, `DEFAULT_SETTINGS`, `roleByName`, `parseRoleTitle`, `seatTitleForRole`, `roleSeat`, `roleForLegacyMarker`, `ROLE_NAME_MAX_LENGTH`, `AGENT_TITLE_MAX_LENGTH`, `LEGACY_TIER_ROLE`.

- [ ] **Step 1: Write the failing tests**

Create `agent-room/shared/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
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
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd agent-room && npx vitest run shared/roles.test.ts`
Expected: FAIL — `Cannot find module './roles'`.

- [ ] **Step 3: Implement `shared/roles.ts`**

```ts
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

import type { SeatMarker } from "./seats";

/** Paseo agent titles are capped at 60 characters. */
export const AGENT_TITLE_MAX_LENGTH = 60;
/** Longest role name that still leaves room for `: ` and an outcome. */
export const ROLE_NAME_MAX_LENGTH = 20;

const nonEmptyText = z.string().min(1);

export const seatConfigSchema = z.object({
  provider: nonEmptyText,
  model: nonEmptyText,
  modeId: nonEmptyText.optional(),
  thinkingOptionId: nonEmptyText.optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});

export type SeatConfig = z.infer<typeof seatConfigSchema>;

export const roleKindSchema = z.enum(["supervisor", "lead", "worker"]);
export type RoleKind = z.infer<typeof roleKindSchema>;

export const roleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "role id must be lowercase kebab-case")
  .max(40);

export const roleSchema = seatConfigSchema.extend({
  id: roleIdSchema,
  name: z.string().min(1).max(ROLE_NAME_MAX_LENGTH),
  kind: roleKindSchema,
  useFor: nonEmptyText,
  brief: z.string().optional(),
});

export type Role = z.infer<typeof roleSchema>;

export type RoomSettings = { roles: Role[] };

const peerTierSchema = seatConfigSchema.extend({
  id: roleIdSchema,
  useFor: nonEmptyText,
});

const legacySettingsSchema = z.object({
  supervisor: seatConfigSchema,
  lead: seatConfigSchema,
  peerTiers: z.array(peerTierSchema).min(1),
});

export type LegacyRoomSettings = z.infer<typeof legacySettingsSchema>;

function titleCaseRoleName(id: string): string {
  const name = id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, ROLE_NAME_MAX_LENGTH)
    .trim();
  return name.length > 0 ? name : "Worker";
}

/** Convert a stored v1 seats document into the role catalog. */
export function legacyToRoles(legacy: LegacyRoomSettings): RoomSettings {
  const usedNames = new Set(["supervisor", "lead"]);
  const roles: Role[] = [
    { id: "supervisor", name: "Supervisor", kind: "supervisor", useFor: "Talks to the user and launches Leads", ...legacy.supervisor },
    { id: "lead", name: "Lead", kind: "lead", useFor: "Owns one project", ...legacy.lead },
  ];

  legacy.peerTiers.forEach((tier, index) => {
    let name = titleCaseRoleName(tier.id);
    if (usedNames.has(name.toLowerCase())) name = `${name.slice(0, ROLE_NAME_MAX_LENGTH - 3)}-${index}`;
    usedNames.add(name.toLowerCase());
    roles.push({
      id: tier.id,
      name,
      kind: "worker",
      provider: tier.provider,
      model: tier.model,
      ...(tier.modeId !== undefined ? { modeId: tier.modeId } : {}),
      ...(tier.thinkingOptionId !== undefined ? { thinkingOptionId: tier.thinkingOptionId } : {}),
      ...(tier.features !== undefined ? { features: tier.features } : {}),
      useFor: tier.useFor,
    });
  });

  return { roles };
}

const rolesSettingsSchema = z.object({ roles: z.array(roleSchema).min(3) });

function refineRoles(settings: RoomSettings, ctx: z.RefinementCtx): void {
  const kinds = settings.roles.map((role) => role.kind);
  if (kinds.filter((kind) => kind === "supervisor").length !== 1) {
    ctx.addIssue({ code: "custom", message: "exactly one supervisor role is required", path: ["roles"] });
  }
  if (!kinds.includes("lead")) {
    ctx.addIssue({ code: "custom", message: "at least one lead role is required", path: ["roles"] });
  }
  if (!kinds.includes("worker")) {
    ctx.addIssue({ code: "custom", message: "at least one worker role is required", path: ["roles"] });
  }
  const ids = settings.roles.map((role) => role.id);
  const names = settings.roles.map((role) => role.name.toLowerCase());
  for (const [label, values] of [["id", ids], ["name", names]] as const) {
    const duplicate = values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({ code: "custom", message: `duplicate role ${label} "${duplicate}"`, path: ["roles"] });
    }
  }
}

export const roomSettingsSchema = z
  .union([rolesSettingsSchema, legacySettingsSchema])
  .transform((document): RoomSettings => ("roles" in document ? document : legacyToRoles(document)))
  .superRefine((settings, ctx) => refineRoles(settings, ctx));

export type RoomSettingsInput = z.input<typeof roomSettingsSchema>;

export const roomSettings = defineSettings({
  id: "seats",
  scope: "host",
  version: 1,
  schema: roomSettingsSchema,
});

const worker = (
  id: string,
  name: string,
  provider: string,
  model: string,
  thinkingOptionId: string,
  useFor: string,
  brief?: string,
): Role => ({
  id,
  name,
  kind: "worker",
  provider,
  model,
  modeId: "bypassPermissions",
  thinkingOptionId,
  useFor,
  ...(brief !== undefined ? { brief } : {}),
});

export const DEFAULT_SETTINGS: RoomSettings = {
  roles: [
    {
      id: "supervisor",
      name: "Supervisor",
      kind: "supervisor",
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "xhigh",
      useFor: "Talks to the user, pins intent, launches Leads",
    },
    {
      id: "lead",
      name: "Lead",
      kind: "lead",
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      useFor: "Owns one project, launches workers, integrates and verifies",
    },
    worker("implementer", "Implementer", "claude", "claude-sonnet-5-5", "medium", "Implementation, debugging, research"),
    worker("reviewer", "Reviewer", "claude", "claude-sonnet-5-5", "high", "Read-only review of a candidate", "Review only. Do not edit files; report findings to your Lead."),
    worker("researcher", "Researcher", "claude", "claude-sonnet-5-5", "medium", "Read-only investigation of unfamiliar code"),
    worker("mechanic", "Mechanic", "claude", "claude-haiku-4-5", "medium", "Extraction, formatting, log triage, mechanical edits"),
    worker("specialist", "Specialist", "claude", "claude-opus-5-5", "medium", "Hard problems a cheaper role failed on"),
    worker("codex", "Codex", "codex", "gpt-5.6-sol", "medium", "Cross-family implementation or second opinion"),
    worker("codex-review", "Codex Review", "codex", "gpt-5.6-sol", "high", "Cross-family read-only review"),
  ],
};

/** Legacy peer-tier ids that must keep resolving after the switch. */
export const LEGACY_TIER_ROLE: Readonly<Record<string, string>> = {
  default: "implementer",
  cheap: "mechanic",
  expensive: "specialist",
  review: "reviewer",
  "cross-family": "codex",
  "cross-family-review": "codex-review",
};

export function roleByName(name: string | null | undefined, roles: readonly Role[]): Role | null {
  if (name === null || name === undefined) return null;
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0 || wanted.length > ROLE_NAME_MAX_LENGTH) return null;
  return roles.find((role) => role.name.toLowerCase() === wanted) ?? null;
}

export function parseRoleTitle(
  title: string | null | undefined,
  roles: readonly Role[],
): { role: Role; rest: string } | null {
  if (title === null || title === undefined) return null;
  const trimmed = title.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const role = roleByName(trimmed.slice(0, colon), roles);
  if (role === null) return null;
  return { role, rest: trimmed.slice(colon + 1).trim() };
}

export function seatTitleForRole(role: Role, text: string): string {
  const rest = text.trim();
  const title = rest.length === 0 ? `${role.name}:` : `${role.name}: ${rest}`;
  return title.slice(0, AGENT_TITLE_MAX_LENGTH);
}

export function roleSeat(role: Role): SeatConfig {
  const seat: SeatConfig = { provider: role.provider, model: role.model };
  if (role.modeId !== undefined) seat.modeId = role.modeId;
  if (role.thinkingOptionId !== undefined) seat.thinkingOptionId = role.thinkingOptionId;
  if (role.features !== undefined) seat.features = role.features;
  return seat;
}

export function roleForLegacyMarker(
  marker: SeatMarker,
  roles: readonly Role[],
): { role: Role; fallbackFrom?: string } {
  const supervisors = roles.filter((role) => role.kind === "supervisor");
  const leads = roles.filter((role) => role.kind === "lead");
  const workers = roles.filter((role) => role.kind === "worker");

  if (marker.seat === "supervisor") return { role: supervisors[0]! };
  if (marker.seat === "lead") return { role: leads[0]! };

  const mapped = LEGACY_TIER_ROLE[marker.tier];
  const direct =
    (mapped !== undefined ? workers.find((role) => role.id === mapped) : undefined) ??
    workers.find((role) => role.id === marker.tier);
  if (direct !== undefined) return { role: direct };
  return { role: workers[0]!, fallbackFrom: marker.tier };
}
```

- [ ] **Step 4: Run the tests again**

Run: `cd agent-room && npx vitest run shared/roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the module in isolation**

Run: `cd agent-room && npx tsc --noEmit`
Expected: the only new errors are the existing imports that still point at the old settings shape; they are fixed in Task 2.

---

### Task 2: Shrink `shared/seats.ts` to the legacy reader and move imports

**Files:**
- Modify: `agent-room/shared/seats.ts`
- Modify: `agent-room/server/settings.ts`, `agent-room/server/settings.test.ts`
- Modify: `agent-room/shared/room.ts`
- Modify: `agent-room/server/guard.ts` (import only; behavior in Task 4)
- Modify: `agent-room/server/inject.ts` (import only; behavior in Task 3)
- Modify: `agent-room/server/render.ts` (imports; behavior in Task 5)
- Modify: `agent-room/server/handlers.ts` (imports; behavior in Task 7)
- Modify: `agent-room/server/events.ts` (imports; behavior in Task 6)
- Modify: `agent-room/client/rooms-screen.tsx`, `client/settings-draft.ts` (imports; behavior in Task 9)
- Test: `agent-room/shared/seats.test.ts` (legacy-only assertions)

**Interfaces:**
- `shared/seats.ts` keeps: `SeatMarker`, `parseSeatMarker`, `formatMarker`, `seatTitle`.
- `shared/seats.ts` drops: `SeatConfig`, `seatConfigSchema`, `PeerTier`, `peerTierIdSchema`, `roomSettings`, `roomSettingsSchema`, `DEFAULT_SETTINGS`, `seatConfigFor`, `PEER_TIER_ID_MAX_LENGTH`.
- Everything that used those imports switches to `shared/roles.ts`, except `SeatMarker` and the legacy helpers.

- [ ] **Step 1: Write the failing legacy tests**

Replace `agent-room/shared/seats.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import { formatMarker, parseSeatMarker, seatTitle } from "./seats";

describe("parseSeatMarker (legacy)", () => {
  it.each([
    ["[room:supervisor] Fix auth", { seat: "supervisor" }, "Fix auth"],
    ["[room:lead] API", { seat: "lead" }, "API"],
    ["[room:peer:cheap] format logs", { seat: "peer", tier: "cheap" }, "format logs"],
    ["[Room:Lead] API", { seat: "lead" }, "API"],
    ["  [room:peer] x", { seat: "peer", tier: "default" }, "x"],
  ])("parses %s", (title, marker, rest) => {
    expect(parseSeatMarker(title)).toEqual({ marker, rest });
  });

  it.each([null, undefined, "", "Reviewer: x", "Fix [room:lead] x", "[room:boss] x"])(
    "ignores %s",
    (title) => expect(parseSeatMarker(title)).toBeNull(),
  );
});

describe("legacy title helpers", () => {
  it("still renders a legacy marker for tests and migration", () => {
    expect(formatMarker({ seat: "peer", tier: "review" })).toBe("[room:peer:review]");
    expect(seatTitle({ seat: "lead" }, "API")).toBe("[room:lead] API");
  });

  it("caps a legacy title at 60", () => {
    const title = seatTitle({ seat: "supervisor" }, "x".repeat(200));
    expect(title).toHaveLength(60);
    expect(parseSeatMarker(title)?.marker).toEqual({ seat: "supervisor" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd agent-room && npx vitest run shared/seats.test.ts`
Expected: PASS for the legacy helpers, FAIL at typecheck after the file is reduced (the old exports are gone).

- [ ] **Step 3: Reduce `shared/seats.ts`**

Keep exactly:

```ts
import { AGENT_TITLE_MAX_LENGTH } from "./roles";

export type SeatMarker = { seat: "supervisor" } | { seat: "lead" } | { seat: "peer"; tier: string };

const MARKER_PATTERN = /^\[room:(supervisor|lead|peer(?::([a-z0-9-]+))?)\]\s*/i;
const DEFAULT_TIER_ID = "default";

export function parseSeatMarker(
  title: string | null | undefined,
): { marker: SeatMarker; rest: string } | null {
  if (!title) return null;
  const trimmed = title.trim();
  const match = MARKER_PATTERN.exec(trimmed);
  if (!match) return null;
  const rest = trimmed.slice(match[0].length);
  const seat = match[1]!.toLowerCase();
  if (seat === "supervisor") return { marker: { seat: "supervisor" }, rest };
  if (seat === "lead") return { marker: { seat: "lead" }, rest };
  const tier = (match[2] ?? DEFAULT_TIER_ID).toLowerCase();
  return { marker: { seat: "peer", tier }, rest };
}

export function formatMarker(marker: SeatMarker): string {
  switch (marker.seat) {
    case "supervisor":
      return "[room:supervisor]";
    case "lead":
      return "[room:lead]";
    case "peer":
      return `[room:peer:${marker.tier}]`;
  }
}

export function seatTitle(marker: SeatMarker, text: string): string {
  return `${formatMarker(marker)} ${text.trim()}`.slice(0, AGENT_TITLE_MAX_LENGTH);
}
```

Delete every other export in that file. Deleting code is intended; there is no compatibility re-export.

- [ ] **Step 4: Sweep the imports**

Apply these exact import changes:

| File | New import |
| --- | --- |
| `server/settings.ts` | `import { DEFAULT_SETTINGS, roomSettingsSchema, type RoomSettings } from "../shared/roles";` |
| `server/inject.ts` | `import { parseRoleTitle, roleForLegacyMarker, roleSeat, type Role, type RoomSettings } from "../shared/roles";` and `import { parseSeatMarker } from "../shared/seats";` |
| `server/guard.ts` | `import type { Role, RoleKind } from "../shared/roles";` |
| `server/render.ts` | `import { roleByName, type Role, type RoomSettings } from "../shared/roles";` |
| `server/handlers.ts` | `import { roleByName, roleSeat, seatTitleForRole, type RoomSettings, type SeatConfig } from "../shared/roles";` |
| `server/events.ts` | `import { parseRoleTitle, roleForLegacyMarker, roleSeat, type Role, type RoomSettings } from "../shared/roles";` and `import { parseSeatMarker, type SeatMarker } from "../shared/seats";` |
| `shared/room.ts` | `import { roleIdSchema, roleKindSchema, type RoleKind } from "./roles";` and `import type { SeatMarker } from "./seats";` |
| `client/rooms-screen.tsx` | `import { DEFAULT_SETTINGS, roomSettings } from "../shared/roles";` |
| `client/settings-draft.ts` | `import type { Role, RoomSettings, SeatConfig } from "../shared/roles";` and `import { roleIdSchema, roomSettingsSchema } from "../shared/roles";` |
| tests | Replace `DEFAULT_SETTINGS`/`RoomSettings`/`SeatConfig` imports from `shared/seats` with `shared/roles`; keep `SeatMarker` imports from `shared/seats`. |

- [ ] **Step 5: Run the full suite**

Run: `cd agent-room && npm test && npm run typecheck`
Expected: legacy tests pass; the remaining failures are behavioral tests for inject, guard, render, events, handlers, and the client — fixed in Tasks 3–9.

---

### Task 3: Resolve roles in `applySeat` and the create hook

**Files:**
- Modify: `agent-room/server/inject.ts`
- Modify: `agent-room/index.server.ts`
- Test: `agent-room/server/inject.test.ts`

**Interfaces:**
- Consumes: `parseRoleTitle`, `roleForLegacyMarker`, `roleSeat`, `Role`, `parseSeatMarker`.
- Produces: `SeatApplication = { request; role: Role; fallbackFrom?: string }`, `applySeat(request, settings): SeatApplication | null`.

- [ ] **Step 1: Rewrite the failing tests**

Replace the marker cases in `server/inject.test.ts`:

```ts
it("returns null for unmarked and unknown-role titles", () => {
  for (const title of [null, "Fix it", "Boss: x", "Review notes: x", "[Lead] old room"]) {
    expect(applySeat(base(title), DEFAULT_SETTINGS)).toBeNull();
  }
});

it("forces the role's provider, model, mode and effort", () => {
  const r = applySeat(base("Reviewer: audit"), DEFAULT_SETTINGS)!;
  expect(r.role.id).toBe("reviewer");
  expect(r.request.config).toMatchObject({
    provider: "claude",
    model: "claude-sonnet-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "high",
    cwd: "/repo",
    title: "Reviewer: audit",
  });
});

it("applies a legacy marker through the mapped role", () => {
  const r = applySeat(base("[room:peer:review] audit"), DEFAULT_SETTINGS)!;
  expect(r.role.id).toBe("reviewer");
  expect(r.request.config.title).toBe("[room:peer:review] audit");
});

it("reports an unknown legacy tier fallback", () => {
  const r = applySeat(base("[room:peer:zzz] x"), DEFAULT_SETTINGS)!;
  expect(r.fallbackFrom).toBe("zzz");
  expect(r.role.kind).toBe("worker");
});
```

Keep the existing provider-options, provider-flip, mcpServers, idempotency, env and immutability tests, updating marker titles to role titles (`"Lead: x"`, `"Supervisor: plan"`).

- [ ] **Step 2: Run them**

Run: `cd agent-room && npx vitest run server/inject.test.ts`
Expected: FAIL on role resolution.

- [ ] **Step 3: Implement `applySeat`**

```ts
export type SeatApplication = {
  request: AgentCreateRequest;
  role: Role;
  fallbackFrom?: string;
};

function resolveRole(title: string | null, settings: RoomSettings): { role: Role; fallbackFrom?: string } | null {
  const parsed = parseRoleTitle(title, settings.roles);
  if (parsed !== null) return { role: parsed.role };
  const legacy = parseSeatMarker(title);
  if (legacy === null) return null;
  return roleForLegacyMarker(legacy.marker, settings.roles);
}

export function applySeat(request: AgentCreateRequest, settings: RoomSettings): SeatApplication | null {
  const resolved = resolveRole(request.config.title, settings);
  if (resolved === null) return null;
  const role = resolved.role;

  const config: AgentCreateRequest["config"] = { ...request.config };
  delete config.modeId;
  delete config.thinkingOptionId;
  delete config.featureValues;
  if (request.config.provider !== role.provider) delete config.providerOptions;

  config.provider = role.provider;
  config.model = role.model;
  applyRoleControls(config, role);

  if (!carriesRoomPrompt(config.systemPrompt)) {
    config.systemPrompt = renderSystemPrompt(role, settings, config.systemPrompt);
  }

  const applied: SeatApplication = { request: { ...request, config }, role };
  if (resolved.fallbackFrom !== undefined) applied.fallbackFrom = resolved.fallbackFrom;
  return applied;
}

function applyRoleControls(config: AgentCreateRequest["config"], role: Role): void {
  if (role.modeId !== undefined) config.modeId = role.modeId;
  if (role.thinkingOptionId !== undefined) config.thinkingOptionId = role.thinkingOptionId;
  if (role.features !== undefined) config.featureValues = role.features;
}
```

- [ ] **Step 4: Update the hook in `index.server.ts`**

```ts
import { parseRoleTitle } from "./shared/roles";
import { parseSeatMarker } from "./shared/seats";

server.before("agent.create", async ({ request }) => {
  const title = request.config.title;
  if (title === null || title === undefined) return;
  // Cheap pre-check: a role title has a colon, a legacy title has a bracket.
  if (!title.includes(":") && !title.trimStart().startsWith("[")) return;
  try {
    const settings = await readSettings();
    const known = parseRoleTitle(title, settings.roles) !== null || parseSeatMarker(title) !== null;
    if (!known) return;
    const applied = applySeat(request, settings);
    if (!applied) return;
    if (applied.fallbackFrom !== undefined) {
      log.warn("unknown legacy peer tier", { tier: applied.fallbackFrom, role: applied.role.id });
    }
    return applied.request;
  } catch (error) {
    log.error("agent.create hook failed; request passed through", { error });
    return;
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `cd agent-room && npx vitest run server/inject.test.ts`
Expected: PASS.

---

### Task 4: Guard by role kind

**Files:**
- Modify: `agent-room/server/guard.ts`
- Test: `agent-room/server/guard.test.ts`

**Interfaces:**
- Produces: `checkSpawn(parent: Role | null, child: Role | null, roles: readonly Role[]): SpawnVerdict`.

- [ ] **Step 1: Rewrite the failing tests**

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, roleByName } from "../shared/roles";
import { checkSpawn } from "./guard";

const roles = DEFAULT_SETTINGS.roles;
const supervisor = roleByName("Supervisor", roles)!;
const lead = roleByName("Lead", roles)!;
const reviewer = roleByName("Reviewer", roles)!;
const implementer = roleByName("Implementer", roles)!;

describe("checkSpawn", () => {
  it.each([
    [null, null, true],
    [null, supervisor, true],
    [supervisor, lead, true],
    [supervisor, reviewer, false],
    [supervisor, null, false],
    [lead, implementer, true],
    [lead, lead, false],
    [lead, supervisor, false],
    [lead, null, false],
    [reviewer, implementer, false],
    [reviewer, null, false],
  ])("parent %j child %j → %s", (parent, child, ok) => {
    expect(checkSpawn(parent as never, child as never, roles).allowed).toBe(ok);
  });

  it("names the role the violator should have used", () => {
    const fromSupervisor = checkSpawn(supervisor, null, roles);
    const fromLead = checkSpawn(lead, null, roles);
    const fromWorker = checkSpawn(reviewer, implementer, roles);

    if (fromSupervisor.allowed || fromLead.allowed || fromWorker.allowed) throw new Error("expected denials");
    expect(fromSupervisor.rule).toContain("Lead:");
    expect(fromLead.rule).toContain("Implementer:");
    expect(fromWorker.rule).toContain("creates no agents");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd agent-room && npx vitest run server/guard.test.ts`
Expected: FAIL — `checkSpawn` still takes markers.

- [ ] **Step 3: Implement**

```ts
import type { Role } from "../shared/roles";

export type SpawnVerdict = { allowed: true } | { allowed: false; rule: string };

export function checkSpawn(
  parent: Role | null,
  child: Role | null,
  roles: readonly Role[],
): SpawnVerdict {
  if (parent === null) return { allowed: true };

  const lead = roles.find((role) => role.kind === "lead");
  const worker = roles.find((role) => role.kind === "worker");

  switch (parent.kind) {
    case "supervisor":
      if (child?.kind === "lead") return { allowed: true };
      return {
        allowed: false,
        rule: `a ${parent.name} may only create Lead agents; title the child "${lead?.name ?? "Lead"}: <workstream>"`,
      };
    case "lead":
      if (child?.kind === "worker") return { allowed: true };
      return {
        allowed: false,
        rule: `a ${parent.name} may only create worker-role agents; title the child "${worker?.name ?? "Implementer"}: <outcome>"`,
      };
    case "worker":
      return { allowed: false, rule: `${parent.name} creates no agents; report to your Lead instead` };
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd agent-room && npx vitest run server/guard.test.ts`
Expected: PASS.

---

### Task 5: Render role prompts and the role table

**Files:**
- Modify: `agent-room/server/render.ts`
- Modify: `agent-room/server/render.test.ts`
- Modify: `agent-room/server/prompts/supervisor.md`, `lead.md`, `peer.md`, `protocol.md`
- Modify: `agent-room/server/prompts/generated.ts` (regenerated)
- Modify: `agent-room/package.json` only if `gen:prompts` needs no change (it does not)

**Interfaces:**
- Consumes: `Role`, `RoomSettings`, `roleByName`, `roleSeat`.
- Produces: `renderRoleTable(role: Role, settings: RoomSettings): string`, `renderSystemPrompt(role: Role, settings: RoomSettings, existing?: string): string`.

- [ ] **Step 1: Write the failing tests**

Replace `server/render.test.ts`:

```ts
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

  it("gives a worker its own role and no agents to create", () => {
    const table = renderRoleTable(reviewer, DEFAULT_SETTINGS);
    expect(table).toContain("Reviewer");
    expect(table).toContain("you create no agents");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd agent-room && npx vitest run server/render.test.ts`
Expected: FAIL — `renderRoleTable` is not exported.

- [ ] **Step 3: Implement `render.ts`**

```ts
import { roleSeat, type Role, type RoomSettings } from "../shared/roles";

import { PROMPTS } from "./prompts/generated";

const ROLE_TABLE_HEADING = "## Room roles";

function code(value: string): string {
  return `\`${value}\``;
}

function providerModel(role: Role): string {
  return code(`${role.provider}/${role.model}`);
}

function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

const KIND_PROMPTS = {
  supervisor: PROMPTS.supervisor,
  lead: PROMPTS.lead,
  worker: PROMPTS.peer,
} as const;

export function renderRoleTable(role: Role, settings: RoomSettings): string {
  if (role.kind === "supervisor") {
    const leads = settings.roles.filter((candidate) => candidate.kind === "lead");
    return [
      ROLE_TABLE_HEADING,
      "",
      `You create Lead agents, and nothing else. A child is titled \`${leads[0]?.name ?? "Lead"}: <workstream>\`.`,
      "",
      "| Role you create | Title | Provider / model |",
      "|---|---|---|",
      ...leads.map((lead) => `| ${lead.name} | ${code(`${lead.name}: <workstream>`)} | ${providerModel(lead)} |`),
      "",
      "Never launch a worker role directly, and never launch an agent whose title carries no role: an unmarked child of a room seat is archived by the room guard.",
    ].join("\n");
  }

  if (role.kind === "lead") {
    const workers = settings.roles.filter((candidate) => candidate.kind === "worker");
    return [
      ROLE_TABLE_HEADING,
      "",
      `You create worker-role agents, and nothing else. A child is titled \`${workers[0]?.name ?? "Implementer"}: <bounded outcome>\`.`,
      "",
      "| Role | Title | Provider / model | Use for |",
      "|---|---|---|---|",
      ...workers.map(
        (worker) =>
          `| ${worker.name} | ${code(`${worker.name}: <outcome>`)} | ${providerModel(worker)} | ${tableCell(worker.useFor)} |`,
      ),
      "",
      "A role that is not in this table does not exist. Leave `settings` off the `create_agent` call: the role sets mode and thinking level itself.",
    ].join("\n");
  }

  const seat = roleSeat(role);
  return [
    ROLE_TABLE_HEADING,
    "",
    `- your role: ${code(role.name)} (${code(`${seat.provider}/${seat.model}`)})`,
    "- you create no agents",
  ].join("\n");
}

export function renderSystemPrompt(
  role: Role,
  settings: RoomSettings,
  existing?: string,
): string {
  const parts = [
    existing ?? "",
    PROMPTS.protocol,
    KIND_PROMPTS[role.kind],
    role.brief ?? "",
    renderRoleTable(role, settings),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}
```

- [ ] **Step 4: Update the markdown prompts**

In `protocol.md`, `supervisor.md`, `lead.md`, and `peer.md`, replace every marker example and rule:

| Old text | New text |
| --- | --- |
| `[room:supervisor]` | `Supervisor:` |
| `[room:lead]` | `Lead:` |
| `[room:peer:<tier>]` | `<WorkerRole>:` |
| "title marker" | "role title" |
| "marker selects the seat" | "role name selects the seat" |
| "an unmarked child" | "a child with no role" |
| "Peer" / "Peers" | "worker" / "workers" where it names the seat kind |

Keep every other instruction and signal unchanged. Then regenerate:

Run: `cd agent-room && npm run gen:prompts`
Expected: `gen:prompts wrote generated.ts (N bytes) from 4 sources`.

- [ ] **Step 5: Run the tests**

Run: `cd agent-room && npx vitest run server/render.test.ts server/prompts/prompts.test.ts`
Expected: PASS.

---

### Task 6: Record roles in the store and resolve them in lifecycle events

**Files:**
- Modify: `agent-room/shared/room.ts`
- Modify: `agent-room/server/events.ts`
- Modify: `agent-room/server/feed.ts`
- Test: `agent-room/server/events.test.ts`, `agent-room/server/feed.test.ts`, `agent-room/server/store.test.ts`

**Interfaces:**
- `SeatRecord` gains optional `roleId`, `roleName`, `roleKind`; `marker` becomes optional.
- `feedFromTurn` accepts `SeatRecord` whose `roleKind` may be present.
- Events resolve parent roles from the store, else from the parent title via `parseRoleTitle` or the legacy marker.

- [ ] **Step 1: Write the failing store test**

Add to `server/store.test.ts`:

```ts
it("accepts a role-only seat and rejects a seat with neither a role nor a marker", () => {
  const store = createRoomStore({ file: join(tmp, "rooms.json"), now: () => 0, newId: () => "id", log: silentLog });
  store.addSeat({
    agentId: "A1",
    roomId: "R1",
    parentId: null,
    roleId: "supervisor",
    roleName: "Supervisor",
    roleKind: "supervisor",
    provider: "claude",
    model: "claude-opus-5-5",
    title: "Supervisor: x",
  });
  expect(store.seat("A1")?.roleKind).toBe("supervisor");

  store.addSeat({
    agentId: "A2",
    roomId: "R1",
    parentId: null,
    provider: "claude",
    model: "claude-opus-5-5",
    title: "no role",
  } as never);
  expect(store.seat("A2")).toBeUndefined();
});
```

- [ ] **Step 2: Implement the schema**

In `shared/room.ts`:

```ts
export const seatRecordSchema = z
  .object({
    agentId: nonEmptyText,
    roomId: nonEmptyText,
    parentId: z.string().nullable(),
    marker: seatMarkerSchema.optional(),
    roleId: roleIdSchema.optional(),
    roleName: z.string().min(1).optional(),
    roleKind: roleKindSchema.optional(),
    provider: nonEmptyText,
    model: nonEmptyText,
    title: z.string(),
  })
  .refine((seat) => seat.marker !== undefined || seat.roleId !== undefined, {
    message: "a seat needs a marker or a role",
  });
```

- [ ] **Step 3: Update `feed.ts`**

Replace the supervisor check:

```ts
const supervisor = agent.roleKind === "supervisor" || agent.marker?.seat === "supervisor";
const label = from === null && supervisor ? "task" : "instruction";
```

- [ ] **Step 4: Update `events.ts`**

`resolveParent` returns a role context:

```ts
interface ParentContext {
  id: string | null;
  seat?: SeatRecord;
  title: string | null;
  role: Role | null;
}
```

Resolution:

```ts
const roleFromTitle = (title: string | null, settings: RoomSettings): Role | null => {
  const parsed = parseRoleTitle(title, settings.roles);
  if (parsed !== null) return parsed.role;
  const legacy = parseSeatMarker(title);
  return legacy === null ? null : roleForLegacyMarker(legacy.marker, settings.roles).role;
};
```

`handleCreated`:

```ts
const settings = await deps.readSettings();
const parsed = parseRoleTitle(agent.title, settings.roles);
const legacy = parsed === null ? parseSeatMarker(agent.title) : null;
const resolved =
  parsed !== null
    ? { role: parsed.role }
    : legacy !== null
      ? roleForLegacyMarker(legacy.marker, settings.roles)
      : null;
const role = resolved?.role ?? null;

const verdict = checkSpawn(parent.role, role, settings.roles);
if (!verdict.allowed) { await deny(agent, parent, verdict.rule, paseo); return; }
if (role === null) return;
```

Store both:

```ts
store.addSeat({
  agentId: agent.id,
  roomId,
  parentId: agent.parentAgentId,
  roleId: role.id,
  roleName: role.name,
  roleKind: role.kind,
  provider: agent.provider,
  model: role.model,
  title: agent.title ?? "",
});
```

Keep the legacy marker too when the title carried one:

```ts
...(legacy !== null ? { marker: legacy.marker } : {}),
```

`deny` and `correctMarker` now use role names from `settings.roles`; the messages come from `verdict.rule`.

- [ ] **Step 5: Update the tests and run them**

Update the `seat()` helper in `events.test.ts` so it can write either shape:

```ts
const roleSeat = (
  agentId: string,
  roomId: string,
  parentId: string | null,
  role: { id: string; name: string; kind: "supervisor" | "lead" | "worker" },
): SeatRecord => ({
  agentId,
  roomId,
  parentId,
  roleId: role.id,
  roleName: role.name,
  roleKind: role.kind,
  provider: "claude",
  model: "claude-opus-5-5",
  title: `${role.name}: ${agentId}`,
});
```

Add these two cases:

```ts
it("records a role seat from a role title", async () => {
  const fake = fakeStore();
  const { paseo } = fakePaseo();
  const events = eventsWith({ store: fake.store });

  await events.onCreated(
    { agent: agent({ id: "S1", title: "Supervisor: fix auth" }) },
    { paseo, signal: new AbortController().signal },
  );

  expect(fake.addSeat).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "S1",
      roleId: "supervisor",
      roleName: "Supervisor",
      roleKind: "supervisor",
      title: "Supervisor: fix auth",
    }),
  );
  expect(fake.addRoom).toHaveBeenCalledWith(expect.objectContaining({ id: "S1", task: "fix auth" }));
});

it("archives a child whose title carries an unknown role", async () => {
  const supervisor = roleSeat("S1", "S1", null, { id: "supervisor", name: "Supervisor", kind: "supervisor" });
  const fake = fakeStore({ seats: [supervisor] });
  const { paseo, handleFor } = fakePaseo({ S1: supervisor.title });
  const events = eventsWith({ store: fake.store });

  await events.onCreated(
    { agent: agent({ id: "C1", parentAgentId: "S1", title: "Boss: do it" }) },
    { paseo, signal: new AbortController().signal },
  );

  expect(handleFor("C1").archive).toHaveBeenCalled();
  expect(fake.appendFeed).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "guard", label: "archived" }),
  );
});
```

If `eventsWith` does not accept `{ store }` directly in the current file, keep its existing signature and pass the same overrides it already takes; do not add a second test harness.

Update `feed.test.ts` fixtures with `roleKind: "supervisor" | "lead" | "worker"` and `roleId`/`roleName`, and keep one case that has only `marker` to prove the legacy path still labels a Supervisor task.

Update `store.test.ts` fixtures the same way; keep the existing legacy-marker round-trip case.

Run: `cd agent-room && npx vitest run server/events.test.ts server/feed.test.ts server/store.test.ts`
Expected: PASS.

---

### Task 7: Launch, adopt and the seat table in handlers

**Files:**
- Modify: `agent-room/server/handlers.ts`
- Test: `agent-room/server/handlers.test.ts`

**Interfaces:**
- `launch` uses the supervisor role; `adopt` uses the supervisor role for the protocol message.
- Titles come from `seatTitleForRole`.

- [ ] **Step 1: Update the failing tests**

Replace marker assertions:

```ts
expect(created[0]?.options.title).toBe("Supervisor: Fix the room");
expect(created[0]?.options.title?.startsWith("Supervisor: ")).toBe(true);
expect(sent[0]).toContain("Lead:");
expect(sent[0]).toContain(PROMPTS.protocol);
```

and the adopt fixtures:

```ts
addSeat(expect.objectContaining({
  agentId: "S1",
  roomId: "S1",
  parentId: null,
  roleId: "supervisor",
  roleName: "Supervisor",
  roleKind: "supervisor",
  provider: "claude",
  model: "claude-opus-5-5",
}));
```

- [ ] **Step 2: Implement**

In `handlers.ts`:

```ts
function supervisorRole(settings: RoomSettings): Role {
  const role = settings.roles.find((candidate) => candidate.kind === "supervisor");
  if (role === undefined) throw new Error("no supervisor role configured");
  return role;
}

function roleConfig(role: Role): PaseoAgentConfig {
  const config: PaseoAgentConfig = { provider: `${role.provider}/${role.model}` };
  if (role.modeId !== undefined) config.modeId = role.modeId;
  if (role.thinkingOptionId !== undefined) config.thinkingOptionId = role.thinkingOptionId;
  if (role.features !== undefined) config.featureValues = role.features;
  return config;
}
```

`launch`:

```ts
const role = supervisorRole(settings);
const config = roleConfig(role);
config.systemPrompt = renderSystemPrompt(role, settings);
const options = {
  config,
  title: seatTitleForRole(role, input.task),
  prompt: input.task,
};
```

`adopt`:

```ts
const role = supervisorRole(settings);
store.addSeat({
  agentId: roomId,
  roomId,
  parentId: null,
  roleId: role.id,
  roleName: role.name,
  roleKind: role.kind,
  provider: agent.provider,
  model: agent.model ?? "",
  title,
});
await handle.send(
  `This chat is the Supervisor seat of an agent room. Follow this protocol and role from here on.\n\n${renderSystemPrompt(role, settings)}`,
);
```

- [ ] **Step 3: Run the tests**

Run: `cd agent-room && npx vitest run server/handlers.test.ts`
Expected: PASS.

---

### Task 8: Show role names in the client view model

**Files:**
- Modify: `agent-room/client/view-model.ts`
- Test: `agent-room/client/view-model.test.ts`

**Interfaces:**
- `seatName(seat: SeatRecord): string` now takes the record, not the marker.
- `feedLabel` uses `roleName` and keeps short names for the narrow column.

- [ ] **Step 1: Write the failing tests**

```ts
it("names each seat by its role, falling back to the legacy marker", () => {
  expect(seatName(seat("sup", null, SUP, { roleName: "Supervisor", roleKind: "supervisor" }))).toBe("Supervisor");
  expect(seatName(seat("lead", "sup", LEAD, { roleName: "Lead", roleKind: "lead" }))).toBe("Lead");
  expect(seatName(seat("rev", "lead", peer("review"), { roleName: "Reviewer", roleKind: "worker" }))).toBe("Reviewer");
  expect(seatName(seat("legacy", "lead", peer("cheap")))).toBe("Peer:cheap");
});

it("labels the feed by role name", () => {
  const seats = [
    seat("sup", null, SUP, { roleName: "Supervisor", roleKind: "supervisor" }),
    seat("rev", "sup", peer("review"), { roleName: "Reviewer", roleKind: "worker" }),
  ];
  const rows = feedRows([event({ id: "e1", from: "sup", to: "rev" })], seats);
  expect(rows[0]?.fromLabel).toBe("Sup");
  expect(rows[0]?.toLabel).toBe("Reviewer");
});
```

- [ ] **Step 2: Implement**

```ts
function shortRole(seat: SeatRecord): string {
  if (seat.roleName !== undefined) {
    if (seat.roleKind === "supervisor") return "Sup";
    return seat.roleName;
  }
  const marker = seat.marker;
  if (marker === undefined) return "Agent";
  switch (marker.seat) {
    case "supervisor":
      return "Sup";
    case "lead":
      return "Lead";
    case "peer":
      return `Peer:${marker.tier}`;
  }
}

export function seatName(seat: SeatRecord): string {
  if (seat.roleName !== undefined) return seat.roleName;
  const marker = seat.marker;
  if (marker === undefined) return "Agent";
  switch (marker.seat) {
    case "supervisor":
      return "Supervisor";
    case "lead":
      return "Lead";
    case "peer":
      return `Peer:${marker.tier}`;
  }
}
```

and `feedRows` uses `shortRole(seat)`.

- [ ] **Step 3: Update `room-screen.tsx`**

Change `seatName(seat.marker)` to `seatName(seat)`. No other change in that file.

- [ ] **Step 4: Run the tests**

Run: `cd agent-room && npx vitest run client/view-model.test.ts`
Expected: PASS.

---

### Task 9: Edit roles in the client settings screen

**Files:**
- Modify: `agent-room/client/settings-draft.ts`
- Modify: `agent-room/client/settings-draft.test.ts`
- Modify: `agent-room/client/seat-editor.tsx`
- Modify: `agent-room/client/rooms-screen.tsx`

**Interfaces:**
- `RoleDraft = SeatDraft & { id; name; kind; useFor; brief }`
- `RoomDraft = { roles: RoleDraft[] }`
- `setRole(draft, id, patch)`, `addRole(draft, id)`, `removeRole(draft, id)`, `validateDraft(draft)`.
- `SeatEditor` gains `name`, `kind`, `brief` fields and callbacks.

- [ ] **Step 1: Write the failing draft tests**

Replace the tier tests with:

```ts
it("patches one role without touching the others", () => {
  const next = setRole(draft, "reviewer", { thinkingOptionId: "medium" });
  expect(next.roles.find((role) => role.id === "reviewer")?.thinkingOptionId).toBe("medium");
  expect(next.roles.find((role) => role.id === "lead")).toBe(draft.roles.find((role) => role.id === "lead"));
});

it("adds a worker role copied from the first worker", () => {
  const next = addRole(draft, "triage");
  expect(next.roles.find((role) => role.id === "triage")?.kind).toBe("worker");
  expect(next.roles.find((role) => role.id === "triage")?.useFor).toBe("");
});

it("refuses to remove the only supervisor or lead", () => {
  expect(removeRole(draft, "supervisor")).toBe(draft);
  expect(removeRole(draft, "lead")).toBe(draft);
  expect(removeRole(draft, "reviewer").roles.some((role) => role.id === "reviewer")).toBe(false);
});

it("rejects a duplicate role name", () => {
  const next = setRole(draft, "reviewer", { name: "Lead" });
  expect(validateDraft(next).ok).toBe(false);
});
```

- [ ] **Step 2: Implement `settings-draft.ts`**

Change `RoomDraft` to `{ roles: RoleDraft[] }`; keep `SeatDraft`/`SeatPatch`/`mergeSeat`/`changeProvider`. Replace tier functions:

```ts
export type RoleDraft = SeatDraft & { id: string; name: string; kind: RoleKind; useFor: string; brief?: string };
export type RolePatch = Partial<Role>;

export function setRole(draft: RoomDraft, id: string, patch: RolePatch): RoomDraft {
  const index = draft.roles.findIndex((role) => role.id === id);
  if (index < 0) return draft;
  const current = draft.roles[index]!;
  const base = providerMoved(current, patch.provider)
    ? changeProvider(current, patch.provider as string)
    : current;
  const merged = mergeSeat(base, patch);
  const next: RoleDraft = {
    ...merged,
    id: current.id,
    name: patch.name ?? current.name,
    kind: patch.kind ?? current.kind,
    useFor: patch.useFor ?? current.useFor,
    ...(patch.brief !== undefined ? { brief: patch.brief } : current.brief !== undefined ? { brief: current.brief } : {}),
  };
  const roles = draft.roles.slice();
  roles[index] = next;
  return { ...draft, roles };
}

export function addRole(draft: RoomDraft, id: string): RoomDraft {
  if (!roleIdSchema.safeParse(id).success) return draft;
  if (draft.roles.some((role) => role.id === id)) return draft;
  const template = draft.roles.find((role) => role.kind === "worker");
  if (template === undefined) return draft;
  const added: RoleDraft = {
    ...mergeSeat(template, {}),
    id,
    name: id.slice(0, 20),
    kind: "worker",
    useFor: "",
  };
  return { ...draft, roles: [...draft.roles, added] };
}

export function removeRole(draft: RoomDraft, id: string): RoomDraft {
  const target = draft.roles.find((role) => role.id === id);
  if (target === undefined || target.kind !== "worker") return draft;
  const roles = draft.roles.filter((role) => role.id !== id);
  if (!roles.some((role) => role.kind === "worker")) return draft;
  return { ...draft, roles };
}
```

- [ ] **Step 3: Update `seat-editor.tsx`**

Add to `SeatEditorProps`:

```ts
roleName?: string;
roleKind?: RoleKind;
brief?: string;
onNameChange?(text: string): void;
onBriefChange?(text: string): void;
onKindChange?(kind: RoleKind): void;
```

Render three fields above Provider when the callbacks exist:

```tsx
{props.onNameChange ? (
  <Field surface={surface} label="Role name (used in titles)">
    <TextEntry
      surface={surface}
      value={props.roleName ?? ""}
      placeholder="e.g. Reviewer"
      disabled={props.disabled}
      onChangeText={props.onNameChange}
    />
  </Field>
) : null}

{props.onKindChange ? (
  <Field surface={surface} label="Kind">
    <ChoiceRow
      surface={surface}
      options={[
        { id: "supervisor", label: "Supervisor" },
        { id: "lead", label: "Lead" },
        { id: "worker", label: "Worker" },
      ]}
      value={props.roleKind ?? "worker"}
      disabled={props.disabled}
      onSelect={(id) => props.onKindChange?.(id as RoleKind)}
    />
  </Field>
) : null}

{props.onBriefChange ? (
  <Field surface={surface} label="Brief (appended to the kind prompt)">
    <TextEntry
      surface={surface}
      value={props.brief ?? ""}
      placeholder="Role-specific instructions"
      multiline
      disabled={props.disabled}
      onChangeText={props.onBriefChange}
    />
  </Field>
) : null}
```

- [ ] **Step 4: Update `rooms-screen.tsx`**

Replace the seat/tier editors with one loop over `draft.roles`:

```tsx
{draft.roles.map((role) => (
  <SeatEditor
    key={role.id}
    theme={theme}
    layout={layout}
    cwd={launchTarget.cwdForFeatures}
    label={role.kind === "supervisor" ? "Supervisor" : role.kind === "lead" ? "Lead" : `Worker · ${role.id}`}
    seat={role}
    providers={catalog.providers}
    disabled={!editable}
    onChange={(patch) => changeRole(role.id, patch)}
    useFor={role.useFor}
    onUseForChange={(text) => changeRole(role.id, { useFor: text })}
    roleName={role.name}
    roleKind={role.kind}
    onNameChange={(text) => changeRole(role.id, { name: text })}
    onKindChange={(kind) => changeRole(role.id, { kind })}
    brief={role.brief}
    onBriefChange={(text) => changeRole(role.id, { brief: text })}
    onRemove={role.kind === "worker" ? () => removeRoleRow(role.id) : undefined}
  />
))}
```

Replace the tier handlers and their state:

```ts
const [newRoleId, setNewRoleId] = useState("");
const [roleError, setRoleError] = useState("");
```

Delete `newTierId`, `tierError`, `changeSeat`, `changeTier`, `addTierRow`, and `removeTierRow`. Add:

```ts
function changeRole(id: string, patch: RolePatch) {
  if (!editable) return;
  setEdited(setRole(draft, id, patch));
}

function removeRoleRow(id: string) {
  if (!editable) return;
  setEdited(removeRole(draft, id));
}

function addRoleRow() {
  if (!editable) return;
  const id = newRoleId.trim();
  if (id.length === 0) return;
  const next = addRole(draft, id);
  if (next === draft) {
    setRoleError(`"${id}" is already used, or is not lowercase kebab-case.`);
    return;
  }
  setEdited(next);
  setNewRoleId("");
  setRoleError("");
}
```

Update the section copy: `title="Roles"`, `subtitle="Every room agent is titled with the role it runs."`, the add field label `New worker role id`, button `Add role`, and `Save roles`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd agent-room && npx vitest run client/settings-draft.test.ts client/view-model.test.ts && npm run typecheck`
Expected: PASS.

---

### Task 10: Documentation and whole-branch verification

**Files:**
- Modify: `agent-room/OVERVIEW.md`
- Reference: `docs/superpowers/specs/2026-11-02-agent-room-role-titles-design.md`

- [ ] **Step 1: Update `OVERVIEW.md`**

Replace the "Titles decide seats" section with the role-title grammar, the role catalog, and the kind hierarchy. State that legacy markers are read but not written, and that a title with no configured role is unmanaged.

- [ ] **Step 2: Run the full suite**

Run: `cd agent-room && npm test && npm run typecheck`
Expected: all tests pass, `tsc --noEmit` clean.

- [ ] **Step 3: Grep for the old grammar in emitted paths**

Run: `cd agent-room && rg -n "\[room:" --glob '!**/*.test.ts' --glob '!**/node_modules/**'`
Expected: matches only in `shared/seats.ts` (the legacy reader), `OVERVIEW.md` (the "legacy" note), and the migration test fixtures. No match in `render.ts`, `handlers.ts`, or the prompt markdown.

- [ ] **Step 4: Verify one live agent**

Run:

```bash
cd agent-room
paseo plugin reload agent-room
paseo run --no-wait --title "Reviewer: probe" --provider codex --cwd /Users/ultima/Workspace/paseo-plugins \
  "Quote only the first line of the room roles table in your system instructions."
```

Then `paseo inspect <id>` and confirm the provider/model is the Reviewer role's seat, and the answer contains `## Room roles`.

- [ ] **Step 5: Record the verification**

Append one acceptance section to the spec or a dated `agent-room/docs/acceptance-2026-11-02-role-titles.md` with the commands and observed output. Do not commit unless the user asks.

---

## Notes

- The members phase gets its own plan after this one lands; it depends on `Role` and `roleKind` from Task 1.
- No task deletes user settings: the legacy branch of `roomSettingsSchema` transforms the old document into roles on read, and the first save writes the new shape.
- A role rename is not supported in v1. Adding a role under a new name and archiving the old one keeps in-flight legacy titles resolvable.
