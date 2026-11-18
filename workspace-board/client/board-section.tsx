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
  const empty = items.length === 0;

  const styles = useMemo(
    () => ({
      section: { gap: 10 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 24,
        opacity: empty ? 0.5 : 1,
      },
      chevron: { width: 14, alignItems: "center" as const },
      title: {
        color: empty ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
      },
      count: {
        minWidth: 20,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      countText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      rule: { flex: 1, height: 1, backgroundColor: theme.colors.border },
      grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 10 },
      pressed: { opacity: 0.6 },
    }),
    [theme, accent, empty],
  );

  const header = (
    <>
      <View style={styles.chevron}>
        {empty ? null : (
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        )}
      </View>
      <Icon name={columnIcon(id)} size={13} color={accent} />
      <Text style={styles.title}>{title}</Text>
      <View style={styles.count}>
        <Text style={styles.countText}>{items.length}</Text>
      </View>
      <View style={styles.rule} />
    </>
  );

  return (
    <View style={styles.section}>
      {empty ? (
        <View style={styles.header}>{header}</View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${title}, ${items.length}`}
          accessibilityState={{ expanded: !collapsed }}
          onPress={() => setCollapsed((value) => !value)}
          style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        >
          {header}
        </Pressable>
      )}
      {empty || collapsed ? null : (
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
