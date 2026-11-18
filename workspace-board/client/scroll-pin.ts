/** How close to the end still counts as reading the latest message. */
export const BOTTOM_THRESHOLD = 48;

/**
 * Whether the reader is following the end of the chat. A streaming reply grows the content under
 * the scroll position, so only a reader who was already at the end should be carried along; one
 * who scrolled up to read is left where they are.
 */
export function isNearBottom(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
  threshold = BOTTOM_THRESHOLD,
): boolean {
  if (contentHeight <= viewportHeight) return true;
  return contentHeight - (offsetY + viewportHeight) <= threshold;
}
