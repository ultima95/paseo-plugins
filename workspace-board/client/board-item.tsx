import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useWorkspaces } from "@getpaseo/plugin/client";
import { SidebarRow, Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { needsYou } from "./board-model";
import { colorWithAlpha, columnAccent } from "./column-accent";

export function BoardItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  // Sidebar items, unlike screens, run inside the host's state context. The board reads the
  // daemon `status` rather than the snapshot's `indicator`, so this count matches its columns.
  const count = useWorkspaces({
    where: (ws) =>
      needsYou({
        indicator: ws.status,
        labels: ws.labels,
        background: ws.background,
        archivingAt: ws.archivingAt,
      }),
  }).length;

  const accent = useMemo(() => columnAccent("needs-you", theme.colors), [theme]);

  const styles = useMemo(
    () => ({
      badge: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        backgroundColor: colorWithAlpha(accent, 0.14),
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 2,
      },
      count: { color: accent, fontSize: 11, fontWeight: "600" as const },
    }),
    [accent],
  );

  return (
    <SidebarRow
      icon="LayoutGrid"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
      trailing={
        count > 0 ? (
          <View
            style={styles.badge}
            accessibilityLabel={`${count} ${count === 1 ? "workspace needs" : "workspaces need"} you`}
          >
            <Icon name="AlertCircle" size={11} color={accent} />
            <Text style={styles.count}>{count}</Text>
          </View>
        ) : undefined
      }
    />
  );
}
