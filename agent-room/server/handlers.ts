import type { PaseoAgentConfig, PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import { adoptRoomRpc, getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
import { seatTitle, type RoomSettings, type SeatConfig } from "../shared/seats";
import { renderSystemPrompt } from "./render";
import type { RoomStore } from "./store";

export interface HandlerDeps {
  /** Loaded before any handler runs: `index.server.ts` awaits `store.load()` first. */
  store: RoomStore;
  readSettings: () => Promise<RoomSettings>;
}

export interface RoomHandlers {
  launch(input: RpcInput<typeof launchRoomRpc>, paseo: PaseoApi): Promise<RpcOutput<typeof launchRoomRpc>>;
  adopt(input: RpcInput<typeof adoptRoomRpc>, paseo: PaseoApi): Promise<RpcOutput<typeof adoptRoomRpc>>;
  list(): RpcOutput<typeof listRoomsRpc>;
  get(input: RpcInput<typeof getRoomRpc>): RpcOutput<typeof getRoomRpc>;
}

/**
 * A seat's config as the client SDK wants it: one combined `provider/model`
 * string (the create call has no separate `model` field), plus the controls the
 * seat defines. A control the seat leaves undefined is omitted, so the provider
 * keeps its own default instead of being handed `undefined`.
 */
function seatAgentConfig(seat: SeatConfig): PaseoAgentConfig {
  const config: PaseoAgentConfig = { provider: `${seat.provider}/${seat.model}` };
  if (seat.modeId !== undefined) config.modeId = seat.modeId;
  if (seat.thinkingOptionId !== undefined) config.thinkingOptionId = seat.thinkingOptionId;
  if (seat.features !== undefined) config.featureValues = seat.features;
  return config;
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
      // The Supervisor carries its own prompt: role delivery must not depend on
      // the `agent.create` hook firing for a plugin-originated create. If the
      // hook does run, `applySeat` sees the prompt already there and leaves it.
      const config = seatAgentConfig(settings.supervisor);
      config.systemPrompt = renderSystemPrompt({ seat: "supervisor" }, settings);
      // A workspace owns the directory, so `cwd` belongs only on a bare create.
      const options: PaseoWorkspaceAgentCreateOptions = {
        config,
        title: seatTitle({ seat: "supervisor" }, input.task),
        prompt: input.task,
      };

      if (input.workspaceId !== undefined) {
        const handle = await paseo.workspaces.ref(input.workspaceId).agents.create(options);
        return { roomId: handle.id };
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
        return { roomId: handle.id };
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
      // The chat keeps its provider, model, mode and effort. The seat record
      // describes what actually runs so the tree and live view are truthful.
      store.addRoom({
        id: roomId,
        task: title.length > 0 ? title : "Adopted chat",
        cwd: agent.cwd,
        workspaceId: agent.workspaceId ?? null,
        createdAt: agent.createdAt,
      });
      store.addSeat({
        agentId: roomId,
        roomId,
        parentId: null,
        marker: { seat: "supervisor" },
        provider: agent.provider,
        model: agent.model ?? "",
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

      const settings = await deps.readSettings();
      const setup = renderSystemPrompt({ seat: "supervisor" }, settings);
      await handle.send(
        `This chat is the Supervisor seat of an agent room. Follow this protocol and role from here on.\n\n${setup}`,
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
