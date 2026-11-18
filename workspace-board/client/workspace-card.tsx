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

/** What the card says about a workspace that is waiting on the user. */
function attentionLabel(column: ColumnId, indicator: string): string | null {
  if (column === "needs-you") return indicator === "failed" ? "Failed" : "Waiting";
  if (column === "review") return "Review";
  if (column === "running") return "Running";
  return null;
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
        gap: 10,
        width: width ?? ("100%" as const),
        minHeight: 58,
        backgroundColor: surface,
        borderColor: selected ? accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: 10,
        paddingLeft: 10,
        paddingRight: 10,
      },
      accentBar: { width: 3, alignSelf: "stretch" as const, borderRadius: 2, backgroundColor: accent },
      body: { flex: 1, gap: 4, minWidth: 0 },
      titleRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
      title: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        lineHeight: 18,
      },
      ageBadge: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 1,
      },
      age: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      metaRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      statusChip: {
        backgroundColor: theme.colors.surface2,
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      statusText: { color: accent, fontSize: 10.5, fontWeight: "600" as const },
      meta: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 11.5 },
      parkButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 7,
        paddingHorizontal: 8,
        paddingVertical: 5,
      },
      parkLabel: { color: theme.colors.foregroundMuted, fontSize: 11.5 },
      openButton: {
        alignItems: "center" as const,
        justifyContent: "center" as const,
        width: 26,
        height: 26,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 7,
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
  const chip = attentionLabel(column, workspace.indicator);
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

  const body = (
    <>
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {age ? (
          <View style={styles.ageBadge}>
            <Text style={styles.age}>{age}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.metaRow}>
        {chip ? (
          <View style={styles.statusChip}>
            <Text style={styles.statusText}>{chip}</Text>
          </View>
        ) : null}
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </>
  );

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
        {body}
      </Pressable>
      {onPreview === undefined || navigation === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title} in its project`}
          onPress={openWorkspace}
          style={({ pressed }) => [styles.openButton, pressed && styles.pressed]}
        >
          <Icon name="ExternalLink" size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
      )}
      {canPark ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${isParked ? "Unpark" : "Park"} ${title}`}
          onPress={togglePark}
          style={({ pressed }) => [styles.parkButton, pressed && styles.pressed]}
        >
          <Icon name={isParked ? "ArchiveRestore" : "Archive"} size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.parkLabel}>{isParked ? "Unpark" : "Park"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});
