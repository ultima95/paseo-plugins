import type { PaseoAgentConfig, PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import { GLOBAL_SCOPE, type MemberRecord, type MemberRole } from "../shared/member";
import { seatTitleForRole, type Role, type RoomSettings } from "../shared/roles";
import { adoptRoomRpc, getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import type { MemberStore } from "./member-store";
import { renderMemberSection, renderSystemPrompt, type MemberRender } from "./render";
import { scopesFor } from "./scope";
import type { RoomStore } from "./store";

export interface HandlerDeps {
  /** Loaded before any handler runs: `index.server.ts` awaits `store.load()` first. */
  store: RoomStore;
  readSettings: () => Promise<RoomSettings>;
  members: MemberStore;
  /** The repository identity of a directory, or null outside a repository. */
  repoIdFor: (cwd: string) => Promise<string | null>;
}

export interface RoomHandlers {
  launch(input: RpcInput<typeof launchRoomRpc>, paseo: PaseoApi): Promise<RpcOutput<typeof launchRoomRpc>>;
  adopt(input: RpcInput<typeof adoptRoomRpc>, paseo: PaseoApi): Promise<RpcOutput<typeof adoptRoomRpc>>;
  list(): RpcOutput<typeof listRoomsRpc>;
  get(input: RpcInput<typeof getRoomRpc>): RpcOutput<typeof getRoomRpc>;
}

/**
 * The one role that owns a room. The settings schema already guarantees exactly
 * one supervisor role; the handler is a boundary, so a catalog without one fails
 * loudly instead of launching whatever comes first.
 */
function supervisorRole(settings: RoomSettings): Role {
  const role = settings.roles.find((candidate) => candidate.kind === "supervisor");
  if (role === undefined) throw new Error("no supervisor role configured");
  return role;
}

/**
 * A seat's config as the client SDK wants it: one combined `provider/model`
 * string (the create call has no separate `model` field), plus the controls the
 * seat defines. A control the seat leaves undefined is omitted, so the provider
 * keeps its own default instead of being handed `undefined`. A role and a member
 * share this shape.
 */
function seatConfig(source: {
  provider: string;
  model: string;
  modeId?: string | undefined;
  thinkingOptionId?: string | undefined;
  features?: Record<string, unknown> | undefined;
}): PaseoAgentConfig {
  const config: PaseoAgentConfig = { provider: `${source.provider}/${source.model}` };
  if (source.modeId !== undefined) config.modeId = source.modeId;
  if (source.thinkingOptionId !== undefined) config.thinkingOptionId = source.thinkingOptionId;
  if (source.features !== undefined) config.featureValues = source.features;
  return config;
}

/** Resolve a selected member, or fail before anything is created. */
function memberFor(
  deps: HandlerDeps,
  id: string | undefined,
  role: MemberRole,
): MemberRecord | null {
  if (id === undefined) return null;
  const member = deps.members.get(id);
  if (member === undefined) throw new Error(`room.launch: member not found: ${id}`);
  if (member.role !== role) throw new Error(`room.launch: ${id} is not a ${role} member`);
  return member;
}

/** The room's directory: the input's `cwd`, else the workspace's own directory. */
async function directoryFor(
  input: RpcInput<typeof launchRoomRpc>,
  paseo: PaseoApi,
): Promise<string | null> {
  if (input.cwd !== undefined) return input.cwd;
  if (input.workspaceId === undefined) return null;
  const result = await paseo.workspaces.list({});
  const entry = result.entries.find((workspace) => workspace.id === input.workspaceId);
  return entry?.workspaceDirectory ?? entry?.projectRootPath ?? null;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The RPC surface. `launch` only creates the Supervisor agent: `agent.created`
 * writes the room record, the seat and the feed when the agent shows up, so a
 * create that fails leaves the store untouched. `list` and `get` are pure store
 * reads — the store is the single source of truth the hooks keep current.
 */
export function createHandlers(deps: HandlerDeps): RoomHandlers {
  const store = deps.store;

  return {
    async launch(input, paseo) {
      const settings = await deps.readSettings();
      const role = supervisorRole(settings);
      // Resolve both members before any create: a bad id must leave nothing behind.
      const supervisorMember = memberFor(deps, input.supervisorMemberId, "supervisor");
      const leadMember = memberFor(deps, input.leadMemberId, "lead");

      let memberSection: MemberRender | null = null;
      if (supervisorMember !== null) {
        const cwd = await directoryFor(input, paseo);
        const repoId = cwd === null ? null : await deps.repoIdFor(cwd);
        memberSection = renderMemberSection({
          name: supervisorMember.name,
          charter: deps.members.charter(supervisorMember.id),
          // With no directory there is no repo or workspace to scope to.
          lessons: deps.members.lessonsFor(
            supervisorMember.id,
            cwd === null ? [GLOBAL_SCOPE] : scopesFor(cwd, repoId),
          ),
        });
      }

      // The Supervisor carries its own prompt: role delivery must not depend on
      // the `agent.create` hook firing for a plugin-originated create. If the
      // hook does run, `applySeat` sees the prompt already there and leaves it.
      const config = seatConfig(supervisorMember ?? role);
      config.systemPrompt = renderSystemPrompt(role, settings, undefined, {
        ...(memberSection !== null ? { member: memberSection } : {}),
        ...(leadMember !== null
          ? { leadMember: { provider: leadMember.provider, model: leadMember.model } }
          : {}),
      });
      // A workspace owns the directory, so `cwd` belongs only on a bare create.
      const options: PaseoWorkspaceAgentCreateOptions = {
        config,
        title: seatTitleForRole(role, input.task),
        prompt: input.task,
      };

      const bind = (roomId: string): { roomId: string } => {
        store.bindRoomMembers(roomId, {
          supervisorMemberId: supervisorMember?.id ?? null,
          leadMemberId: leadMember?.id ?? null,
        });
        if (memberSection?.truncated === true) {
          store.appendFeed({
            roomId,
            kind: "note",
            from: null,
            to: roomId,
            label: "member note",
            text: "member section truncated",
          });
        }
        return { roomId };
      };

      if (input.workspaceId !== undefined) {
        const handle = await paseo.workspaces.ref(input.workspaceId).agents.create(options);
        return bind(handle.id);
      }

      if (input.cwd !== undefined) {
        // A bare create makes a new workspace even when the directory already
        // has one, so reuse the workspace that owns this directory instead.
        const cwd = trimTrailingSlash(input.cwd);
        const owns = (path: string | undefined): boolean =>
          path !== undefined && trimTrailingSlash(path) === cwd;
        const existing = (await paseo.workspaces.list({})).entries.find(
          (workspace) =>
            owns(workspace.workspaceDirectory) || owns(workspace.projectRootPath),
        );
        const handle = existing
          ? await paseo.workspaces.ref(existing.id).agents.create(options)
          : await paseo.agents.create({ ...options, cwd: input.cwd });
        return bind(handle.id);
      }

      // The contract refines this away; a handler is still a boundary.
      throw new Error("launch requires workspaceId or cwd");
    },

    async adopt(input, paseo) {
      const recorded = store.room(input.agentId);
      if (recorded) return { roomId: recorded.room.id };

      const handle = paseo.agents.ref(input.agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent) throw new Error("room.adopt: agent not found");
      if (store.seat(input.agentId)) {
        throw new Error("room.adopt: agent already holds a room seat");
      }

      const roomId = agent.id;
      const title = agent.title?.trim() ?? "";
      // Read the catalog before the first write: an unloadable or supervisor-less
      // catalog must fail the adopt with the store untouched.
      const settings = await deps.readSettings();
      const role = supervisorRole(settings);
      // The chat keeps its provider, model, mode and effort. The seat record
      // describes what actually runs so the tree and live view are truthful.
      // The model falls back to the role's: the seat schema requires non-empty
      // text, and one empty model would make the whole `rooms.json` unloadable
      // on the next start.
      store.addRoom({
        id: roomId,
        task: title.length > 0 ? title : "Adopted chat",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId ?? null,
        supervisorMemberId: null,
        leadMemberId: null,
        createdAt: agent.createdAt,
      });
      // A complete role seat, never the legacy marker: the feed, the guard and
      // the client all read the role, and a reload must not depend on the title.
      store.addSeat({
        agentId: roomId,
        roomId,
        parentId: null,
        roleId: role.id,
        roleName: role.name,
        roleKind: role.kind,
        provider: agent.provider,
        model: agent.model ?? role.model,
        title,
      });
      store.appendFeed({
        roomId,
        kind: "note",
        from: null,
        to: roomId,
        label: "adopted",
        text: "This chat became the room Supervisor.",
      });
      await store.flush();

      await handle.send(
        `This chat is the Supervisor seat of an agent room. Follow this protocol and role from here on.\n\n${renderSystemPrompt(role, settings)}`,
      );
      return { roomId };
    },

    list() {
      return { rooms: store.listRooms() };
    },

    get(input) {
      return store.room(input.roomId) ?? { missing: true };
    },
  };
}
