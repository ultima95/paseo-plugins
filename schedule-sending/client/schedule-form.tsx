import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { parseWhen } from "./parse-when";
import type { Layout, Theme } from "./types";
import { canSchedule, previewLine } from "./view-model";

const CHIPS = ["+1h", "+5h", "8am"] as const;

interface Props {
  theme: Theme;
  layout: Layout;
  now: number;
  busy: boolean;
  error: string | null;
  onSubmit: (text: string, fireAt: number) => Promise<unknown>;
}

export function ScheduleForm({ theme, layout, now, busy, error, onSubmit }: Props) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const parsed = useMemo(() => parseWhen(when, now), [when, now]);
  const line = previewLine(when, parsed, now);
  const enabled = !busy && canSchedule(text, parsed);

  const styles = useMemo(
    () => ({
      form: { gap: layout.compact ? 8 : 10 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      },
      message: { minHeight: 72, textAlignVertical: "top" as const },
      chips: { flexDirection: "row" as const, gap: 8 },
      chip: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      button: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
        opacity: enabled ? 1 : 0.5,
      },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, layout.compact, enabled],
  );

  const submit = useCallback(async () => {
    if (!parsed.ok) return;
    try {
      await onSubmit(text.trim(), parsed.fireAt);
      setText("");
      setWhen("");
    } catch {
      // The container renders the failure; keep the draft so the user can retry.
    }
  }, [onSubmit, parsed, text]);

  return (
    <View style={styles.form}>
      <TextInput
        multiline
        value={text}
        onChangeText={setText}
        placeholder="Message to send"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Message to send"
        style={[styles.input, styles.message]}
      />
      <TextInput
        value={when}
        onChangeText={setWhen}
        placeholder="When: 3am, 15:30, in 5h"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="When to send"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <View style={styles.chips}>
        {CHIPS.map((chip) => (
          <Pressable
            key={chip}
            accessibilityRole="button"
            accessibilityLabel={`Set time to ${chip}`}
            onPress={() => setWhen(chip)}
            style={styles.chip}
          >
            <Text style={styles.chipText}>{chip}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={line.isError ? styles.error : styles.muted}>{line.text}</Text>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Schedule message"
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={() => void submit()}
        style={styles.button}
      >
        <Text style={styles.buttonText}>{busy ? "Scheduling…" : "Schedule"}</Text>
      </Pressable>
    </View>
  );
}
