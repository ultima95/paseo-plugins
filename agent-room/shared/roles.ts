import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

import type { SeatMarker } from "./seats";

/** Paseo agent titles are capped at 60 characters. */
export const AGENT_TITLE_MAX_LENGTH = 60;
/** Longest role name that still leaves room for `: ` and an outcome. */
export const ROLE_NAME_MAX_LENGTH = 20;
/** Longest role id the schema accepts. */
export const ROLE_ID_MAX_LENGTH = 40;

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
  .max(ROLE_ID_MAX_LENGTH);

export const roleSchema = seatConfigSchema.extend({
  id: roleIdSchema,
  name: z
    .string()
    .min(1)
    .max(ROLE_NAME_MAX_LENGTH)
    .regex(/^[^:]+$/, "role name may not contain ':'")
    .refine((name) => name === name.trim(), "role name may not have surrounding whitespace"),
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

/**
 * A tier id that is already taken becomes `<id>-<index>`, and keeps gaining a
 * numeric tail until it is unique. Without this a legal legacy document whose
 * tier is called `lead` or `supervisor` would produce duplicate role ids and the
 * whole document would be rejected, silently reverting the user to defaults.
 */
function uniqueRoleId(id: string, index: number, usedIds: Set<string>): string {
  if (!usedIds.has(id)) return id;
  const base = `${id}-${index}`.slice(0, ROLE_ID_MAX_LENGTH);
  let candidate = base;
  let suffix = 1;
  while (usedIds.has(candidate)) {
    candidate = `${base.slice(0, ROLE_ID_MAX_LENGTH - String(suffix).length - 1)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Convert a stored v1 seats document into the role catalog. */
export function legacyToRoles(legacy: LegacyRoomSettings): RoomSettings {
  const usedNames = new Set(["supervisor", "lead"]);
  const usedIds = new Set(["supervisor", "lead"]);
  const roles: Role[] = [
    { id: "supervisor", name: "Supervisor", kind: "supervisor", useFor: "Talks to the user and launches Leads", ...legacy.supervisor },
    { id: "lead", name: "Lead", kind: "lead", useFor: "Owns one project", ...legacy.lead },
  ];

  legacy.peerTiers.forEach((tier, index) => {
    let name = titleCaseRoleName(tier.id);
    if (usedNames.has(name.toLowerCase())) name = `${name.slice(0, ROLE_NAME_MAX_LENGTH - 3)}-${index}`;
    usedNames.add(name.toLowerCase());
    const id = uniqueRoleId(tier.id, index, usedIds);
    usedIds.add(id);
    roles.push({
      id,
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

/**
 * A worker role. The mode is per provider on purpose: `bypassPermissions` is a
 * Claude mode id and Codex would reject it, so each caller names its provider's
 * own full-trust mode (`full-access` on Codex).
 */
const worker = (
  id: string,
  name: string,
  provider: string,
  model: string,
  modeId: string,
  thinkingOptionId: string,
  useFor: string,
  brief?: string,
): Role => ({
  id,
  name,
  kind: "worker",
  provider,
  model,
  modeId,
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
    worker("implementer", "Implementer", "claude", "claude-sonnet-5-5", "bypassPermissions", "medium", "Implementation, debugging, research"),
    worker("reviewer", "Reviewer", "claude", "claude-sonnet-5-5", "bypassPermissions", "high", "Read-only review of a candidate", "Review only. Do not edit files; report findings to your Lead."),
    worker("researcher", "Researcher", "claude", "claude-sonnet-5-5", "bypassPermissions", "medium", "Read-only investigation of unfamiliar code"),
    worker("mechanic", "Mechanic", "claude", "claude-haiku-4-5", "bypassPermissions", "medium", "Extraction, formatting, log triage, mechanical edits"),
    worker("specialist", "Specialist", "claude", "claude-opus-5-5", "bypassPermissions", "medium", "Hard problems a cheaper role failed on"),
    worker("codex", "Codex", "codex", "gpt-5.6-sol", "full-access", "medium", "Cross-family implementation or second opinion"),
    worker("codex-review", "Codex Review", "codex", "gpt-5.6-sol", "full-access", "high", "Cross-family read-only review"),
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

  if (marker.seat === "supervisor") {
    const supervisor = supervisors[0];
    if (supervisor === undefined) throw new Error("role catalog has no supervisor role");
    return { role: supervisor };
  }
  if (marker.seat === "lead") {
    const lead = leads[0];
    if (lead === undefined) throw new Error("role catalog has no lead role");
    return { role: lead };
  }

  const mapped = LEGACY_TIER_ROLE[marker.tier];
  const direct =
    (mapped !== undefined ? workers.find((role) => role.id === mapped) : undefined) ??
    workers.find((role) => role.id === marker.tier);
  if (direct !== undefined) return { role: direct };
  const worker = workers[0];
  if (worker === undefined) throw new Error("role catalog has no worker role");
  return { role: worker, fallbackFrom: marker.tier };
}
