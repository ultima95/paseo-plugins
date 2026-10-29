// One-time import of the live `slp-gc.conf` into typed settings.
//
// The reference re-reads `~/.config/slp-room/slp-gc.conf` on every `tick`
// (slp-gc.bash:1242-1269). The port imports it once per process and merges it
// over the reference defaults; the plugin's `gc` settings document (Task 12) is
// layered on top by the caller.
//
// Importing is never allowed to break the plugin: a missing, unreadable or
// malformed conf logs and yields the defaults. Nothing here throws.
import { readFile } from "node:fs/promises";

import { DEFAULT_KILL_COMMS, type GcSettings } from "../../shared/gc";

/**
 * The reference defaults. `apply`, `killStale` and `killMemory` are all off, so
 * an imported conf that says nothing new leaves the GC report-only.
 */
export const DEFAULT_GC_SETTINGS: GcSettings = {
  apply: false,
  killStale: false,
  killMemory: false,
  memWarnMb: 3072,
  memKillMb: 4096,
  treeWarnMb: null,
  killComms: [...DEFAULT_KILL_COMMS],
  orphanMinAgeMin: 10,
  testConcurrencyWarn: 3,
  maxKills: 10,
  tickBudgetS: 45,
  reportIntervalMin: 60,
  cliTimeoutS: 30,
};

/** The reference's 1024 MB floor on `SLP_GC_MEM_KILL_MB` (slp-gc.bash:83). */
const MEM_KILL_FLOOR_MB = 1024;

/** A `Logger`-shaped object, or a bare log function used for every level. */
export interface GcLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * What a caller may hand in as a log. `consoleLogger` satisfies `GcLogger`, a
 * `vi.fn()` satisfies the callable arm, and the index-signature arm keeps a
 * half-built or foreign logger (the plugin's own `Log` type, a `vi.fn()` that is
 * also constructable) assignable: this module is on the plugin load path, so a
 * log signature mismatch must be a typing inconvenience, never a crash.
 */
export type GcLog =
  | GcLogger
  | ((message: string, fields?: Record<string, unknown>) => void)
  | object;

type LogLevel = "info" | "warn" | "error";

const noop = (): void => {};

/** Resolve one log level, tolerating a callable, a shape, or nothing at all. */
function logFn(
  log: GcLog | undefined,
  level: LogLevel,
): (message: string, fields?: Record<string, unknown>) => void {
  if (typeof log === "function") {
    return log as (message: string, fields?: Record<string, unknown>) => void;
  }
  if (log !== null && typeof log === "object") {
    const candidate = (log as unknown as Record<string, unknown>)[level];
    if (typeof candidate === "function") {
      return (candidate as (message: string, fields?: Record<string, unknown>) => void).bind(log);
    }
  }
  return noop;
}

type IntField =
  | "memWarnMb"
  | "memKillMb"
  | "treeWarnMb"
  | "orphanMinAgeMin"
  | "testConcurrencyWarn"
  | "maxKills"
  | "tickBudgetS"
  | "reportIntervalMin"
  | "cliTimeoutS";

type FlagField = "apply" | "killStale" | "killMemory";

/**
 * Numeric keys and the smallest value the reference accepts for them
 * (slp-gc.bash:82-89). Anything else is `is_uint`-only in the reference, so the
 * floor for those keys is 0 — except the memory, age, count, budget and
 * interval knobs, which the reference also requires to be at least 1 and
 * otherwise resets to the default.
 */
const INT_KEYS: Record<string, { field: IntField; min: number }> = {
  SLP_GC_MEM_WARN_MB: { field: "memWarnMb", min: 1 },
  SLP_GC_MEM_KILL_MB: { field: "memKillMb", min: MEM_KILL_FLOOR_MB },
  SLP_GC_TREE_WARN_MB: { field: "treeWarnMb", min: 1 },
  SLP_GC_ORPHAN_MIN_AGE_MIN: { field: "orphanMinAgeMin", min: 1 },
  SLP_GC_TEST_CONCURRENCY_WARN: { field: "testConcurrencyWarn", min: 0 },
  SLP_GC_MAX_KILLS: { field: "maxKills", min: 1 },
  SLP_GC_TICK_BUDGET_S: { field: "tickBudgetS", min: 1 },
  SLP_GC_REPORT_INTERVAL_MIN: { field: "reportIntervalMin", min: 1 },
  SLP_GC_CLI_TIMEOUT: { field: "cliTimeoutS", min: 1 },
};

const FLAG_KEYS: Record<string, FlagField> = {
  SLP_GC_APPLY: "apply",
  SLP_GC_KILL_STALE: "killStale",
  SLP_GC_KILL_MEMORY: "killMemory",
};

/** `SLP_GC_KILL_COMMS` with its documented legacy alias (slp-gc.bash:1259). */
const KILL_COMMS_KEYS = new Set(["SLP_GC_KILL_COMMS", "SLP_GC_ORPHAN_COMMS"]);

/** `is_uint`: digits only, at most 12 of them (slp-gc.bash:40). */
const UINT = /^\d{1,12}$/;

/**
 * Strip one layer of surrounding quotes, as `read_config` does with
 * `${v#\"}` / `${v%\"}` / `${v#'}` / `${v%'}` (slp-gc.bash:1251).
 */
function unquote(value: string): string {
  let out = value;
  if (out.startsWith('"')) out = out.slice(1);
  if (out.endsWith('"')) out = out.slice(0, -1);
  if (out.startsWith("'")) out = out.slice(1);
  if (out.endsWith("'")) out = out.slice(0, -1);
  return out;
}

/**
 * Parse `slp-gc.conf`: `KEY=VALUE`, comments skipped, the last assignment of a
 * key wins, and a flag is on only when its value is exactly `1`. Numbers that
 * are not unsigned integers, or that are below the reference's floor, are
 * reported as problems and dropped so the default applies (the reference
 * resets them the same way). Never throws.
 *
 * `values` holds only the keys the file actually set, clamped, so it can be
 * spread over `DEFAULT_GC_SETTINGS`. `problems` is the same list that is logged.
 */
export function parseConf(
  text: string,
  log: GcLog,
): { values: Partial<GcSettings>; problems: string[] } {
  const values: Partial<GcSettings> = {};
  const problems: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) {
      problems.push(`unparseable line: ${line}`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());

    if (key in FLAG_KEYS) {
      // `read_config` clears the flag on anything that is not exactly "1".
      values[FLAG_KEYS[key]] = value === "1";
      continue;
    }

    if (KILL_COMMS_KEYS.has(key)) {
      const comms = value
        .split(/[\s,]+/)
        .map((comm) => comm.trim())
        .filter(Boolean);
      // An empty list is not "kill nothing": the reference treats it as bad
      // input and restores the default list (slp-gc.bash:95).
      if (comms.length === 0) {
        problems.push(`empty value for ${key}; using the default comm list`);
        delete values.killComms;
        continue;
      }
      values.killComms = comms;
      continue;
    }

    const spec = INT_KEYS[key];
    if (spec === undefined) {
      problems.push(`unknown key: ${key}`);
      continue;
    }
    if (!UINT.test(value) || Number(value) < spec.min) {
      problems.push(`invalid number for ${key}: ${value}`);
      continue;
    }
    values[spec.field] = Number(value);
  }

  // `norm_thresholds`: the kill threshold never sits below the warning one, and
  // never below the 1024 MB floor. With kill unset, the reference default is
  // raised to the warn value when warn is the larger.
  if (values.memWarnMb !== undefined && values.memKillMb === undefined) {
    values.memKillMb = Math.max(values.memWarnMb, DEFAULT_GC_SETTINGS.memKillMb);
  }
  if (values.memKillMb !== undefined) {
    const floor = Math.max(MEM_KILL_FLOOR_MB, values.memWarnMb ?? DEFAULT_GC_SETTINGS.memWarnMb);
    values.memKillMb = Math.max(floor, values.memKillMb);
  }

  const warn = logFn(log, "warn");
  for (const problem of problems) warn("gc conf import", { problem });

  return { values, problems };
}

export interface GcSettingsReaderInput {
  /** Where the conf lives; `~/.config/slp-room/slp-gc.conf` in production. */
  confPath: string;
  log: GcLog;
  /** Test seam: replaces the `node:fs/promises` read. */
  readFile?: (path: string) => Promise<string>;
}

/**
 * Memoised per resolved conf path, for the process lifetime: the plugin loads
 * once and the conf is a human-edited file, so a re-read would only add a way
 * for two ticks to disagree. Keyed by path so a test can use its own file.
 */
const imported = new Map<string, Promise<GcSettings>>();

/** `DEFAULT_GC_SETTINGS` with its own kill-comm array, so callers cannot mutate the shared default. */
function freshDefaults(): GcSettings {
  return { ...DEFAULT_GC_SETTINGS, killComms: [...DEFAULT_KILL_COMMS] };
}

/**
 * Import the conf once and merge it over `DEFAULT_GC_SETTINGS`. A missing or
 * unreadable file logs `gc conf absent` and yields the defaults; a malformed one
 * yields the keys that parsed. Never rejects.
 */
export function createGcSettingsReader(input: GcSettingsReaderInput): Promise<GcSettings> {
  const cached = imported.get(input.confPath);
  if (cached !== undefined) return cached;

  const read = input.readFile ?? ((path: string) => readFile(path, "utf8"));
  const pending = (async (): Promise<GcSettings> => {
    let text: string;
    try {
      text = await read(input.confPath);
    } catch {
      logFn(input.log, "info")("gc conf absent; using defaults", { path: input.confPath });
      return freshDefaults();
    }

    // Every failure mode ends in defaults: a conf this module cannot even parse
    // must not reach the plugin's load path as a rejection.
    let values: Partial<GcSettings>;
    let problems: string[];
    try {
      ({ values, problems } = parseConf(text, input.log));
    } catch (error) {
      logFn(input.log, "warn")("gc conf unreadable; using defaults", {
        path: input.confPath,
        error: String(error),
      });
      return freshDefaults();
    }

    const merged = freshDefaults();
    Object.assign(merged, values);
    logFn(input.log, "info")("gc conf imported", {
      keys: Object.keys(values).length,
      problems: problems.length,
    });
    return merged;
  })();

  imported.set(input.confPath, pending);
  return pending;
}
