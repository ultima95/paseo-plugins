import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

import { GuardRow, guardRowSchema } from "./client/guard-row";
import { RoomScreen } from "./client/room-screen";
import { RoomsScreen } from "./client/rooms-screen";
import { describeError } from "./client/seat-editor";
import { GUARD_ROW_KIND, GUARD_ROW_VERSION } from "./shared/room";
import { launchRoomRpc } from "./shared/rpc";

/** The sidebar row: a navigation entry with the Lucide `Users` icon. */
function RoomsSidebarItem(props: PluginSidebarItemProps) {
  const screenId = props.currentScreen?.screenId;
  return (
    <SidebarRow
      icon="Users"
      // The room list and a live room are the same feature, so either keeps the
      // row highlighted rather than making the live view look like another screen.
      active={screenId === "rooms" || screenId === "room"}
      onPress={() => props.openScreen({ screenId: "rooms" })}
    />
  );
}

/**
 * The Room screen, the live view of one room, the sidebar row that opens them,
 * the Command Center entry, `/room`, and the guard's timeline row.
 */
export default function contribute(client: PluginClientContext): () => void {
  const disposers = [
    client.addScreen({ id: "rooms", title: "Room", Component: RoomsScreen }),
    client.addScreen({ id: "room", title: () => "Room", Component: RoomScreen }),
    client.addSidebarHeaderItem({ id: "rooms", title: "Room", Component: RoomsSidebarItem }),
    client.addCommandCenterItem({
      id: "open-rooms",
      title: "Room",
      icon: "Users",
      context: "global",
      onSelect(ctx) {
        ctx.openScreen({ screenId: "rooms" });
      },
    }),
    client.addSlashCommand({
      name: "room",
      description: "Start an agent room for a task and open its live view",
      argumentHint: "<task>",
      context: "workspace",
      async onSubmit(context) {
        const task = context.args.trim();
        // No task, no room: `/room` alone is a request for the Room screen.
        if (task.length === 0) {
          context.openScreen({ screenId: "rooms" });
          return;
        }
        try {
          const { roomId } = await context.rpc(launchRoomRpc, {
            task,
            workspaceId: context.workspace.id,
          });
          context.openScreen({ screenId: "room", params: { roomId } });
        } catch (caught) {
          // A launch that failed leaves no room to show, so the user stays where
          // they are. There is no toast on this context in 0.13.1; the console
          // is the only channel, and the Supervisor's own agent is where the
          // failure surfaces if one was created.
          console.error(`[agent-room] /room could not start a room — ${describeError(caught)}`);
        }
      },
    }),
    client.addTimelineRenderer({
      kind: GUARD_ROW_KIND,
      version: GUARD_ROW_VERSION,
      schema: guardRowSchema,
      Component: GuardRow,
    }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}
