/** The narrowest the preview may be dragged: enough for a reply bubble and its label. */
export const PANEL_MIN_WIDTH = 320;

/** The preview's starting width beside the board; a drag can change it. */
export const PANEL_DEFAULT_WIDTH = 520;

/**
 * The widest the preview may be in this window: the board keeps `boardMin` so it stays usable,
 * but never so little that the panel falls below its own minimum.
 */
export function panelMaxWidth(windowWidth: number, boardMin: number): number {
  return Math.max(PANEL_MIN_WIDTH, windowWidth - boardMin);
}

/**
 * A width the preview may take, clamped to this window. A drag can leave one too wide after the
 * window shrinks, so the panel never trusts the stored value on its own.
 */
export function clampPanelWidth(width: number, windowWidth: number, boardMin: number): number {
  return Math.min(
    Math.max(Math.round(width), PANEL_MIN_WIDTH),
    panelMaxWidth(windowWidth, boardMin),
  );
}

/**
 * The preview's width partway through a drag. The grip sits on the preview's left edge, so moving
 * left (a negative distance) widens it. The result is clamped here, so the grip and the panel
 * cannot disagree about the floor and ceiling.
 */
export function draggedPanelWidth(
  startWidth: number,
  dx: number,
  maxWidth: number,
): number {
  const next = startWidth - dx;
  return Math.min(Math.max(Math.round(next), PANEL_MIN_WIDTH), Math.max(PANEL_MIN_WIDTH, maxWidth));
}
