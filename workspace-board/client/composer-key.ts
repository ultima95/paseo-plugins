/** The fields a key event carries that decide whether Enter sends a reply. */
export interface ComposerKey {
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/**
 * Enter sends, Shift+Enter keeps a newline, and an IME's Enter confirms its composition. Web
 * key events carry the modifiers; native ones do not, so a plain Enter sends there too.
 */
export function isSendKey(event: ComposerKey): boolean {
  if (event.key !== "Enter" || event.shiftKey === true) return false;
  return event.isComposing !== true && event.keyCode !== 229;
}
