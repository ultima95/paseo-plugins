import type { PeerTier, RoomSettings, SeatConfig } from "../shared/seats";
import { peerTierIdSchema, roomSettingsSchema } from "../shared/seats";

/**
 * The seats document while it is being edited.
 *
 * `model` is optional here, unlike `SeatConfig`, because changing a seat's
 * provider clears the model: there is no valid model until the user picks one
 * from the new provider's catalog. A draft is only saved once
 * `roomSettingsSchema` accepts it (see `validateDraft`), so an empty seat can
 * never reach the daemon.
 */
export type SeatDraft = Omit<SeatConfig, "model"> & { model?: string };

export type SeatPatch = Partial<SeatConfig>;

export type TierDraft = SeatDraft & { id: string; useFor: string };

export type TierPatch = Partial<PeerTier>;

export type RoomDraft = {
  supervisor: SeatDraft;
  lead: SeatDraft;
  peerTiers: TierDraft[];
};

export type SeatKey = "supervisor" | "lead";

/** The id `roomSettingsSchema` requires one peer tier to carry. */
export const DEFAULT_TIER_ID = "default";

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

/** Patch the Supervisor or the Lead seat. */
export function setSeat(draft: RoomDraft, key: SeatKey, patch: SeatPatch): RoomDraft {
  const current = draft[key];
  const base = providerMoved(current, patch.provider)
    ? changeProvider(current, patch.provider as string)
    : current;
  const next = mergeSeat(base, patch);

  if (key === "supervisor") return { ...draft, supervisor: next };
  return { ...draft, lead: next };
}

/**
 * Patch one peer tier. The tier id never changes here: seat markers in agent
 * titles point at it, so renaming a tier is a different operation.
 */
export function setTier(draft: RoomDraft, id: string, patch: TierPatch): RoomDraft {
  const index = draft.peerTiers.findIndex((tier) => tier.id === id);
  if (index < 0) return draft;

  const current = draft.peerTiers[index];
  const base = providerMoved(current, patch.provider)
    ? changeProvider(current, patch.provider as string)
    : current;
  const merged = mergeSeat(base, patch);
  const next: TierDraft = { ...merged, id: current.id, useFor: patch.useFor ?? current.useFor };

  const peerTiers = draft.peerTiers.slice();
  peerTiers[index] = next;
  return { ...draft, peerTiers };
}

/**
 * Append a peer tier copied from `default`'s config. `useFor` starts empty, so
 * the new tier is not savable until the user says what it is for. A taken or
 * malformed id leaves the draft unchanged.
 */
export function addTier(draft: RoomDraft, id: string): RoomDraft {
  if (!peerTierIdSchema.safeParse(id).success) return draft;
  if (draft.peerTiers.some((tier) => tier.id === id)) return draft;

  const template = draft.peerTiers.find((tier) => tier.id === DEFAULT_TIER_ID);
  if (!template) return draft;

  const added: TierDraft = {
    ...mergeSeat(template, {}),
    id,
    useFor: "",
  };
  if (template.features) added.features = { ...template.features };

  return { ...draft, peerTiers: [...draft.peerTiers, added] };
}

/** Drop a peer tier. The `default` tier is what an unmarked tier id resolves to. */
export function removeTier(draft: RoomDraft, id: string): RoomDraft {
  if (id === DEFAULT_TIER_ID) return draft;

  const peerTiers = draft.peerTiers.filter((tier) => tier.id !== id);
  if (peerTiers.length === draft.peerTiers.length) return draft;

  return { ...draft, peerTiers };
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
 * The single gate between the editor and the settings store: Save is disabled
 * exactly while this reports `ok: false`.
 */
export function validateDraft(draft: RoomDraft): DraftValidation {
  const parsed = roomSettingsSchema.safeParse(draft);
  if (parsed.success) return { ok: true, settings: parsed.data, error: "" };

  const issues = parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, settings: null, error: issues.join("; ") };
}
