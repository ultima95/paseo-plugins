import type { PaseoAgentConfig, PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import { getRoomRpc, launchRoomRpc, listRoomsRpc } from "../shared/rpc";
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
        const handle = await paseo.agents.create({ ...options, cwd: input.cwd });
        return { roomId: handle.id };
      }

      // The contract refines this away; a handler is still a boundary.
      throw new Error("launch requires workspaceId or cwd");
    },

    list() {
      return { rooms: store.listRooms() };
    },

    get(input) {
      return store.room(input.roomId) ?? { missing: true };
    },
  };
}
