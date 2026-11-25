import { describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  clipboardImages,
  imageMimeType,
  listenForPastedImages,
  pastedImage,
  type ClipboardFile,
  type PasteEvent,
  type PasteTarget,
} from "./paste-image";

describe("imageMimeType", () => {
  it("accepts the raster types the composer sends", () => {
    expect(imageMimeType("image/png")).toBe("image/png");
    expect(imageMimeType("image/jpeg")).toBe("image/jpeg");
    expect(imageMimeType("IMAGE/WEBP")).toBe("image/webp");
  });

  it("drops parameters and surrounding space", () => {
    expect(imageMimeType(" image/png; codecs=x ")).toBe("image/png");
  });

  it("rejects everything else", () => {
    expect(imageMimeType("image/svg+xml")).toBeNull();
    expect(imageMimeType("text/plain")).toBeNull();
    expect(imageMimeType("")).toBeNull();
    expect(imageMimeType(undefined)).toBeNull();
  });
});

function file(name: string, type: string, bytes: number[]): ClipboardFile {
  return {
    name,
    type,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

describe("clipboardImages", () => {
  it("keeps only file entries that are images", () => {
    const png = file("shot.png", "image/png", [1, 2, 3]);
    expect(
      clipboardImages({
        items: [
          { kind: "string", type: "text/plain" },
          { kind: "file", type: "image/png", getAsFile: () => png },
          { kind: "file", type: "text/plain", getAsFile: () => file("a.txt", "text/plain", [1]) },
          { kind: "file", type: "image/png", getAsFile: () => null },
        ],
      }),
    ).toEqual([png]);
  });

  it("says nothing for a payload with no items", () => {
    expect(clipboardImages(null)).toEqual([]);
    expect(clipboardImages({})).toEqual([]);
  });

  it("reads the entry type when the file carries none", () => {
    const png: ClipboardFile = { arrayBuffer: async () => new ArrayBuffer(1) };
    expect(
      clipboardImages({ items: [{ kind: "file", type: "image/png", getAsFile: () => png }] }),
    ).toEqual([png]);
  });
});

describe("bytesToBase64", () => {
  it("encodes with padding", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
    expect(bytesToBase64(new Uint8Array([102]))).toBe("Zg==");
    expect(bytesToBase64(new Uint8Array([102, 111]))).toBe("Zm8=");
    expect(bytesToBase64(new Uint8Array([102, 111, 111]))).toBe("Zm9v");
  });

  it("encodes across the padding boundary", () => {
    expect(bytesToBase64(new Uint8Array([102, 111, 111, 98]))).toBe("Zm9vYg==");
    expect(bytesToBase64(new Uint8Array([102, 111, 111, 98, 97]))).toBe("Zm9vYmE=");
    expect(bytesToBase64(new Uint8Array([102, 111, 111, 98, 97, 114]))).toBe("Zm9vYmFy");
  });

  it("encodes every byte value", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    const encoded = bytesToBase64(bytes);
    // 256 bytes is 85 whole groups of 3 plus one leftover byte, so the tail carries two pads.
    expect(encoded).toHaveLength(344);
    expect(encoded.startsWith("AAECAwQFBgcICQ")).toBe(true);
    expect(encoded.endsWith("////")).toBe(false);
    expect(encoded.split("").every((char) => /[A-Za-z0-9+/=]/.test(char))).toBe(true);
  });
});

describe("pastedImage", () => {
  it("reads the bytes into a sendable image and a thumbnail", async () => {
    await expect(pastedImage(file("shot.png", "image/png", [102, 111, 111]))).resolves.toEqual({
      name: "shot.png",
      mimeType: "image/png",
      data: "Zm9v",
      preview: "data:image/png;base64,Zm9v",
    });
  });

  it("names a clipboard image the browser gave no name", async () => {
    const unnamed: ClipboardFile = {
      type: "image/png",
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    };
    await expect(pastedImage(unnamed)).resolves.toMatchObject({ name: "Pasted image" });
  });

  it("returns nothing for a file that is not an image", async () => {
    await expect(pastedImage(file("a.txt", "text/plain", [1]))).resolves.toBeNull();
  });
});

describe("listenForPastedImages", () => {
  function target() {
    let listener: ((event: PasteEvent) => void) | null = null;
    const node: PasteTarget = {
      addEventListener: (_type, next) => {
        listener = next;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    return {
      node,
      fire(event: PasteEvent) {
        listener?.(event);
      },
    };
  }

  it("hands over pasted images and takes the paste", async () => {
    const { node, fire } = target();
    const seen: string[] = [];
    listenForPastedImages(node, (images) => {
      for (const image of images) seen.push(image.mimeType);
    });
    const preventDefault = vi.fn();
    fire({
      preventDefault,
      clipboardData: {
        items: [
          { kind: "file", type: "image/png", getAsFile: () => file("a.png", "image/png", [1]) },
        ],
      },
    });
    await vi.waitFor(() => expect(seen).toEqual(["image/png"]));
    expect(preventDefault).toHaveBeenCalled();
  });

  it("leaves a text paste to the input", () => {
    const { node, fire } = target();
    const onImages = vi.fn();
    listenForPastedImages(node, onImages);
    const preventDefault = vi.fn();
    fire({ preventDefault, clipboardData: { items: [{ kind: "string", type: "text/plain" }] } });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onImages).not.toHaveBeenCalled();
  });

  it("stops listening after cleanup", () => {
    const { node, fire } = target();
    const onImages = vi.fn();
    const stop = listenForPastedImages(node, onImages);
    stop();
    fire({
      preventDefault: vi.fn(),
      clipboardData: {
        items: [
          { kind: "file", type: "image/png", getAsFile: () => file("a.png", "image/png", [1]) },
        ],
      },
    });
    expect(onImages).not.toHaveBeenCalled();
  });
});
