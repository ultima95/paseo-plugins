import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable } from "react-native";

import { GuardRow, guardRowSchema } from "./client/guard-row";
import { GcScreen } from "./client/gc-screen";
import { RoomManagerPanel } from "./client/room-manager";
import { contributeRoomPills } from "./client/room-pill";
import { RoomScreen } from "./client/room-screen";
import { RoomStatusRow } from "./client/room-status-row";
import { RoomsPopover } from "./client/rooms-popover";
import { RoomsScreen } from "./client/rooms-screen";
import { describeError } from "./client/seat-editor";
import { GUARD_ROW_KIND, GUARD_ROW_VERSION } from "./shared/room";
import {
  parseRoomStatusMessage,
  ROOM_STATUS_KIND,
  ROOM_STATUS_VERSION,
  roomStatusSchema,
} from "./shared/room-status";
import { launchRoomRpc } from "./shared/rpc";

/**
 * The sidebar row: a navigation entry with the Lucide `Users` icon.
 *
 * The row itself opens the Rooms screen; the trailing button opens a popover of
 * recent rooms, which is the one surface that can navigate to a live room.
 */
function RoomsSidebarItem(props: PluginSidebarItemProps) {
  const screenId = props.currentScreen?.screenId;
  return (
    <SidebarRow
      icon="Users"
      // The room list and a live room are the same feature, so either keeps the
      // row highlighted rather than making the live view look like another screen.
      active={screenId === "rooms" || screenId === "room"}
      onPress={() => props.openScreen({ screenId: "rooms" })}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open recent rooms"
          hitSlop={8}
          onPress={() => props.openPopover(RoomsPopover)}
          style={{ padding: 4 }}
        >
          <Icon name="ChevronDown" size={14} color={props.theme.colors.foregroundMuted} />
        </Pressable>
      }
    />
  );
}

/**
 * The garbage-collection sidebar row: a navigation entry with the Lucide
 * `Trash2` icon. It opens the GC screen and stays highlighted while that screen
 * is the one open on this host.
 */
function GcSidebarItem(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Trash2"
      active={props.currentScreen?.screenId === "gc"}
      onPress={() => props.openScreen({ screenId: "gc" })}
    />
  );
}

/**
 * The Room screen, the live view of one room, the sidebar row that opens them,
 * the Command Center entry, `/room`, the guard's timeline row, and the GC screen
 * with its own sidebar row and Command Center entry.
 */
export default function contribute(client: PluginClientContext): () => void {
  const disposers = [
    client.addScreen({ id: "rooms", title: "Room", Component: RoomsScreen }),
    client.addScreen({ id: "room", title: () => "Room", Component: RoomScreen }),
    client.addSidebarHeaderItem({ id: "rooms", title: "Room", Component: RoomsSidebarItem }),
    client.addScreen({ id: "gc", title: "Garbage collection", Component: GcScreen }),
    client.addSidebarHeaderItem({ id: "gc", title: "Garbage collection", Component: GcSidebarItem }),
    client.addCommandCenterItem({
      id: "open-gc",
      title: "Garbage collection",
      icon: "Trash2",
      context: "global",
      onSelect(ctx) {
        ctx.openScreen({ screenId: "gc" });
      },
    }),
    client.addWorkspacePanel({
      id: "rooms-manager",
      title: "Rooms",
      icon: "Users",
      Component: RoomManagerPanel,
    }),
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
    // The Supervisor's room-state block is written into a `room-status` fence:
    // this replaces that fence with a native card row, and leaves every other
    // assistant message alone.
    client.addTimelineTransformer({
      id: "room-status",
      query: { itemType: "assistant_message" },
      transform({ item }) {
        const data = parseRoomStatusMessage(item.text);
        if (data === null) return undefined;
        return {
          items: [{ type: "plugin", kind: ROOM_STATUS_KIND, version: ROOM_STATUS_VERSION, data }],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: ROOM_STATUS_KIND,
      version: ROOM_STATUS_VERSION,
      schema: roomStatusSchema,
      Component: RoomStatusRow,
    }),
  ];

  const disposePills = contributeRoomPills(client);

  return () => {
    disposePills();
    for (const dispose of disposers) dispose();
  };
}
