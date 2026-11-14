import type { PluginTheme } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import {
  columnAccent,
  columnIcon,
  columnSurface,
  colorWithAlpha,
  isDarkTheme,
  mixColor,
} from "./column-accent";

const colors = (surface0: string) =>
  ({
    surface0,
    surface1: "#ffffff",
    statusDanger: "#7a1f1f",
    statusWarning: "#6b4a1f",
    statusSuccess: "#1f5f3a",
    accent: "#1f5f3a",
    foregroundMuted: "#888888",
  }) as PluginTheme["colors"];

describe("isDarkTheme", () => {
  it("reads hex and rgb surfaces", () => {
    expect(isDarkTheme({ surface0: "#ffffff" })).toBe(false);
    expect(isDarkTheme({ surface0: "#fff" })).toBe(false);
    expect(isDarkTheme({ surface0: "#111111" })).toBe(true);
    expect(isDarkTheme({ surface0: "#000" })).toBe(true);
    expect(isDarkTheme({ surface0: "rgb(20, 20, 24)" })).toBe(true);
    expect(isDarkTheme({ surface0: "rgba(250, 250, 250, 1)" })).toBe(false);
  });

  it("treats an unreadable surface as light", () => {
    expect(isDarkTheme({ surface0: "papayawhip" })).toBe(false);
  });
});

describe("columnAccent", () => {
  it("does not use the theme's dark status colors for the attention columns", () => {
    for (const surface of ["#ffffff", "#101010"]) {
      const c = colors(surface);
      expect(columnAccent("needs-you", c)).not.toBe(c.statusDanger);
      expect(columnAccent("review", c)).not.toBe(c.statusSuccess);
      expect(columnAccent("running", c)).not.toBe(c.accent);
    }
  });

  it("gives all five columns different colors in each theme", () => {
    for (const surface of ["#ffffff", "#101010"]) {
      const c = colors(surface);
      const set = new Set(
        (["needs-you", "running", "review", "idle", "parked"] as const).map((id) =>
          columnAccent(id, c),
        ),
      );
      expect(set.size).toBe(5);
    }
  });

  it("uses a different shade per theme so each stays readable", () => {
    expect(columnAccent("needs-you", colors("#ffffff"))).not.toBe(
      columnAccent("needs-you", colors("#101010")),
    );
  });

  it("does not leave idle or parked in the theme's muted grey", () => {
    for (const surface of ["#ffffff", "#101010"]) {
      const c = colors(surface);
      expect(columnAccent("idle", c)).not.toBe(c.foregroundMuted);
      expect(columnAccent("parked", c)).not.toBe(c.foregroundMuted);
    }
  });
});

describe("mixColor", () => {
  it("blends hex and rgb inputs channel by channel", () => {
    expect(mixColor("#ffffff", "#ff0000", 0.5)).toBe("rgb(255, 128, 128)");
    expect(mixColor("rgb(0, 0, 0)", "#ffffff", 0.25)).toBe("rgb(64, 64, 64)");
  });

  it("returns the base untouched when a color cannot be read", () => {
    expect(mixColor("papayawhip", "#ff0000", 0.5)).toBe("papayawhip");
    expect(mixColor("#ffffff", "papayawhip", 0.5)).toBe("#ffffff");
  });

  it("keeps the full alpha blend at the extremes", () => {
    expect(mixColor("#123456", "#abcdef", 0)).toBe("rgb(18, 52, 86)");
    expect(mixColor("#123456", "#abcdef", 1)).toBe("rgb(171, 205, 239)");
  });
});

describe("columnIcon", () => {
  it("gives every column a Lucide icon name", () => {
    const columns = ["needs-you", "running", "review", "idle", "parked"] as const;
    for (const id of columns) expect(columnIcon(id)).toMatch(/^[A-Z][A-Za-z]+$/);
  });

  it("gives each column a different icon", () => {
    const set = new Set(
      (["needs-you", "running", "review", "idle", "parked"] as const).map(columnIcon),
    );
    expect(set.size).toBe(5);
  });
});

describe("colorWithAlpha", () => {
  it("writes hex and rgb colors as rgba", () => {
    expect(colorWithAlpha("#e5484d", 0.14)).toBe("rgba(229, 72, 77, 0.14)");
    expect(colorWithAlpha("rgb(10, 20, 30)", 0.5)).toBe("rgba(10, 20, 30, 0.5)");
  });

  it("returns an unreadable color untouched", () => {
    expect(colorWithAlpha("papayawhip", 0.5)).toBe("papayawhip");
  });
});

describe("columnSurface", () => {
  it("tints the card surface toward the column accent", () => {
    const c = colors("#ffffff");
    const surface = columnSurface("needs-you", c, 0.07);
    expect(surface).not.toBe(c.surface1);
    expect(surface).not.toBe(columnAccent("needs-you", c));
  });

  it("gives each column a different tint", () => {
    const c = colors("#ffffff");
    const set = new Set(
      (["needs-you", "running", "review", "idle", "parked"] as const).map((id) =>
        columnSurface(id, c, 0.07),
      ),
    );
    expect(set.size).toBe(5);
  });
});
