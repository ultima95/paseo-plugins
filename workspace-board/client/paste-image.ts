/**
 * Pasting a screenshot into the reply box.
 *
 * A plugin cannot read the clipboard directly: Paseo gives plugins no clipboard-read API and
 * the composer it owns is not this one. What it does give is `send(text, { images })`, which
 * takes base64 bytes. So the browser's own paste event, caught on the reply box, is the only
 * source of them, which is why this module is plain DOM shapes and a guard in the panel: on
 * native a `TextInput` has no `addEventListener`, so none of it runs.
 */

/** The raster types Paseo's own composer takes from the clipboard, so the two agree. */
const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The image type a clipboard entry carries, or null when it is not one this preview sends. */
export function imageMimeType(type: string | undefined): string | null {
  const normalized = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return IMAGE_TYPES.includes(normalized) ? normalized : null;
}

/** One image read off the clipboard, ready to send with the reply. */
export interface PastedImage {
  readonly name: string;
  readonly mimeType: string;
  /** Base64 bytes, without the data URL prefix. */
  readonly data: string;
  /** A data URL for the thumbnail, so the panel does not encode the bytes twice. */
  readonly preview: string;
}

/** The parts of a clipboard `File` this module reads. */
export interface ClipboardFile {
  readonly name?: string;
  readonly type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The parts of one clipboard entry this module reads. */
export interface ClipboardItem {
  readonly kind: string;
  readonly type?: string;
  getAsFile?(): ClipboardFile | null;
}

/** The parts of a clipboard payload this module reads. */
export interface ClipboardPayload {
  readonly items?: ArrayLike<ClipboardItem> | null;
}

/** The parts of a paste event this module reads. */
export interface PasteEvent {
  readonly clipboardData?: ClipboardPayload | null;
  preventDefault(): void;
}

/** The parts of a text input node this module reads; only a DOM node has them. */
export interface PasteTarget {
  addEventListener(type: "paste", listener: (event: PasteEvent) => void): void;
  removeEventListener(type: "paste", listener: (event: PasteEvent) => void): void;
}

/** Every image file on a clipboard payload, in the order the clipboard lists them. */
export function clipboardImages(payload: ClipboardPayload | null | undefined): readonly ClipboardFile[] {
  const items = payload?.items;
  if (items === undefined || items === null) return [];
  const files: ClipboardFile[] = [];
  for (const item of Array.from(items)) {
    if (item?.kind !== "file") continue;
    const file = item.getAsFile?.() ?? null;
    if (file === null) continue;
    if (imageMimeType(file.type ?? item.type) === null) continue;
    files.push(file);
  }
  return files;
}

/** Standard base64 over bytes, kept here so this module needs no browser globals. */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += alphabet[first >> 2];
    out += alphabet[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    out += second === undefined ? "=" : alphabet[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    out += third === undefined ? "=" : alphabet[third & 0b111111];
  }
  return out;
}

/** The image a clipboard file stands for, with its bytes read for sending. */
export async function pastedImage(file: ClipboardFile): Promise<PastedImage | null> {
  const mimeType = imageMimeType(file.type);
  if (mimeType === null) return null;
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  return {
    name: file.name === undefined || file.name === "" ? "Pasted image" : file.name,
    mimeType,
    data,
    preview: `data:${mimeType};base64,${data}`,
  };
}

/**
 * Catches image pastes on one input. A paste with no image is left alone, so typed text still
 * pastes the ordinary way; a paste with images is taken over and the images are handed back.
 */
export function listenForPastedImages(
  target: PasteTarget,
  onImages: (images: readonly PastedImage[]) => void,
): () => void {
  let disposed = false;
  const listener = (event: PasteEvent) => {
    const files = clipboardImages(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map(pastedImage))
      .then((images) => {
        if (disposed) return;
        const ready = images.filter((image): image is PastedImage => image !== null);
        if (ready.length > 0) onImages(ready);
      })
      .catch(() => undefined);
  };
  target.addEventListener("paste", listener);
  return () => {
    disposed = true;
    target.removeEventListener("paste", listener);
  };
}
