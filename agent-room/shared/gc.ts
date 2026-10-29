// GC settings schema — the typed shape of `slp-gc.conf` and of the plugin's
// `gc` settings document.
//
// The knobs and their defaults are the reference tool's: `norm_thresholds`
// (slp-gc.bash:78-97), `read_config` (slp-gc.bash:1240-1269) and the env block in
// `usage` (slp-gc.bash:127-133). The reference is bash; this file is the single
// place where those names, ranges and defaults are written down for the port.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Process names the kill rules may target (slp-gc.bash:79 `DEF_KILL_COMMS`).
 * Order is the reference's and is kept verbatim: the GC's output lists comms in
 * this order, so a reordered list would change report bytes.
 */
export const DEFAULT_KILL_COMMS: string[] = [
  "node",
  "bun",
  "deno",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "esbuild",
  "tsc",
  "vitest",
  "jest",
  "python",
  "python3",
  "uv",
  "pytest",
  "ruby",
  "java",
  "gradle",
  "go",
  "cargo",
];

/**
 * Every GC knob.
 *
 * Bounds mirror the reference's `norm_thresholds`, which falls back to the
 * default for anything out of range: 1 is the floor for the memory, age,
 * count, budget and interval knobs (`testConcurrencyWarn` accepts 0, the
 * reference only checks that it is an unsigned integer), `memKillMb` has a
 * 1024 MB floor, and `treeWarnMb` is `null` for "half of physical RAM", which a
 * later task resolves against `hw.memsize`.
 *
 * The cross-field rule (`memKillMb >= memWarnMb`) is a clamp, not a rejection:
 * it is applied by the conf importer and, for user overrides, by whoever merges
 * plugin settings over this baseline. Expressing it as a validation error here
 * would make the plugin's settings document fail to load over a typo.
 */
export const gcSettings = z.object({
  /** `SLP_GC_APPLY`: delete completed schedules and long-archived agents. */
  apply: z.boolean(),
  /** `SLP_GC_KILL_STALE`: SIGTERM proven orphans (needs `apply`). */
  killStale: z.boolean(),
  /** `SLP_GC_KILL_MEMORY`: SIGTERM one process above `memKillMb` (needs `apply`). */
  killMemory: z.boolean(),
  /** `SLP_GC_MEM_WARN_MB`: per-process alert threshold. */
  memWarnMb: z.number().int().min(1),
  /** `SLP_GC_MEM_KILL_MB`: the memory kill threshold; floor 1024, never below warn. */
  memKillMb: z.number().int().min(1024),
  /** `SLP_GC_TREE_WARN_MB`: Paseo tree alert threshold; `null` = half of RAM. */
  treeWarnMb: z.number().int().min(1).nullable(),
  /** `SLP_GC_KILL_COMMS` (alias `SLP_GC_ORPHAN_COMMS`): killable process names. */
  killComms: z.array(z.string().min(1)),
  /** `SLP_GC_ORPHAN_MIN_AGE_MIN`: how long an orphan must have been orphaned. */
  orphanMinAgeMin: z.number().int().min(1),
  /** `SLP_GC_TEST_CONCURRENCY_WARN`: concurrent test runners that make a room busy. */
  testConcurrencyWarn: z.number().int().min(0),
  /** `SLP_GC_MAX_KILLS`: signals per tick. */
  maxKills: z.number().int().min(1),
  /** `SLP_GC_TICK_BUDGET_S`: wall-clock budget for one tick's action phase. */
  tickBudgetS: z.number().int().min(1),
  /** `SLP_GC_REPORT_INTERVAL_MIN`: how often a tick writes a report. */
  reportIntervalMin: z.number().int().min(1),
  /** `SLP_GC_CLI_TIMEOUT`: seconds any single `paseo` CLI call may take. */
  cliTimeoutS: z.number().int().min(1),
});

export type GcSettings = z.infer<typeof gcSettings>;

/**
 * The plugin's `gc` settings document — the second half of the precedence rule
 * the port runs on: the one-time `slp-gc.conf` import (`server/gc/settings.ts`,
 * `DEFAULT_GC_SETTINGS`) is the baseline, and this document overrides only the
 * knobs the user actually saved.
 *
 * Every field is optional on purpose. Two behaviours follow from it and both
 * are the designed ones:
 *
 * - a key the document does not carry keeps the imported baseline value, so the
 *   defaults stay in exactly one place (`DEFAULT_GC_SETTINGS`) instead of being
 *   restated here as Zod defaults that could drift from it;
 * - a document that is invalid as a whole — a string where `memWarnMb` belongs,
 *   an unknown key with the wrong type — is rejected by `registerSettings` and
 *   the reader falls back to the baseline with one log line. A typo therefore
 *   never turns a rule off silently and never blocks the plugin from loading.
 *
 * The cross-field clamp (`memKillMb >= memWarnMb`) is *not* expressed here: it
 * is applied by whoever merges the document over the baseline, which is
 * `mergeGcSettings` in `server/gc/tick.ts`. A validation error there would make
 * the whole document invalid and lose every other override with it.
 */
export const gcSettingsDocumentSchema = gcSettings.partial();

export type GcSettingsDocument = z.infer<typeof gcSettingsDocumentSchema>;

/** The `registerSettings` document the plugin loads (id `gc`). */
export const gcSettingsDefinition = defineSettings({
  id: "gc",
  scope: "host",
  version: 1,
  schema: gcSettingsDocumentSchema,
});

/**
 * One `act` row (`ActionResult` in `server/gc/apply.ts`): what a tick considered,
 * whether anything happened, and why not. `gc.run` answers an array of these.
 */
export const gcActionSchema = z.object({
  kind: z.enum(["agent", "schedule", "kill", "refuse"]),
  /** The record's id (deletes) or the pid as a string (kills); `-` for a refusal row. */
  id: z.string(),
  acted: z.boolean(),
  reason: z.string(),
  /** The stable refusal key (`<rule>: <text>`), `null` when `acted` is true. */
  refusedBy: z.string().nullable(),
  /** Set on a kill row: the pid that was signalled. */
  pid: z.number().optional(),
  /** Set on a kill row: the class that was signalled. */
  pidClass: z.string().optional(),
});

export type GcAction = z.infer<typeof gcActionSchema>;

/**
 * One `alerts.log` line as the screen shows it: the line's own ISO stamp and the
 * text after it. A line without a recognisable stamp keeps `at: ""` and its text
 * verbatim — the file is the reference's, and a line this port cannot parse is
 * still a line a person should see.
 */
export const gcAlertSchema = z.object({
  at: z.string(),
  text: z.string(),
});

export type GcAlert = z.infer<typeof gcAlertSchema>;

/**
 * The GC screen's one read model: identification, when the last tick ran, when
 * the next report is due, the settings the tick acted on, the process rows it
 * judged and every record candidate it considered (refused ones included, so the
 * screen can show *why* something was not reclaimed).
 *
 * Everything the design's status block and history list ask for is published
 * here, and every field that can be unknown for the current state is `null`/empty
 * rather than filled with a plausible default: before the first tick the screen
 * has to be able to say "no data yet", and a fabricated value would read as a
 * measurement. The `daemonPid`/`uptimeS`, `ledger`, `index`, `lastReportAt` and
 * `alerts` additions are the status-payload widening the screen needs — they
 * describe the last tick and change no rule, decision, gate or action.
 */
export const gcStatusSchema = z.object({
  ident: z.object({ ok: z.boolean(), why: z.string() }),
  lastTickAt: z.string().nullable(),
  nextReportAt: z.string().nullable(),
  /**
   * The identified daemon's pid (`Identity.daemonPid`), or `null` when the tick
   * did not identify one. Not the same thing as the `daemon` process row: a row
   * can be classified `daemon` while identification refuses it.
   */
  daemonPid: z.number().nullable(),
  /**
   * The identified daemon's uptime in seconds, from that process row's `ps`
   * `etime` (`ProcEntry.etime_s`); `null` when no row was matched or the field
   * could not be read (`etime_s` is `-1` then).
   */
  uptimeS: z.number().nullable(),
  /**
   * The tree warn threshold the last tick used (`SLP_GC_TREE_WARN_MB`), or `null`
   * when it is "half of physical RAM". It sits beside `settings` rather than in
   * it because no decision rule compares against it — it is the report's alert
   * line — while `settings` is the acting block the rules read.
   */
  treeWarnMb: z.number().nullable(),
  /**
   * The lineage ledger the last tick read and wrote back: its row count and the
   * reader's own note (`null` when it had none). `rows: 0` before any tick, and
   * after a tick whose process phase failed.
   */
  ledger: z.object({ note: z.string().nullable(), rows: z.number() }),
  /**
   * The last tick's index verdict — both record scans complete — with the scans'
   * own reasons. This is the tick's `index`, not a conclusion drawn from the
   * candidates' refusal strings.
   */
  index: z.object({ ok: z.boolean(), why: z.array(z.string()) }),
  /** When the last report text was written (`<state>/reports/*.txt`), or `null`. */
  lastReportAt: z.string().nullable(),
  /** The newest `alerts.log` lines, newest first, at most `ALERTS_STATUS_LIMIT`. */
  alerts: z.array(gcAlertSchema),
  settings: z.object({
    apply: z.boolean(),
    killStale: z.boolean(),
    killMemory: z.boolean(),
    memWarnMb: z.number(),
    memKillMb: z.number(),
  }),
  procs: z.array(
    z.object({
      pid: z.number(),
      class: z.string().nullable(),
      owner: z.string().nullable(),
      footprintMb: z.number(),
      warn: z.boolean(),
    }),
  ),
  candidates: z.array(
    z.object({
      kind: z.enum(["agent", "schedule"]),
      id: z.string(),
      rule: z.string().nullable(),
      refusedBy: z.string().nullable(),
    }),
  ),
});

export type GcStatus = z.infer<typeof gcStatusSchema>;
