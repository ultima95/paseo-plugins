import { describe, expect, it } from "vitest";
import { isSendKey } from "./composer-key";

describe("isSendKey", () => {
  it("sends on a plain Enter", () => {
    expect(isSendKey({ key: "Enter" })).toBe(true);
  });

  it("keeps the newline on Shift+Enter", () => {
    expect(isSendKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("leaves an IME's Enter to confirm the composition", () => {
    expect(isSendKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(isSendKey({ key: "Enter", keyCode: 229 })).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isSendKey({ key: "a" })).toBe(false);
    expect(isSendKey({ key: "Tab" })).toBe(false);
    expect(isSendKey({})).toBe(false);
  });
});
