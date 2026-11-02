import type { ZodIssue } from "zod";

import { ROLE_NAME_MAX_LENGTH, roleIdSchema, roomSettingsSchema } from "../shared/roles";
import type { Role, RoleKind, RoomSettings, SeatConfig } from "../shared/roles";

/**
 * A role's seat while it is being edited.
 *
 * `model` is optional here, unlike `SeatConfig`, because changing a role's
 * provider clears the model: there is no valid model until the user picks one
 * from the new provider's catalog. A draft is only saved once
 * `roomSettingsSchema` accepts it (see `validateDraft`), so an empty seat can
 * never reach the daemon.
 */
export type SeatDraft = Omit<SeatConfig, "model"> & { model?: string };

export type SeatPatch = Partial<SeatConfig>;

/**
 * One editable role: the seat, plus what the room reads off a title. Every
 * field `roleSchema` needs is always written, so a saved role can never become
 * a half-written seat record.
 */
export type RoleDraft = SeatDraft & {
  id: string;
  name: string;
  kind: RoleKind;
  useFor: string;
  brief?: string;
};

export type RolePatch = Partial<Role>;

export type RoomDraft = { roles: RoleDraft[] };

/**
 * A new provider knows nothing about the old one's models, modes, thinking
 * options or feature ids, so those fields are dropped rather than carried
 * across. Asking for the provider a seat already runs keeps the seat as it is.
 */
export function changeProvider(seat: SeatDraft, provider: string): SeatDraft {
  if (seat.provider === provider) return { ...seat };
  return { provider };
}

/**
 * Merge a patch into one seat. A key that is present with `undefined` clears
 * that field; a key that is absent leaves it alone.
 */
function mergeSeat(seat: SeatDraft, patch: SeatPatch): SeatDraft {
  const next: SeatDraft = { provider: patch.provider ?? seat.provider };

  const model = "model" in patch ? patch.model : seat.model;
  if (model !== undefined) next.model = model;

  const modeId = "modeId" in patch ? patch.modeId : seat.modeId;
  if (modeId !== undefined) next.modeId = modeId;

  const thinkingOptionId = "thinkingOptionId" in patch ? patch.thinkingOptionId : seat.thinkingOptionId;
  if (thinkingOptionId !== undefined) next.thinkingOptionId = thinkingOptionId;

  const features = "features" in patch ? patch.features : seat.features;
  if (features !== undefined) next.features = features;

  return next;
}

function providerMoved(seat: SeatDraft, provider: string | undefined): boolean {
  return provider !== undefined && provider !== seat.provider;
}

/**
 * Patch one role: its seat, or the fields a title and a prompt read.
 *
 * The id never changes here. Agent titles resolve a role by its name, and the
 * stored record keys the role by id, so a rename that also moved the id would
 * orphan every title already out there.
 */
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
    ...(patch.brief !== undefined
      ? { brief: patch.brief }
      : current.brief !== undefined
        ? { brief: current.brief }
        : {}),
  };

  const roles = draft.roles.slice();
  roles[index] = next;
  return { ...draft, roles };
}

/**
 * Append a worker role copied from the first worker's seat. `useFor` starts
 * empty, so the new role is not savable until the user says what it is for, and
 * its name starts as its id, which is what a title carries. A taken or
 * malformed id leaves the draft unchanged.
 */
export function addRole(draft: RoomDraft, id: string): RoomDraft {
  if (!roleIdSchema.safeParse(id).success) return draft;
  if (draft.roles.some((role) => role.id === id)) return draft;

  const template = draft.roles.find((role) => role.kind === "worker");
  if (template === undefined) return draft;

  const added: RoleDraft = {
    ...mergeSeat(template, {}),
    id,
    name: id.slice(0, ROLE_NAME_MAX_LENGTH),
    kind: "worker",
    useFor: "",
  };
  // The seat's feature map is a value on the role, not shared state: editing
  // the copy must never reach the worker it was copied from.
  if (template.features !== undefined) added.features = { ...template.features };

  return { ...draft, roles: [...draft.roles, added] };
}

/**
 * Drop a worker role. The supervisor and the lead are single, required roles,
 * and a room with no worker role has nothing for a Lead to launch, so both are
 * refused rather than left for the schema to report.
 */
export function removeRole(draft: RoomDraft, id: string): RoomDraft {
  const target = draft.roles.find((role) => role.id === id);
  if (target === undefined || target.kind !== "worker") return draft;

  const roles = draft.roles.filter((role) => role.id !== id);
  if (!roles.some((role) => role.kind === "worker")) return draft;

  return { ...draft, roles };
}

export interface DraftValidation {
  ok: boolean;
  /** The document to hand to `save`, or `null` while the draft is invalid. */
  settings: RoomSettings | null;
  /** One line naming what blocks the save; empty when the draft is valid. */
  error: string;
}

const MAX_REPORTED_ISSUES = 3;

/**
 * `roomSettingsSchema` accepts either the roles document or a legacy seats
 * document, so anything wrong with a field fails the union as one pathless
 * "Invalid input". A draft is always the roles document — the first branch — so
 * that branch's issues are the ones the user can act on.
 */
function actionableIssues(issues: readonly ZodIssue[]): ZodIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union" ? actionableIssues(issue.errors[0] ?? []) : [issue],
  );
}

/**
 * The single gate between the editor and the settings store: Save is disabled
 * exactly while this reports `ok: false`.
 */
export function validateDraft(draft: RoomDraft): DraftValidation {
  const parsed = roomSettingsSchema.safeParse(draft);
  if (parsed.success) return { ok: true, settings: parsed.data, error: "" };

  const actionable = actionableIssues(parsed.error.issues);
  const reported = actionable.length > 0 ? actionable : parsed.error.issues;
  const issues = reported.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, settings: null, error: issues.join("; ") };
}
