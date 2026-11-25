import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, usePaseo } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { PARKED_LABEL, formatAge, type ColumnId } from "./board-model";
import { columnAccent, columnSurface, isDarkTheme } from "./column-accent";
import type { BoardWorkspaceCard } from "./use-board-workspaces";

interface WorkspaceCardProps {
  workspace: BoardWorkspaceCard;
  column: ColumnId;
  /** Name the host on the card; only worth the space when the board merges several. */
  showHost: boolean;
  theme: PluginTheme;
  navigation?: PluginSurfaceProps["navigation"];
  /** Epoch ms from the board's clock, so ages keep counting without a data refetch. */
  now: number;
  /** Grid cell width measured by the board, so cards line up in even columns. */
  width?: number;
  /** The card's own press: open the quick preview beside the board. */
  onPreview?: (workspace: BoardWorkspaceCard) => void;
  /** The card this preview is showing, so its press reads as selected. */
  selected?: boolean;
}

export const WorkspaceCard = memo(function WorkspaceCard({
  workspace,
  column,
  showHost,
  theme,
  navigation,
  now,
  width,
  onPreview,
  selected = false,
}: WorkspaceCardProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const accent = columnAccent(column, theme.colors);
  const attention = column === "needs-you" || column === "review";
  const surface = attention
    ? columnSurface(column, theme.colors, isDarkTheme(theme.colors) ? 0.14 : 0.07)
    : theme.colors.surface1;

  const styles = useMemo(
    () => ({
      card: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        width: width ?? ("100%" as const),
        backgroundColor: surface,
        borderColor: selected ? accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 9,
        paddingVertical: 8,
        paddingLeft: 9,
        paddingRight: 7,
      },
      accentBar: { width: 2, alignSelf: "stretch" as const, borderRadius: 1, backgroundColor: accent },
      body: { flex: 1, gap: 2, minWidth: 0 },
      title: {
        color: theme.colors.foreground,
        fontSize: 13.5,
        fontWeight: "600" as const,
        lineHeight: 18,
      },
      metaRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      failed: { color: theme.colors.statusDanger, fontSize: 11, fontWeight: "600" as const },
      meta: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 11.5 },
      age: { color: theme.colors.foregroundMuted, fontSize: 11.5, flexShrink: 0 },
      action: {
        alignItems: "center" as const,
        justifyContent: "center" as const,
        width: 24,
        height: 24,
        borderRadius: 6,
      },
      pressed: { opacity: 0.7 },
    }),
    [theme, accent, surface, width, selected],
  );

  const title = workspace.title ?? workspace.name;
  const age = formatAge(workspace.statusEnteredAt, now);
  const meta = showHost
    ? `${workspace.projectDisplayName} · ${workspace.hostLabel}`
    : workspace.projectDisplayName;
  const isParked = workspace.labels.some(
    (label) => label.toLowerCase() === PARKED_LABEL.toLowerCase(),
  );
  // The card may live on another host than the screen: label it through its own daemon.
  const hostApi = () =>
    typeof getPaseoClient === "function" ? getPaseoClient(workspace.serverId) : paseo;
  // Older hosts have no label API on a workspace handle; hide Park rather than fail on press.
  const canPark = (() => {
    try {
      return typeof (hostApi().workspaces.ref(workspace.id) as { setLabel?: unknown }).setLabel === "function";
    } catch {
      return false; // that host went offline since the board last drew
    }
  })();

  async function togglePark() {
    try {
      await hostApi().workspaces.ref(workspace.id).setLabel(PARKED_LABEL, { assigned: !isParked });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function openWorkspace() {
    navigation?.openWorkspace({ workspaceId: workspace.id, serverId: workspace.serverId });
  }

  // The open area, the preview and the Park button are siblings: nesting one Pressable in
  // another hides the inner one from screen readers and breaks button semantics on web.
  return (
    <View style={styles.card}>
      <View style={styles.accentBar} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Preview ${title}`}
        accessibilityState={{ selected }}
        onPress={() => (onPreview === undefined ? openWorkspace() : onPreview(workspace))}
        style={({ pressed }) => [styles.body, pressed && styles.pressed]}
      >
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <View style={styles.metaRow}>
          {workspace.indicator === "failed" ? (
            <Text style={styles.failed}>Failed</Text>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
          {age === null ? null : <Text style={styles.age}>· {age}</Text>}
        </View>
      </Pressable>
      {canPark ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${isParked ? "Unpark" : "Park"} ${title}`}
          onPress={togglePark}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Icon
            name={isParked ? "ArchiveRestore" : "Archive"}
            size={13}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      ) : null}
      {onPreview === undefined || navigation === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title} in its project`}
          onPress={openWorkspace}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Icon name="ExternalLink" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
});
