import { MAX_HORIZON_MS, MIN_LEAD_MS } from "../shared/model";

export type ParseWhenResult = { ok: true; fireAt: number } | { ok: false; error: string };

const HINT = "Try 3am, 15:30 or in 5h";
const RELATIVE = /^(?:in|\+)\s*(?:(\d+)\s*(?:h|hrs?|hours?))?\s*(?:(\d+)\s*(?:m|mins?|minutes?))?$/;
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

function fail(error: string): ParseWhenResult {
  return { ok: false, error };
}

function check(fireAt: number, now: number): ParseWhenResult {
  if (fireAt < now + MIN_LEAD_MS) return fail("Pick a time at least 1 minute ahead");
  if (fireAt > now + MAX_HORIZON_MS) return fail("Too far ahead (max 30 days)");
  return { ok: true, fireAt };
}

function nextClockOccurrence(
  hourInput: number,
  minuteInput: number | undefined,
  meridiem: string | undefined,
  now: number,
): number | undefined {
  const minute = minuteInput ?? 0;
  if (minute > 59) return undefined;

  let hour: number;
  if (meridiem === undefined) {
    // A bare "3" is ambiguous; 24-hour times must include minutes.
    if (minuteInput === undefined || hourInput > 23) return undefined;
    hour = hourInput;
  } else {
    if (hourInput < 1 || hourInput > 12) return undefined;
    hour = (hourInput % 12) + (meridiem === "pm" ? 12 : 0);
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < now + MIN_LEAD_MS) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

export function parseWhen(input: string, now: number): ParseWhenResult {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") return fail("Enter a time, e.g. 3am or in 5h");

  const relative = RELATIVE.exec(text);
  if (relative !== null && (relative[1] !== undefined || relative[2] !== undefined)) {
    const hours = Number(relative[1] ?? 0);
    const minutes = Number(relative[2] ?? 0);
    return check(now + hours * 3_600_000 + minutes * 60_000, now);
  }

  const clock = CLOCK.exec(text);
  if (clock !== null) {
    const minute = clock[2] === undefined ? undefined : Number(clock[2]);
    const fireAt = nextClockOccurrence(Number(clock[1]), minute, clock[3], now);
    if (fireAt !== undefined) return check(fireAt, now);
  }

  return fail(`Can't parse "${input.trim()}". ${HINT}`);
}
