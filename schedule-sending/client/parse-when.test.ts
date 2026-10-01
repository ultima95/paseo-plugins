import { describe, expect, it } from "vitest";
import { parseWhen } from "./parse-when";

/** Local wall-clock time on 30 Sep 2026 plus dayOffset days. Tests never depend on the machine's timezone. */
const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 8, 30 + dayOffset, hour, minute, 0, 0).getTime();

const NOW = at(22, 0);

function fireOf(input: string, now = NOW): number {
  const result = parseWhen(input, now);
  if (!result.ok) throw new Error(`expected ok for "${input}", got error: ${result.error}`);
  return result.fireAt;
}

function errorOf(input: string, now = NOW): string {
  const result = parseWhen(input, now);
  if (result.ok) throw new Error(`expected error for "${input}", got ${new Date(result.fireAt).toString()}`);
  return result.error;
}

describe("relative durations", () => {
  it("parses 'in 5h'", () => expect(fireOf("in 5h")).toBe(NOW + 5 * 3_600_000));
  it("parses '+5h'", () => expect(fireOf("+5h")).toBe(NOW + 5 * 3_600_000));
  it("parses 'in 90m'", () => expect(fireOf("in 90m")).toBe(NOW + 90 * 60_000));
  it("parses 'in 1h30m'", () => expect(fireOf("in 1h30m")).toBe(NOW + 90 * 60_000));
  it("ignores case and inner spaces", () => expect(fireOf("  IN 1h 30M ")).toBe(NOW + 90 * 60_000));
  it("accepts long unit names", () => expect(fireOf("in 2 hours")).toBe(NOW + 2 * 3_600_000));
  it("rejects a zero duration as too soon", () => expect(errorOf("in 0m")).toMatch(/at least 1 minute/));
  it("rejects more than 30 days", () => expect(errorOf("in 800h")).toMatch(/30 days/));
  it("rejects a bare 'in'", () => expect(errorOf("in")).toMatch(/Can't parse/));
  it("rejects a duration without a unit", () => expect(errorOf("in 5")).toMatch(/Can't parse/));
});

describe("clock times", () => {
  it("rolls 3am to tomorrow when it is 22:00", () => expect(fireOf("3am")).toBe(at(3, 0, 1)));
  it("keeps 3am today when it is 01:00", () => expect(fireOf("3am", at(1, 0))).toBe(at(3, 0)));
  it("parses 3:30pm", () => expect(fireOf("3:30pm")).toBe(at(15, 30, 1)));
  it("parses 24-hour 15:30", () => expect(fireOf("15:30")).toBe(at(15, 30, 1)));
  it("keeps a later time today", () => expect(fireOf("23:30")).toBe(at(23, 30)));
  it("accepts a space before am/pm and uppercase", () => expect(fireOf("3:00 PM")).toBe(at(15, 0, 1)));
  it("trims surrounding whitespace", () => expect(fireOf("  3am  ")).toBe(at(3, 0, 1)));
  it("treats the current minute as tomorrow", () => expect(fireOf("22:00")).toBe(at(22, 0, 1)));
  it("treats a time under one minute ahead as tomorrow", () =>
    expect(fireOf("22:00", at(21, 59) + 30_000)).toBe(at(22, 0, 1)));
  it("treats a time exactly one minute ahead as today", () =>
    expect(fireOf("22:00", at(21, 59))).toBe(at(22, 0)));
});

describe("12-hour boundaries", () => {
  it("12am is midnight", () => expect(fireOf("12am")).toBe(at(0, 0, 1)));
  it("12:30am is half past midnight", () => expect(fireOf("12:30am")).toBe(at(0, 30, 1)));
  it("12pm is noon (tomorrow at 22:00)", () => expect(fireOf("12pm")).toBe(at(12, 0, 1)));
  it("12pm is noon today when it is 01:00", () => expect(fireOf("12pm", at(1, 0))).toBe(at(12, 0)));
  it("00:00 is midnight", () => expect(fireOf("00:00")).toBe(at(0, 0, 1)));
});

describe("rejections", () => {
  it.each(["24:00", "3:60", "13pm", "0am", "3", "15", "tomorrow", "banana", "3::00", "1:2am"])(
    "rejects %s with a hint",
    (input) => expect(errorOf(input)).toMatch(/Can't parse .*Try 3am, 15:30 or in 5h/),
  );
  it("rejects empty input", () => expect(errorOf("")).toMatch(/Enter a time/));
  it("rejects whitespace-only input", () => expect(errorOf("   ")).toMatch(/Enter a time/));
});
