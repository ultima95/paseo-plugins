import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardItem } from "./client/board-item";
import { BoardScreen } from "./client/board-screen";
import { registerBoardHeaderButtons } from "./client/header-button";

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
  // The sidebar row disappears with the sidebar, so each open workspace's header carries one too.
  const removeHeaders = registerBoardHeaderButtons(client);

  return () => {
    removeScreen();
    removeItem();
    removeHeaders();
  };
}
