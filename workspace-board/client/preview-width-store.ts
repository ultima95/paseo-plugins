import { useSyncExternalStore } from "react";
import { PANEL_DEFAULT_WIDTH } from "./preview-size";

/**
 * The preview width a person last dragged to. It lives outside React because the board screen
 * unmounts whenever another screen opens, and a `useState` there would forget the width every
 * time. The value lasts as long as the app's plugin bundle does; it is not written to disk.
 */
let remembered: number | null = null;
const listeners = new Set<() => void>();

/** Tells `listener` when the remembered width changes; returns the unsubscribe function. */
export function subscribePreviewWidth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The width to start from: the last one dragged in this session, or the default. */
export function readPreviewWidth(): number {
  return remembered ?? PANEL_DEFAULT_WIDTH;
}

/** Remembers a dragged width, and tells every mounted board to use it. */
export function rememberPreviewWidth(width: number): void {
  if (width === remembered) return;
  remembered = width;
  for (const listener of listeners) listener();
}

/** The remembered width, live, with the setter a drag reports to. */
export function usePreviewWidth(): [number, (width: number) => void] {
  return [
    useSyncExternalStore(subscribePreviewWidth, readPreviewWidth, readPreviewWidth),
    rememberPreviewWidth,
  ];
}

/** Forgets the remembered width. Tests use it to keep one case from leaking into the next. */
export function forgetPreviewWidth(): void {
  remembered = null;
  for (const listener of listeners) listener();
}
