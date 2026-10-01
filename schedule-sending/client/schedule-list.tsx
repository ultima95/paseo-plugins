import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { ScheduledMessage } from "../shared/model";
import type { Layout, Theme } from "./types";
import { describeItem, type ItemRow, type RowTone } from "./view-model";

interface Props {
  theme: Theme;
  layout: Layout;
  items: readonly ScheduledMessage[];
  now: number;
  cancelingId: string | null;
  onCancel: (id: string) => void;
}

export function ScheduleList({ theme, layout, items, now, cancelingId, onCancel }: Props) {
  const rows = useMemo(() => items.map((item) => describeItem(item, now)), [items, now]);
  const pending = rows.filter((row) => row.cancellable);
  const recent = rows.filter((row) => !row.cancellable);

  const toneColor: Record<RowTone, string> = {
    muted: theme.colors.foregroundMuted,
    success: theme.colors.statusSuccess,
    warning: theme.colors.statusWarning,
    danger: theme.colors.statusDanger,
  };

  const styles = useMemo(
    () => ({
      list: { gap: layout.compact ? 12 : 16 },
      heading: { color: theme.colors.foregroundMuted, fontSize: 12, textTransform: "uppercase" as const },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      rowText: { flex: 1, gap: 2 },
      preview: { color: theme.colors.foreground },
      cancel: { color: theme.colors.statusDanger },
      empty: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );

  const renderRow = (row: ItemRow) => (
    <View key={row.id} style={styles.row}>
      <View style={styles.rowText}>
        <Text numberOfLines={2} style={styles.preview}>
          {row.preview}
        </Text>
        <Text style={{ color: toneColor[row.tone] }}>{row.detail}</Text>
      </View>
      {row.cancellable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel scheduled message"
          disabled={cancelingId === row.id}
          onPress={() => onCancel(row.id)}
        >
          <Text style={styles.cancel}>{cancelingId === row.id ? "Canceling…" : "Cancel"}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (rows.length === 0) return <Text style={styles.empty}>Nothing scheduled for this chat.</Text>;

  return (
    <View style={styles.list}>
      {pending.length > 0 ? (
        <View>
          <Text style={styles.heading}>Pending</Text>
          {pending.map(renderRow)}
        </View>
      ) : null}
      {recent.length > 0 ? (
        <View>
          <Text style={styles.heading}>Recent (7 days)</Text>
          {recent.map(renderRow)}
        </View>
      ) : null}
    </View>
  );
}
