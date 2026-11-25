import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ColumnId } from "./board-model";
import { columnAccent, columnIcon } from "./column-accent";
import type { BoardWorkspaceCard } from "./use-board-workspaces";
import { WorkspaceCard } from "./workspace-card";

interface BoardSectionProps {
  id: ColumnId;
  title: string;
  items: readonly BoardWorkspaceCard[];
  showHost: boolean;
  theme: PluginTheme;
  navigation?: PluginSurfaceProps["navigation"];
  now: number;
  /** Measured cell width for an even grid; undefined on a narrow layout. */
  cardWidth?: number;
  /** Open the quick preview for the pressed card. */
  onPreview?(workspace: BoardWorkspaceCard): void;
  /** The workspace the preview shows, marked on its card. */
  previewKey?: string | null;
}

/**
 * One state of the board: a header with its count, then its cards in an even grid.
 * A section with cards collapses on press, so a long Idle list can be folded away.
 */
export function BoardSection({
  id,
  title,
  items,
  showHost,
  theme,
  navigation,
  now,
  cardWidth,
  onPreview,
  previewKey = null,
}: BoardSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const accent = columnAccent(id, theme.colors);

  const styles = useMemo(
    () => ({
      section: { gap: 8 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        minHeight: 22,
      },
      chevron: { width: 12, alignItems: "center" as const },
      title: {
        color: theme.colors.foreground,
        fontSize: 12.5,
        fontWeight: "600" as const,
        letterSpacing: 0.2,
      },
      count: { color: theme.colors.foregroundMuted, fontSize: 11.5, fontWeight: "500" as const },
      grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      pressed: { opacity: 0.6 },
    }),
    [theme],
  );

  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${title}, ${items.length}`}
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => setCollapsed((value) => !value)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.chevron}>
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            size={13}
            color={theme.colors.foregroundMuted}
          />
        </View>
        <Icon name={columnIcon(id)} size={12} color={accent} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.count}>{items.length}</Text>
      </Pressable>
      {collapsed ? null : (
        <View style={styles.grid}>
          {items.map((workspace) => (
            <WorkspaceCard
              key={workspace.key}
              workspace={workspace}
              column={id}
              showHost={showHost}
              theme={theme}
              navigation={navigation}
              now={now}
              width={cardWidth}
              onPreview={onPreview}
              selected={previewKey === workspace.key}
            />
          ))}
        </View>
      )}
    </View>
  );
}
