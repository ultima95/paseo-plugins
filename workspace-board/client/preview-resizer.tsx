import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, View, type ViewStyle } from "react-native";
import { PANEL_MIN_WIDTH, draggedPanelWidth } from "./preview-size";

/**
 * The grip's grab area. It is deliberately wider than the 1px rule it draws: a hairline is a
 * hard target, and the divider reads the same however much empty padding surrounds it.
 */
const GRIP_WIDTH = 13;

/**
 * RN types `cursor` as `auto | pointer` and keeps `userSelect` to `Text`, while react-native-web
 * hands both to CSS. These are web-only niceties: the resize cursor tells the pointer what the
 * divider does, and `userSelect: none` stops a drag that crosses the chat from selecting text.
 * The cast keeps them off the native platforms without pulling in DOM types.
 */
const GRIP_STYLE = {
  userSelect: "none",
  cursor: "col-resize",
} as unknown as ViewStyle;

interface PreviewResizerProps {
  theme: PluginTheme;
  width: number;
  /** The widest this window allows, already accounting for the board's share. */
  maxWidth: number;
  onChange(width: number): void;
}

/**
 * The grip between the board and the preview. Dragging left widens the preview; the panel
 * owns the width, so a drag reports the new value and never stores one itself.
 */
export function PreviewResizer({ theme, width, maxWidth, onChange }: PreviewResizerProps) {
  // The pan callbacks are created once, so they read the live width and handler through refs.
  const live = useRef({ width, maxWidth, onChange });
  live.current = { width, maxWidth, onChange };
  const start = useRef(0);
  // A drag reports faster than the board can re-lay out its cards, so a move only records the
  // wanted width and one frame applies the latest. Without this the divider lags behind the pointer.
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const flush = () => {
    frame.current = null;
    if (pending.current === null) return;
    live.current.onChange(pending.current);
    pending.current = null;
  };

  // Closing the preview mid-drag unmounts this grip; a frame that outlives it must not fire.
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim the touch as soon as it lands on the grip, and once a pointer has moved 2px, so a
        // stray click on the divider does nothing but a deliberate drag answers immediately.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2,
        onPanResponderGrant: () => {
          start.current = live.current.width;
          setDragging(true);
        },
        onPanResponderMove: (_event, gesture) => {
          pending.current = draggedPanelWidth(start.current, gesture.dx, live.current.maxWidth);
          if (frame.current === null) frame.current = requestAnimationFrame(flush);
        },
        onPanResponderRelease: () => {
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          flush();
          setDragging(false);
        },
        onPanResponderTerminate: () => {
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          flush();
          setDragging(false);
        },
      }),
    [],
  );

  return (
    <View
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Resize the preview"
      accessibilityValue={{ min: PANEL_MIN_WIDTH, max: maxWidth, now: width }}
      style={[
        {
          width: GRIP_WIDTH,
          alignSelf: "stretch",
          alignItems: "center" as const,
          justifyContent: "center" as const,
          backgroundColor: theme.colors.surface0,
        },
        GRIP_STYLE,
      ]}
    >
      <View
        style={{
          width: dragging ? 3 : 1,
          flex: 1,
          borderRadius: 2,
          backgroundColor: dragging ? theme.colors.accent : theme.colors.border,
        }}
      />
    </View>
  );
}
