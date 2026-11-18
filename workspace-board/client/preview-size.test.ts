import { describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  draggedPanelWidth,
  panelMaxWidth,
} from "./preview-size";

describe("panelMaxWidth", () => {
  it("leaves the board its minimum share of the window", () => {
    expect(panelMaxWidth(1400, 420)).toBe(980);
    expect(panelMaxWidth(1000, 420)).toBe(580);
  });

  it("never drops below the panel's own minimum, even in a tiny window", () => {
    expect(panelMaxWidth(500, 420)).toBe(PANEL_MIN_WIDTH);
    expect(panelMaxWidth(0, 420)).toBe(PANEL_MIN_WIDTH);
  });
});

describe("clampPanelWidth", () => {
  it("keeps a width inside the window's range", () => {
    expect(clampPanelWidth(600, 1400, 420)).toBe(600);
  });

  it("raises a width below the panel minimum", () => {
    expect(clampPanelWidth(120, 1400, 420)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(-50, 1400, 420)).toBe(PANEL_MIN_WIDTH);
  });

  it("lowers a width left too wide after the window shrank", () => {
    expect(clampPanelWidth(900, 1000, 420)).toBe(580);
  });

  it("rounds a fractional width from a drag", () => {
    expect(clampPanelWidth(512.7, 1400, 420)).toBe(513);
  });

  it("accepts the default width in a normal window", () => {
    expect(clampPanelWidth(PANEL_DEFAULT_WIDTH, 1440, 420)).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe("draggedPanelWidth", () => {
  it("widens the preview when the grip moves left", () => {
    expect(draggedPanelWidth(520, -60, 980)).toBe(580);
  });

  it("narrows the preview when the grip moves right", () => {
    expect(draggedPanelWidth(520, 60, 980)).toBe(460);
  });

  it("keeps the width when the grip has not moved", () => {
    expect(draggedPanelWidth(520, 0, 980)).toBe(520);
  });

  it("floors a drag past the minimum", () => {
    expect(draggedPanelWidth(400, 900, 980)).toBe(PANEL_MIN_WIDTH);
  });

  it("caps a drag past the maximum", () => {
    expect(draggedPanelWidth(520, -900, 980)).toBe(980);
  });

  it("rounds a fractional drag distance", () => {
    expect(draggedPanelWidth(520, -40.6, 980)).toBe(561);
  });

  it("never returns less than the minimum even when the ceiling is below it", () => {
    expect(draggedPanelWidth(520, 0, 200)).toBe(PANEL_MIN_WIDTH);
  });
});
