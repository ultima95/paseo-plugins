import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

import { parseRoleTitle, roleForLegacyMarker, type Role, type RoomSettings } from "../shared/roles";
import { parseSeatMarker } from "../shared/seats";
import { renderSystemPrompt } from "./render";
import { PROMPTS } from "./prompts/generated";

export type AgentCreateRequest = PluginBeforeRequests["agent.create"];

export type SeatApplication = {
  request: AgentCreateRequest;
  role: Role;
  /** Set when a legacy `[room:peer:<tier>]` title named a tier the catalog lacks. */
  fallbackFrom?: string;
};

/**
 * True when the request already carries the room prompt: `room.launch` and the
 * `agent.create` hook can both run for the same agent, and a prompt injected
 * twice would be paid for on every turn of the session.
 */
function carriesRoomPrompt(systemPrompt: string | undefined): boolean {
  return systemPrompt !== undefined && systemPrompt.includes(PROMPTS.protocol);
}

/**
 * The role a title names, or `null` for a title that names no role.
 *
 * Role titles (`Reviewer: audit`) are the grammar; a legacy `[room:…]` marker is
 * still read for one release so an in-flight room keeps working, and is mapped
 * onto the catalog's role. A legacy peer tier that is no longer configured
 * falls back to a worker role and reports which tier it came from.
 */
function resolveRole(
  title: string | null | undefined,
  settings: RoomSettings,
): { role: Role; fallbackFrom?: string } | null {
  const parsed = parseRoleTitle(title, settings.roles);
  if (parsed !== null) return { role: parsed.role };

  const legacy = parseSeatMarker(title);
  if (legacy === null) return null;
  return roleForLegacyMarker(legacy.marker, settings.roles);
}

/**
 * Overlay a role onto a create request. Returns `null` for an agent whose title
 * names no configured role: unmanaged agents are never modified.
 *
 * The role owns routing, so provider-specific controls the role leaves unset
 * (`modeId`, `thinkingOptionId`, `featureValues`) are dropped rather than
 * carried over from the caller's request. When the role also changes the
 * provider, `providerOptions` is dropped too because it is provider-specific;
 * it survives a same-provider override. The provider-agnostic `mcpServers` and
 * `toolPolicy` are always left alone, as is the env.
 */
export function applySeat(
  request: AgentCreateRequest,
  settings: RoomSettings,
): SeatApplication | null {
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
  // Idempotent: a request that already carries the room prompt (a launched
  // Supervisor, or a create that passed the hook twice) keeps it as it is. The
  // role override above still applies — only the text is left alone.
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
