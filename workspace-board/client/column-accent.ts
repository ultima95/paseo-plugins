import type { PluginTheme } from "@getpaseo/plugin";
import type { ColumnId } from "./board-model";

type Rgb = readonly [number, number, number];

function parseColor(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(value.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** Light or dark, read from the page surface; an unreadable color counts as light. */
export function isDarkTheme(colors: Pick<PluginTheme["colors"], "surface0">): boolean {
  const rgb = parseColor(colors.surface0);
  if (rgb === null) return false;
  const luma = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luma < 0.5;
}

/**
 * The board's own column colors. The theme's status and muted tokens render too dark for a dot
 * on the page, so every column gets a brighter hue, one shade per theme to stay readable.
 * The first three follow the sidebar's dots: needs you red, running blue, finished green.
 */
const SIGNAL: Record<ColumnId, { readonly light: string; readonly dark: string }> = {
  "needs-you": { light: "#e5484d", dark: "#ff6b6b" },
  running: { light: "#3b82f6", dark: "#60a5fa" },
  review: { light: "#22a05b", dark: "#4ade80" },
  idle: { light: "#0d9488", dark: "#2dd4bf" },
  parked: { light: "#8b5cf6", dark: "#a78bfa" },
};

/** The one color that marks a column: its header dot, its cards' left edge, the sidebar count. */
export function columnAccent(id: ColumnId, colors: Pick<PluginTheme["colors"], "surface0">): string {
  return SIGNAL[id][isDarkTheme(colors) ? "dark" : "light"];
}

/**
 * The Lucide icon that marks a column, next to its accent. The icon and the color say the
 * same thing, so the board still reads when someone cannot tell the hues apart.
 */
const COLUMN_ICON: Record<ColumnId, string> = {
  "needs-you": "AlertCircle",
  running: "Play",
  review: "Eye",
  idle: "Pause",
  parked: "Archive",
};

export function columnIcon(id: ColumnId): string {
  return COLUMN_ICON[id];
}

/** Blends `overlay` onto `base`; used to tint whole surfaces without alpha compositing surprises. */
export function mixColor(base: string, overlay: string, alpha: number): string {
  const a = parseColor(base);
  const b = parseColor(overlay);
  if (a === null || b === null) return base;
  const blend = (from: number, to: number) => Math.round(from + (to - from) * alpha);
  return `rgb(${blend(a[0], b[0])}, ${blend(a[1], b[1])}, ${blend(a[2], b[2])})`;
}

/** A translucent version of a color, for chips that sit on a surface the plugin does not own. */
export function colorWithAlpha(value: string, alpha: number): string {
  const rgb = parseColor(value);
  if (rgb === null) return value;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** A card surface in the column's hue: barely there on idle columns, clearer for attention. */
export function columnSurface(
  id: ColumnId,
  colors: Pick<PluginTheme["colors"], "surface0" | "surface1">,
  alpha: number,
): string {
  return mixColor(colors.surface1, columnAccent(id, colors), alpha);
}
