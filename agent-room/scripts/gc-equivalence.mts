// The equivalence harness: the reference tool's `report --json` against the port's
// own report, field by field.
//
// Reference: `agent-room/docs/gc-port/slp-gc.bash`, `report --json` (`:1351`). The
// port assembles the same object in `server/gc/report.ts` (`buildReport`) and, since
// this task, persists it beside the rendered text at
// `<state>/reports/<stamp>.json` (`writeReportFile`, `server/gc/tick.ts`).
//
// Usage:
//
//   node --experimental-strip-types scripts/gc-equivalence.mts [plugin-report.json]
//
// With no argument the newest `reports/*.json` under the plugin's GC state dir is
// read (`$AGENT_ROOM_GC_STATE`, default `~/.paseo/plugin-data/agent-room/gc`), so the
// check can be repeated against whatever the last scheduled tick wrote. The bash
// side runs with `SLP_GC_STATE_DIR` pointed at a fresh temporary directory: `report`
// is read-only by contract, but a state dir of its own makes "read-only" a property
// of the setup and not of the reference's promise, so a harness run can never touch
// the live GC state.
//
// What is compared, and what cannot be:
//
// The two reports are captured by different processes at different instants, so
// every field whose value is live — a pid, a sample of `top`, an age, a size, a
// timestamp — is dropped before the comparison (`IGNORE`), with the reason recorded
// in `docs/acceptance-phase3-2026-10-30.md`. What remains is the report's structure
// and its decisions: sections, classes, owners, states, rules, reasons, actions,
// thresholds, counts and verdicts. A difference there is drift in the port, and the
// harness names the first one by path so the fix lands in the modules.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fields dropped before the comparison, with the reason each one is live rather
 * than drift. The first block is the brief's list; the rest is what the two capture
 * instants make unavoidably different (see the acceptance record's table).
 */
const IGNORE = new Set([
  // --- the brief's list
  "generated", // the capture instant
  "home", // the same path on both sides, but an absolute one: not a decision
  "etime_s", // process age, sampled seconds apart
  "pid", // a live pid; two captures see the same processes, not the same numbers
  "ppid",
  "pgid",
  "lstart", // process start time, as text
  "rss_mb", // a `ps`/`top` sample
  "mem_mb", // a `top` MEM sample
  "cmprs_mb", // a `top` CMPRS sample
  "footprint_mb", // a `top` MEM sample (the row's measured footprint)
]);

/** The path of the first differing value, as `a.b[3].c`, or `null` when the two agree. */
function firstDifference(left: unknown, right: unknown, path = ""): string | null {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${path === "" ? "<root>" : path} (${String(left.length)} rows vs ${String(right.length)})`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${String(index)}]`);
      if (difference !== null) return difference;
    }
    return null;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ]);
    for (const key of keys) {
      const difference = firstDifference(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  if (left === right) return null;
  const show = (value: unknown): string => {
    const text = value === undefined ? "<absent>" : JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  };
  return `${path === "" ? "<root>" : path} (${show(left)} vs ${show(right)})`;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !IGNORE.has(key))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

/** The plugin's GC state dir: the daemon's own plugin-data directory in production. */
function pluginStateDir(): string {
  return (
    process.env.AGENT_ROOM_GC_STATE ?? join(homedir(), ".paseo", "plugin-data", "agent-room", "gc")
  );
}

/** The newest `reports/*.json` the plugin wrote, or a refusal that says why there is none. */
function newestPluginReport(stateDir: string): string {
  const reports = join(stateDir, "reports");
  let names: string[];
  try {
    names = readdirSync(reports).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new Error(`no plugin reports under ${reports}: a tick writes one when a report is due`);
  }
  const newest = names.at(-1);
  if (newest === undefined) {
    throw new Error(`no plugin report JSON under ${reports}: a tick writes one when a report is due`);
  }
  return join(reports, newest);
}

/** `report --json`, with a state dir of its own so the live GC state is never touched. */
function bashReport(): unknown {
  const stateDir = mkdtempSync(join(tmpdir(), "gc-equivalence-state-"));
  try {
    const stdout = execFileSync("bash", ["docs/gc-port/slp-gc.bash", "report", "--json"], {
      encoding: "utf8",
      env: { ...process.env, SLP_GC_STATE_DIR: stateDir },
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } finally {
    // `report` writes nothing, but the state dir exists and is this run's to remove.
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function main(): void {
  const explicit = process.argv[2];
  const pluginPath = explicit ?? newestPluginReport(pluginStateDir());
  let plugin: unknown;
  try {
    plugin = JSON.parse(readFileSync(pluginPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read the plugin report at ${pluginPath}: ${String(error)}`);
  }

  const difference = firstDifference(normalize(bashReport()), normalize(plugin));
  if (difference !== null) {
    console.log(`DIFFERS at ${difference}`);
    console.log(`  plugin report: ${pluginPath}`);
    process.exitCode = 1;
    return;
  }
  const written = statSync(pluginPath).mtime.toISOString();
  console.log(`EQUIVALENT (plugin report ${pluginPath}, written ${written})`);
}

main();
