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
// in `docs/acceptance-phase3-2026-10-30.md`. One value is not dropped but mapped to a
// sentinel (`EQUIVALENT`): `protected` reads `in slp-gc's own process tree` on the
// reference side and `null` on the port's, which is the documented deviation and not
// drift — see the `EQUIVALENT` comment for the reason and the ruling it implements.
// No other `protected` value is normalised. What remains is the report's structure
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

/**
 * The reference's own-tree reason for a row, verbatim (`slp-gc.bash:317`, `:411`).
 * The port spells the same arm `in the GC's own process tree` (`server/gc/evaluate.ts:341`),
 * but never produces it in a tick: see `EQUIVALENT`.
 */
const REFERENCE_OWN_TREE = "in slp-gc's own process tree";

/** The one value both sides become: "inside a GC process tree, or the port has none". */
const NO_SELF_TREE = "<own process tree or none>";

/**
 * Keys whose *values* are equivalent while being unequal, mapped to a sentinel
 * before the comparison. The only entry is `protected`.
 *
 * ### `protected`: `in slp-gc's own process tree` ≡ `null`
 *
 * The reference protects its own process tree — its ancestry and every row
 * descending from it (`slp-gc.bash:295-298`, `$selfTree`), so under the bash tool
 * the app main, the Supervisor, the daemon and the tool's own shell all come out
 * `in slp-gc's own process tree`. The port runs *inside* the daemon and has no
 * process tree of its own, so its self-subtree arm is empty by ruling:
 * `NO_SELF_PID = 0` (`server/gc/tick.ts:193`). A tick therefore never claims a row
 * as its own, and those same rows carry `protected: null` — a null that means
 * "protected by nothing on this side", not "killable".
 *
 * This is a documented deviation, not drift, and it loses no decision. Every row
 * the reference covers with its own tree is still refused by class on both sides,
 * by the same arm in the same order: the app main and the Supervisor
 * (`slp-gc.bash:362`, `server/gc/evaluate.ts:595`), the daemon (`:363`, `:598`),
 * an agent child (`:364`, `:605`) — plus the invoking agent by `PASEO_AGENT_ID`
 * and `invOwnerPid`, which no class arm replaces. Since the two sides agree on the
 * class of every one of those rows, the same rows are ineligible for every rule,
 * action and verdict either way.
 *
 * Both values are mapped to `NO_SELF_TREE`, so `null` vs `null` still agrees (as
 * it did before) and a row the reference protects as its own now agrees with the
 * port's `null`. **No other `protected` value is normalised**: `belongs to the
 * invoking agent` and `in the invoking agent's process subtree` — and the port's
 * own `in the GC's own process tree`, should a caller ever pass a real
 * `deps.selfPid` — are compared as they are.
 */
const EQUIVALENT: Record<string, (value: unknown) => unknown> = {
  protected: (value) => (value === null || value === REFERENCE_OWN_TREE ? NO_SELF_TREE : value),
};

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
        .map(([key, entry]) => {
          // A keyed value mapping runs before the recursion, so a sentinel is
          // compared as a leaf and no other key of that object is touched.
          const mapValue = EQUIVALENT[key];
          return [key, normalize(mapValue === undefined ? entry : mapValue(entry))];
        }),
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
