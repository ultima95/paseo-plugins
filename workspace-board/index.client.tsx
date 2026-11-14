import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardItem } from "./client/board-item";
import { BoardScreen } from "./client/board-screen";

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: "board",
    title: "Workspace board",
    Component: BoardScreen,
  });
  const removeItem = client.addSidebarHeaderItem({
    id: "board",
    title: "Workspace board",
    Component: BoardItem,
  });

  return () => {
    removeScreen();
    removeItem();
  };
}
