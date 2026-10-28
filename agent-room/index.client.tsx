import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

import { RoomsScreen } from "./client/rooms-screen";

/** The sidebar row: a navigation entry with the Lucide `Users` icon. */
function RoomsSidebarItem(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Users"
      active={props.currentScreen?.screenId === "rooms"}
      onPress={() => props.openScreen({ screenId: "rooms" })}
    />
  );
}

/**
 * The Rooms screen, the sidebar row that opens it, and the Command Center
 * entry. The live room view is registered by the screen that owns it.
 */
export default function contribute(client: PluginClientContext): () => void {
  const disposers = [
    client.addScreen({ id: "rooms", title: "Room", Component: RoomsScreen }),
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
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}
