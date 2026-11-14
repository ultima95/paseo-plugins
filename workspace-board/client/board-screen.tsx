import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { COLUMNS, groupBoard, isChildWorkspace, matchesFilter, type ColumnId } from "./board-model";
import { BoardSection } from "./board-section";
import { columnAccent, columnIcon } from "./column-accent";
import { useBoardWorkspaces } from "./use-board-workspaces";

const AGE_TICK_MS = 30_000;
const GRID_GAP = 10;

/** A local clock so "5m" on a card keeps counting while the board sits open. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Even card width for the measured content area, so rows line up across sections. */
function gridCardWidth(width: number, compact: boolean): number | undefined {
  if (width <= 0) return undefined;
  const columns = compact || width < 640 ? 1 : width < 980 ? 2 : width < 1380 ? 3 : 4;
  return Math.floor((width - GRID_GAP * (columns - 1)) / columns);
}

export function BoardScreen({ theme, layout, host, navigation }: PluginScreenProps) {
  const board = useBoardWorkspaces();
  const now = useNow(AGE_TICK_MS);
  const { width: windowWidth } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [contentWidth, setContentWidth] = useState(0);

  const pad = layout.compact ? 16 : 24;
  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: pad, paddingBottom: 48 },
      stack: { gap: 18 },
      hero: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 16,
        gap: 10,
      },
      heroLead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      summaryDot: { width: 10, height: 10, borderRadius: 5 },
      headline: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" as const },
      chips: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 9,
        paddingVertical: 3,
      },
      chipCount: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      chipLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      search: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        backgroundColor: theme.colors.surface1,
        borderColor: focused ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        flexGrow: 1,
        minWidth: 220,
        maxWidth: layout.compact ? undefined : 420,
      },
      filter: {
        flex: 1,
        color: theme.colors.foreground,
        paddingVertical: 9,
        fontSize: 14,
      },
      clear: { padding: 4 },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        flexWrap: "wrap" as const,
      },
      toggle: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
      },
      toggleText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      message: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      placeholder: {
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 56,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderStyle: "dashed" as const,
        borderRadius: 12,
      },
      placeholderTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      placeholderHint: { color: theme.colors.foregroundMuted, fontSize: 13 },
      center: { alignItems: "center" as const, paddingVertical: 48, gap: 10 },
      pressed: { opacity: 0.6 },
    }),
    [theme, layout.compact, pad, focused],
  );

  const workspaces = board.status === "ready" ? board.workspaces : null;
  const children = useMemo(
    () => (workspaces ?? []).filter((workspace) => isChildWorkspace(workspace)),
    [workspaces],
  );
  const visible = useMemo(
    () => (workspaces === null ? null : workspaces.filter((workspace) => !isChildWorkspace(workspace))),
    [workspaces],
  );
  const all = useMemo(() => (visible ? groupBoard(visible) : null), [visible]);
  const shown = useMemo(
    () => (visible ? groupBoard(visible.filter((w) => matchesFilter(w, query))) : null),
    [visible, query],
  );

  if (board.status === "loading" || board.status === "error" || all === null || shown === null) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {board.status === "error" ? (
          <Text style={styles.error}>Could not load workspaces: {board.message}</Text>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={styles.message}>Loading workspaces</Text>
          </View>
        )}
      </ScrollView>
    );
  }

  const total = COLUMNS.reduce((sum, column) => sum + all[column.id].length, 0);
  if (total === 0) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.placeholder}>
          <Icon name="LayoutGrid" size={28} color={theme.colors.foregroundMuted} />
          <Text style={styles.placeholderTitle}>
            {children.length > 0 ? "Only child workspaces are open" : "No open workspaces"}
          </Text>
          <Text style={styles.placeholderHint}>
            {children.length > 0
              ? `${children.length} ${children.length === 1 ? "child workspace is" : "child workspaces are"} not shown on the board.`
              : "Workspaces you open will show up here."}
          </Text>
        </View>
      </ScrollView>
    );
  }

  const attention = all["needs-you"].length + all.review.length;
  const lead: ColumnId = all["needs-you"].length > 0 ? "needs-you" : "review";
  const headline =
    attention === 0
      ? "All clear"
      : `${attention} ${attention === 1 ? "workspace needs" : "workspaces need"} you`;
  const dotColor =
    attention === 0 ? theme.colors.statusSuccess : columnAccent(lead, theme.colors);
  const chips: { id: ColumnId; label: string; count: number }[] = [
    { id: "needs-you", label: "blocked", count: all["needs-you"].length },
    { id: "review", label: "to review", count: all.review.length },
    { id: "running", label: "running", count: all.running.length },
    { id: "idle", label: "idle", count: all.idle.length },
    { id: "parked", label: "parked", count: all.parked.length },
  ];

  const filtering = query.trim() !== "";
  const matches = COLUMNS.reduce((sum, column) => sum + shown[column.id].length, 0);
  const cardWidth = gridCardWidth(
    contentWidth > 0 ? contentWidth : Math.max(0, windowWidth - pad * 2),
    layout.compact,
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={styles.stack}
        onLayout={(event) => setContentWidth(Math.round(event.nativeEvent.layout.width))}
      >
        <View style={styles.hero}>
          <View style={styles.heroLead}>
            <View style={[styles.summaryDot, { backgroundColor: dotColor }]} />
            <Text style={styles.headline}>{headline}</Text>
          </View>
          <View style={styles.chips}>
            {chips
              .filter((chip) => chip.count > 0 || chip.id === "idle")
              .map((chip) => (
                <View key={chip.id} style={styles.chip}>
                  <Icon
                    name={columnIcon(chip.id)}
                    size={11}
                    color={columnAccent(chip.id, theme.colors)}
                  />
                  <Text style={styles.chipCount}>{chip.count}</Text>
                  <Text style={styles.chipLabel}>{chip.label}</Text>
                </View>
              ))}
          </View>
        </View>

        <View style={styles.toolbar}>
          <View style={styles.search}>
            <Icon name="Search" size={15} color={theme.colors.foregroundMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Filter by title or project"
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="Filter workspaces"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.filter}
            />
            {query === "" ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear filter"
                onPress={() => setQuery("")}
                style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
              >
                <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
            )}
          </View>
          {children.length === 0 ? null : (
            <View style={styles.toggle}>
              <Icon name="CornerDownRight" size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.toggleText}>
                {children.length} child {children.length === 1 ? "workspace" : "workspaces"} hidden
              </Text>
            </View>
          )}
        </View>

        {filtering && matches === 0 ? (
          <Text style={styles.message}>No workspace matches “{query.trim()}”</Text>
        ) : (
          COLUMNS.map((column) =>
            // While filtering, hide sections with no match instead of listing five empty headers.
            filtering && shown[column.id].length === 0 ? null : (
              <BoardSection
                key={column.id}
                id={column.id}
                title={column.title}
                items={shown[column.id]}
                serverId={host.id}
                theme={theme}
                navigation={navigation}
                now={now}
                cardWidth={cardWidth}
              />
            ),
          )
        )}
      </View>
    </ScrollView>
  );
}
