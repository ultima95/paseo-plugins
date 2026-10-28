import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

import {
  parseSeatMarker,
  seatConfigFor,
  type RoomSettings,
  type SeatConfig,
  type SeatMarker,
} from "../shared/seats";
import { renderSystemPrompt } from "./render";

export type AgentCreateRequest = PluginBeforeRequests["agent.create"];

export type SeatApplication = {
  request: AgentCreateRequest;
  marker: SeatMarker;
  /** Set when the title asked for a peer tier that is not configured. */
  fallbackFrom?: string;
};

/**
 * Overlay a seat onto a create request. Returns `null` for an agent whose title
 * carries no `[room:…]` marker: unmanaged agents are never modified.
 *
 * The seat owns routing, so provider-specific controls the seat leaves unset
 * (`modeId`, `thinkingOptionId`, `featureValues`) are dropped rather than
 * carried over from the caller's request. Everything else on the config and the
 * env survive untouched.
 */
export function applySeat(
  request: AgentCreateRequest,
  settings: RoomSettings,
): SeatApplication | null {
  const parsed = parseSeatMarker(request.config.title);
  if (!parsed) return null;

  const { marker } = parsed;
  const { config: seat, fallbackFrom } = seatConfigFor(marker, settings);

  const config: AgentCreateRequest["config"] = { ...request.config };
  delete config.modeId;
  delete config.thinkingOptionId;
  delete config.featureValues;

  config.provider = seat.provider;
  config.model = seat.model;
  applySeatControls(config, seat);
  config.systemPrompt = renderSystemPrompt(marker, settings, config.systemPrompt);

  const applied: SeatApplication = { request: { ...request, config }, marker };
  if (fallbackFrom !== undefined) applied.fallbackFrom = fallbackFrom;
  return applied;
}

function applySeatControls(config: AgentCreateRequest["config"], seat: SeatConfig): void {
  if (seat.modeId !== undefined) config.modeId = seat.modeId;
  if (seat.thinkingOptionId !== undefined) config.thinkingOptionId = seat.thinkingOptionId;
  if (seat.features !== undefined) config.featureValues = seat.features;
}
