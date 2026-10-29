// GC settings schema — the typed shape of `slp-gc.conf` and of the plugin's
// `gc` settings document.
//
// The knobs and their defaults are the reference tool's: `norm_thresholds`
// (slp-gc.bash:78-97), `read_config` (slp-gc.bash:1240-1269) and the env block in
// `usage` (slp-gc.bash:127-133). The reference is bash; this file is the single
// place where those names, ranges and defaults are written down for the port.
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
