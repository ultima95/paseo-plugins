import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

import { parseRoleTitle, roleForLegacyMarker, type Role, type RoomSettings } from "../shared/roles";
import type { MemberRecord } from "../shared/member";
import { parseSeatMarker } from "../shared/seats";
import { EMPTY_MEMBER_INDEX, type MemberIndex } from "./member-index";
import { renderSystemPrompt, type MemberRender } from "./render";
import { PROMPTS } from "./prompts/generated";

export type AgentCreateRequest = PluginBeforeRequests["agent.create"];

export type MemberPromptSource = (member: MemberRecord) => MemberRender | null;

export type SeatApplication = {
  request: AgentCreateRequest;
  role: Role;
  /** Set when a legacy `[room:peer:<tier>]` title named a tier the catalog lacks. */
  fallbackFrom?: string;
  /** The member whose seat was applied, when the request named one. */
  member?: MemberRecord;
  /** True when the member section had to drop charter or lesson content. */
  memberTruncated?: boolean;
};

/**
 * True when the request already carries the room prompt: `room.launch` and the
 * `agent.create` hook can both run for the same agent, and a prompt injected
 * twice would be paid for on every turn of the session.
 */
export function carriesRoomPrompt(systemPrompt: string | undefined): boolean {
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
 * A request that already carries the room protocol is passed through untouched:
 * `room.launch` and `room.adopt` built its seat and prompt, including any member.
 *
 * The pre-create hook cannot see the room (ruling R1), so a supervisor or lead
 * request whose provider/model exactly match a configured member of that kind is
 * treated as that member's launch and the member supplies the seat. Otherwise the
 * role catalog seat wins. Worker roles never do a member lookup.
 *
 * The seat owns routing, so provider-specific controls it leaves unset
 * (`modeId`, `thinkingOptionId`, `featureValues`) are dropped rather than
 * carried over from the caller's request. When the seat also changes the
 * provider, `providerOptions` is dropped too because it is provider-specific;
 * it survives a same-provider override. The provider-agnostic `mcpServers` and
 * `toolPolicy` are always left alone, as is the env.
 */
export function applySeat(
  request: AgentCreateRequest,
  settings: RoomSettings,
  members: MemberIndex = EMPTY_MEMBER_INDEX,
  memberPrompt: MemberPromptSource = () => null,
): SeatApplication | null {
  const resolved = resolveRole(request.config.title, settings);
  if (resolved === null) return null;
  const role = resolved.role;

  // `room.launch` and `room.adopt` already built the seat and the prompt,
  // including any member. Re-applying the role here would undo the member.
  if (carriesRoomPrompt(request.config.systemPrompt)) {
    const untouched: SeatApplication = { request, role };
    if (resolved.fallbackFrom !== undefined) untouched.fallbackFrom = resolved.fallbackFrom;
    return untouched;
  }

  const member =
    role.kind === "worker" || request.config.model === undefined
      ? undefined
      : members.forSeat(role.kind, request.config.provider, request.config.model);
  const seat = member ?? role;

  const config: AgentCreateRequest["config"] = { ...request.config };
  delete config.modeId;
  delete config.thinkingOptionId;
  delete config.featureValues;
  if (request.config.provider !== seat.provider) delete config.providerOptions;

  config.provider = seat.provider;
  config.model = seat.model;
  applyControls(config, seat);

  const rendered = member === undefined ? null : memberPrompt(member);
  const leadMember =
    role.kind === "supervisor"
      ? members.all().find((candidate) => candidate.role === "lead")
      : undefined;

  config.systemPrompt = renderSystemPrompt(role, settings, config.systemPrompt, {
    ...(rendered !== null ? { member: rendered } : {}),
    ...(leadMember !== undefined
      ? { leadMember: { provider: leadMember.provider, model: leadMember.model } }
      : {}),
  });

  const applied: SeatApplication = { request: { ...request, config }, role };
  if (resolved.fallbackFrom !== undefined) applied.fallbackFrom = resolved.fallbackFrom;
  if (member !== undefined) applied.member = member;
  if (rendered !== null) applied.memberTruncated = rendered.truncated;
  return applied;
}

function applyControls(
  config: AgentCreateRequest["config"],
  seat: { modeId?: string; thinkingOptionId?: string; features?: Record<string, unknown> },
): void {
  if (seat.modeId !== undefined) config.modeId = seat.modeId;
  if (seat.thinkingOptionId !== undefined) config.thinkingOptionId = seat.thinkingOptionId;
  if (seat.features !== undefined) config.featureValues = seat.features;
}
