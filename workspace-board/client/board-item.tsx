import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { groupBoard, isChildWorkspace } from "./board-model";
import { colorWithAlpha, columnAccent } from "./column-accent";
import { useBoardWorkspaces } from "./use-board-workspaces";

export function BoardItem({ currentScreen, openScreen, theme, host }: PluginSidebarItemProps) {
  // The board's own subscription, so the count matches its columns and spans every host.
  const board = useBoardWorkspaces(host);
  const counts = useMemo(() => {
    if (board.status !== "ready") return { blocked: 0, review: 0 };
    const grouped = groupBoard(
      board.workspaces.filter((workspace) => !isChildWorkspace(workspace)),
    );
    return { blocked: grouped["needs-you"].length, review: grouped.review.length };
  }, [board]);

  const badges = useMemo(
    () =>
      (
        [
          { column: "needs-you", icon: "AlertCircle", label: "needs input", count: counts.blocked },
          { column: "review", icon: "Eye", label: "to review", count: counts.review },
        ] as const
      ).filter((badge) => badge.count > 0),
    [counts],
  );

  const styles = useMemo(
    () => ({
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      badge: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 2,
      },
      count: { fontSize: 11, fontWeight: "600" as const },
    }),
    [],
  );

  return (
    <SidebarRow
      icon="LayoutGrid"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
      trailing={
        badges.length === 0 ? undefined : (
          <View style={styles.row}>
            {badges.map((badge) => {
              const accent = columnAccent(badge.column, theme.colors);
              return (
                <View
                  key={badge.column}
                  style={[styles.badge, { backgroundColor: colorWithAlpha(accent, 0.14) }]}
                  accessibilityLabel={`${badge.count} ${badge.label}`}
                >
                  <Icon name={badge.icon} size={11} color={accent} />
                  <Text style={[styles.count, { color: accent }]}>{badge.count}</Text>
                </View>
              );
            })}
          </View>
        )
      }
    />
  );
}
