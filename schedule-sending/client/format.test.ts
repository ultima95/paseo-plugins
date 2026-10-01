import { describe, expect, it } from "vitest";
import { formatClock, formatDelta, formatFireTime } from "./format";

const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 8, 30 + dayOffset, hour, minute, 0, 0).getTime();

describe("formatClock", () => {
  it("pads hours and minutes", () => expect(formatClock(at(3, 5))).toBe("03:05"));
  it("uses 24-hour time", () => expect(formatClock(at(15, 30))).toBe("15:30"));
});

describe("formatDelta", () => {
  it("shows under a minute", () => {
    expect(formatDelta(0)).toBe("<1m");
    expect(formatDelta(59_999)).toBe("<1m");
  });
  it("clamps negative values", () => expect(formatDelta(-5_000)).toBe("<1m"));
  it("shows minutes", () => expect(formatDelta(45 * 60_000)).toBe("45m"));
  it("shows whole hours", () => expect(formatDelta(5 * 3_600_000)).toBe("5h"));
  it("shows hours and minutes", () => expect(formatDelta((5 * 60 + 12) * 60_000)).toBe("5h 12m"));
  it("shows days and hours", () => expect(formatDelta(25 * 3_600_000)).toBe("1d 1h"));
});

describe("formatFireTime", () => {
  it("labels the same day Today", () => expect(formatFireTime(at(23, 30), at(22))).toBe("Today 23:30"));
  it("labels the next day Tomorrow", () => expect(formatFireTime(at(3, 0, 1), at(22))).toBe("Tomorrow 03:00"));
  it("labels later days with weekday and date", () =>
    expect(formatFireTime(at(3, 0, 3), at(22))).toBe("Sat 3 Oct 03:00"));
});
