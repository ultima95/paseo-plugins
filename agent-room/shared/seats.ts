import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Paseo agent titles are capped at 60 characters. */
export const AGENT_TITLE_MAX_LENGTH = 60;

const nonEmptyText = z.string().min(1);

/**
 * How to start one agent. `provider` and `model` are bare ids (`claude`,
 * `claude-opus-5-5`); the seat model never knows about account prefixes.
 */
export const seatConfigSchema = z.object({
  provider: nonEmptyText,
  model: nonEmptyText,
  modeId: nonEmptyText.optional(),
  thinkingOptionId: nonEmptyText.optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});

export type SeatConfig = z.infer<typeof seatConfigSchema>;

/**
 * Longest tier id that keeps a `[room:peer:<id>] <title>` title parseable. The
 * marker plus its trailing space is 13 characters (`[room:peer:` is 11, then the
 * id, then `] `), so the id must stay under `AGENT_TITLE_MAX_LENGTH - 13` for the
 * closing bracket to survive `seatTitle`'s slice — an id past that leaves
 * `parseSeatMarker` seeing no marker at all, and the guard then treats the Peer
 * as unmanaged. Capped at 40, well inside the limit, so a real title still fits
 * after the marker.
 */
export const PEER_TIER_ID_MAX_LENGTH = AGENT_TITLE_MAX_LENGTH - 20;

/** Tier ids are lowercase kebab-case so they survive the seat marker grammar. */
export const peerTierIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "tier id must be lowercase kebab-case")
  .max(PEER_TIER_ID_MAX_LENGTH, `tier id must be at most ${PEER_TIER_ID_MAX_LENGTH} characters`);

export const peerTierSchema = seatConfigSchema.extend({
  id: peerTierIdSchema,
  useFor: z.string().min(1),
});

export type PeerTier = z.infer<typeof peerTierSchema>;

export const roomSettingsSchema = z
  .object({
    supervisor: seatConfigSchema,
    lead: seatConfigSchema,
    peerTiers: z.array(peerTierSchema).min(1, "at least one peer tier is required"),
  })
  .superRefine((settings, ctx) => {
    const ids = settings.peerTiers.map((tier) => tier.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate peer tier id "${duplicate}"`,
        path: ["peerTiers"],
      });
    }
    if (!ids.includes("default")) {
      ctx.addIssue({
        code: "custom",
        message: 'one peer tier must have id "default"',
        path: ["peerTiers"],
      });
    }
  });

export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const roomSettings = defineSettings({
  id: "seats",
  scope: "host",
  version: 1,
  schema: roomSettingsSchema,
});

export const DEFAULT_SETTINGS: RoomSettings = {
  supervisor: {
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "xhigh",
  },
  lead: {
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "high",
  },
  peerTiers: [
    {
      id: "cheap",
      provider: "claude",
      model: "claude-haiku-4-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      useFor: "Extraction, formatting, log triage, mechanical edits",
    },
    {
      id: "default",
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      useFor: "Implementation, debugging, research",
    },
    {
      id: "expensive",
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
      useFor: "Hard problems a cheaper tier failed on",
    },
    {
      id: "review",
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
      useFor: "Read-only review of a candidate",
    },
    {
      id: "cross-family",
      provider: "codex",
      model: "gpt-5.6-sol",
      modeId: "full-access",
      thinkingOptionId: "medium",
      useFor: "Cross-family implementation or second opinion",
    },
    {
      id: "cross-family-review",
      provider: "codex",
      model: "gpt-5.6-sol",
      modeId: "full-access",
      thinkingOptionId: "high",
      useFor: "Cross-family read-only review",
    },
  ],
};

export type SeatMarker = { seat: "supervisor" } | { seat: "lead" } | { seat: "peer"; tier: string };

/**
 * The marker must be anchored at the start of the (trimmed) title, so a title
 * that merely mentions a marker mid-sentence is left alone.
 */
const MARKER_PATTERN = /^\[room:(supervisor|lead|peer(?::([a-z0-9-]+))?)\]\s*/i;
const TIER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const DEFAULT_TIER_ID = "default";

/**
 * Read the seat marker off an agent title. Returns `null` when the title carries
 * no marker, or when the marker is malformed (unknown seat, bad tier id): such
 * agents are unmanaged and must never be touched.
 */
export function parseSeatMarker(
  title: string | null | undefined,
): { marker: SeatMarker; rest: string } | null {
  if (!title) return null;

  const trimmed = title.trim();
  const match = MARKER_PATTERN.exec(trimmed);
  if (!match) return null;

  const rest = trimmed.slice(match[0].length);
  const seat = match[1].toLowerCase();

  if (seat === "supervisor") return { marker: { seat: "supervisor" }, rest };
  if (seat === "lead") return { marker: { seat: "lead" }, rest };

  const tier = (match[2] ?? DEFAULT_TIER_ID).toLowerCase();
  if (!TIER_ID_PATTERN.test(tier)) return null;
  return { marker: { seat: "peer", tier }, rest };
}

/** Render a marker back to the exact token Paseo titles carry. */
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

/** Build a titled agent name: marker first, then the trimmed text, capped at 60. */
export function seatTitle(marker: SeatMarker, text: string): string {
  return `${formatMarker(marker)} ${text.trim()}`.slice(0, AGENT_TITLE_MAX_LENGTH);
}

function toSeatConfig(tier: PeerTier): SeatConfig {
  const config: SeatConfig = { provider: tier.provider, model: tier.model };
  if (tier.modeId !== undefined) config.modeId = tier.modeId;
  if (tier.thinkingOptionId !== undefined) config.thinkingOptionId = tier.thinkingOptionId;
  if (tier.features !== undefined) config.features = tier.features;
  return config;
}

/**
 * Resolve the config for a seat. An unknown peer tier falls back to the
 * `default` tier and reports where it came from, so the caller can tell the
 * Supervisor the tier it asked for does not exist.
 */
export function seatConfigFor(
  marker: SeatMarker,
  settings: RoomSettings,
): { config: SeatConfig; fallbackFrom?: string } {
  if (marker.seat === "supervisor") return { config: settings.supervisor };
  if (marker.seat === "lead") return { config: settings.lead };

  const tier = settings.peerTiers.find((candidate) => candidate.id === marker.tier);
  if (tier) return { config: toSeatConfig(tier) };

  const fallback =
    settings.peerTiers.find((candidate) => candidate.id === DEFAULT_TIER_ID) ?? settings.peerTiers[0];
  // `roomSettingsSchema` guarantees at least one tier, but a hand-built settings
  // object could be empty; the Lead config is the last resort.
  if (!fallback) return { config: settings.lead, fallbackFrom: marker.tier };
  return { config: toSeatConfig(fallback), fallbackFrom: marker.tier };
}
