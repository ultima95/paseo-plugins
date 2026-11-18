import { describe, expect, it } from "vitest";
import { BOTTOM_THRESHOLD, isNearBottom } from "./scroll-pin";

describe("isNearBottom", () => {
  it("is true at the exact end", () => {
    expect(isNearBottom(500, 1000, 500)).toBe(true);
  });

  it("is true within the threshold, so a snapped end still follows", () => {
    expect(isNearBottom(500 - BOTTOM_THRESHOLD, 1000, 500)).toBe(true);
    expect(isNearBottom(490, 1000, 500)).toBe(true);
  });

  it("is false once the reader is scrolled above the threshold", () => {
    expect(isNearBottom(500 - BOTTOM_THRESHOLD - 1, 1000, 500)).toBe(false);
    expect(isNearBottom(0, 1000, 500)).toBe(false);
  });

  it("treats content that fits the viewport as following the end", () => {
    expect(isNearBottom(0, 400, 500)).toBe(true);
    expect(isNearBottom(0, 500, 500)).toBe(true);
  });

  it("tolerates overscroll past the end", () => {
    expect(isNearBottom(600, 1000, 500)).toBe(true);
  });

  it("honours a caller's own threshold", () => {
    expect(isNearBottom(400, 1000, 500, 200)).toBe(true);
    expect(isNearBottom(400, 1000, 500, 50)).toBe(false);
  });
});
