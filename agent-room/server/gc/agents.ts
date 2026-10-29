// The agent and schedule index: the two reads whose completeness every deletion
// depends on. Both are built from the same on-disk records the reference reads,
// with the same scan and the same jq reductions:
//
//   iso_epoch, JQ_COMMON   slp-gc.bash:198-203 (the UTC form and its epoch)
//   AGENT_JQ               slp-gc.bash:212-225
//   SCHED_JQ               slp-gc.bash:228-252
//   agent scan             extract_agents, slp-gc.bash:623-645
//   schedule scan          extract_schedules, slp-gc.bash:646-661
//   strict (agents)        slp-gc.bash:220-222
//   strict (schedules)     slp-gc.bash:241-242
//   room                   slp-gc.bash:248
//   fires1h / fires24h     slp-gc.bash:229, 250-251
//   fail24h                slp-gc.bash:230, 239, 252
//   activeRunFail24h       slp-gc.bash:231, 252
//
// The controller's ruling is that `PaseoApi` is not consulted for GC decisions:
// it exposes no schedules at all, and its agent snapshots do not carry the keys
// the deletion rule's `strict` check needs. So the source of truth here is
// `$PASEO_HOME/agents/<workspace>/<id>.json` and `$PASEO_HOME/schedules/<id>.json`
// — the files the daemon itself writes, and exactly the ones the reference
// scanned.
//
// Scan shape, from `extract_agents` / `extract_schedules`:
//
//   agents     `find "$PHOME/agents" -mindepth 2 -maxdepth 2 -type f -name '*.json'`
//              — one level of workspace directory, one record per file. Symlinks
//              (`-maxdepth 2 -type l`) are never followed.
//   schedules  `find "$PHOME/schedules" -mindepth 1 -maxdepth 1 -type f -name '*.json'`
//              — flat; symlinks (`-mindepth 1 -maxdepth 1 -type l`) are never
//              followed.
//   both       `[ ! -d "$PHOME/<kind>" ]` answers `[]` with no error (:627, :648),
//              so an absent directory is a healthy, empty index — not a failure.
//
// Nothing here throws. Every failure ends as `index.ok: false` with the reason
// in `index.why`, and the records that did parse are still returned: reclamation
// refuses on a failed index downstream (slp-gc.bash:686, 1054-1057), so a partial
// index can never be mistaken for a complete one, and the parsed records remain
// available for the report.
//
// The one deliberate divergence from the reference is that divergence itself:
// the reference keeps an unparseable record as an `ok:false` row and blocks
// deletions that *mention* its id by grepping the file's UUIDs (`collect_refs`,
// slp-gc.bash:664-687). This module cannot grep a record it could not reduce, so
// it fails the whole index instead — the same fail-closed answer, one level
// coarser, as the ruling requires.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GcLog } from "./settings";

/** One agent record, reduced to what the deletion rule reads (AGENT_JQ, slp-gc.bash:212-225). */
export interface AgentRec {
  id: string;
  provider: string;
  /** `archivedAt` verbatim, or null (AGENT_JQ:218). */
  archivedAt: string | null;
  /** `archivedAt` in epoch seconds; null when absent or not the reference's UTC form. */
  archivedEpoch: number | null;
  /** The record's `lastStatus` (AGENT_JQ:217). */
  status: string | null;
  cwd: string | null;
  /**
   * The record's `internal` flag. `false` means "not internal". A record that
   * does not carry the flag at all is refused through `strict`, which is the
   * reference's behaviour too (the flag is one of the keys `strict` requires).
   */
  internal: boolean;
  labels: Record<string, string>;
  /** `labels["paseo.parent-agent-id"]` (AGENT_JQ:224). */
  parent: string | null;
  /** `runtimeInfo.sessionId` (AGENT_JQ:225). */
  sessionId: string | null;
  /**
   * Every key the deletion rule depends on is present with the right type
   * (AGENT_JQ:220-222): `internal` boolean, `archivedAt` present and
   * string-or-null, `lastStatus` a string, `updatedAt` a string.
   */
  strict: boolean;
}

/**
 * One schedule record (SCHED_JQ, slp-gc.bash:228-252).
 *
 * Every field the reference's completed-schedule rule reads is here: `runs` and
 * `runsRunning` (:539), `room` (:535), `strict` (:531), `targetType` /
 * `targetAgent` (:533-534), `updatedEpoch` (:536) and `lastRunEpoch` (:537-538).
 * `fires1h` / `fires24h` / `fail24h` / `activeRunFail24h` are the heartbeat
 * health the reference reports (:971).
 */
export interface ScheduleRec {
  id: string;
  name: string | null;
  status: string;
  targetType: string;
  targetAgent: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runs: number;
  runsRunning: number;
  /** Failures inside the last day, by `startedAt` else `scheduledFor` (:230, 239, 252). */
  fail24h: number;
  /** `name` starts with `supervisor:` or `prompt` starts with `[supervisor-heartbeat]` (:248). */
  room: boolean;
  /** Runs, `lastRunAt`, `nextRunAt` and `updatedAt` present and typed (:241-242). */
  strict: boolean;
  /** `updatedAt` verbatim and in epoch seconds (:245-246). */
  updatedAt: string | null;
  updatedEpoch: number | null;
  /** `lastRunAt` in epoch seconds (:247). */
  lastRunEpoch: number | null;
  /** Run timestamps inside the last hour / day (:229, 250-251). */
  fires1h: number;
  fires24h: number;
  /** The 24 h failures reported as an already-active run (:231, 252). */
  activeRunFail24h: number;
}

/** Whether the index is trustworthy. `ok: false` means reclamation must refuse. */
export interface SnapshotIndex {
  ok: boolean;
  why: string[];
}

export interface AgentSnapshot {
  agents: AgentRec[];
  index: SnapshotIndex;
}

export interface ScheduleSnapshot {
  schedules: ScheduleRec[];
  index: SnapshotIndex;
}

/** Shared options: a log sink, and a directory override for a caller with an unusual home. */
interface IndexOptions {
  /** Where a failed read is reported; the index carries the same message. */
  log?: GcLog;
  /** Overrides `<paseoHome>/agents` (agents) or `<paseoHome>/schedules` (schedules). */
  dir?: string;
}

export type AgentIndexOptions = IndexOptions;

export interface ScheduleIndexOptions extends IndexOptions {
  /** Epoch seconds the window comparisons use; defaults to the wall clock. */
  now?: number;
}

/** The parent link the reference reads out of the label map (AGENT_JQ:224). */
const PARENT_LABEL = "paseo.parent-agent-id";

const HOUR = 3600;
const DAY = 86400;

/** The record file suffix both scans filter on (`-name '*.json'`, slp-gc.bash:628, 650). */
const RECORD_SUFFIX = ".json";

/** A whole-second-or-fractional UTC timestamp, the only form `iso_epoch` accepts (slp-gc.bash:199-200). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * `iso_epoch` (slp-gc.bash:199-200): the reference accepts the daemon's UTC
 * form only, drops a fractional part and answers null for everything else —
 * including an impossible date. Epoch seconds are the unit every comparison in
 * the GC uses; null, never NaN, is what a caller can branch on.
 */
export function isoEpoch(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value.replace(/\.\d+/, ""));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * jq's `type == "object"`: an object, and *not* an array. The distinction
 * matters — `(.[] | type) == "object"` is how SCHED_JQ skips a run that is not a
 * record (:239), and `(.labels | type) == "object"` is how AGENT_JQ refuses an
 * array shaped like a label map (:223).
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** An error's message, for `index.why`. Never the stack: this text reaches a report. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An error's `code`, when the filesystem attached one (`ENOENT`, `ENOTDIR`, `EACCES`, …). */
function errorCode(error: unknown): string | null {
  const code = isObject(error) ? error.code : null;
  return typeof code === "string" ? code : null;
}

/**
 * A `warn` sink for the log the caller passed: a function, a logger shape or
 * nothing at all. Kept local rather than imported because `settings.ts` owns the
 * conf importer's logging and this module must not widen it.
 */
function warnLog(
  log: GcLog | undefined,
): (message: string, fields?: Record<string, unknown>) => void {
  if (typeof log === "function") {
    return log as (message: string, fields?: Record<string, unknown>) => void;
  }
  if (log !== null && typeof log === "object") {
    const candidate = (log as unknown as Record<string, unknown>).warn;
    if (typeof candidate === "function") {
      return (candidate as (message: string, fields?: Record<string, unknown>) => void).bind(log);
    }
  }
  return () => {};
}

/** One directory entry, as much as the scans care about (`find`'s `-type` tests). */
interface Entry {
  name: string;
  isDir: boolean;
  isFile: boolean;
  isLink: boolean;
}

/**
 * A directory listing, or the reason there is none. `absent` is the reference's
 * `[ ! -d "$PHOME/<kind>" ]` branch: a missing directory — or a path that is not
 * a directory at all — is a healthy, empty index, not a failure.
 */
type DirRead = { ok: true; entries: Entry[] } | { ok: false; absent: boolean; why: string };

async function readDir(path: string): Promise<DirRead> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return {
      ok: true,
      // Sorted by name so a report is stable across filesystems; the index is a
      // set keyed by id, so ordering never changes a decision.
      entries: entries
        .map((entry) => ({
          name: entry.name,
          isDir: entry.isDirectory(),
          isFile: entry.isFile(),
          isLink: entry.isSymbolicLink(),
        }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, absent: true, why: "" };
    return { ok: false, absent: false, why: `cannot read the directory ${path}: ${reason(error)}` };
  }
}

/** One record file, or the reason it could not be read or parsed. */
type JsonRead = { ok: true; raw: unknown } | { ok: false; why: string };

/**
 * Read and parse one record file. A read error and a parse error are reported
 * separately because they mean different things to whoever reads the report: a
 * file that vanished mid-scan versus a file whose bytes are not JSON (the
 * reference's `invalid JSON` row, slp-gc.bash:635, 655).
 */
async function readJsonFile(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, why: `cannot read the record ${path}: ${reason(error)}` };
  }
  try {
    return { ok: true, raw: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, why: `invalid JSON in the record ${path}: ${reason(error)}` };
  }
}

/** One record, or the reason it cannot be indexed (the reference's `{ok:false, reason}`). */
type ReadResult<T> = { ok: true; rec: T } | { ok: false; why: string };

/**
 * One agent record file -> `AgentRec` (AGENT_JQ:212-225). `id` and `provider`
 * are the reference's own admission gate (:215-216); a record missing either is
 * not indexed at all, and the caller turns that into an incomplete index.
 */
function readAgent(raw: unknown): ReadResult<AgentRec> {
  if (!isObject(raw)) return { ok: false, why: "not a JSON object" };
  if (typeof raw.id !== "string" || raw.id.length === 0) return { ok: false, why: "missing id" };
  if (typeof raw.provider !== "string") return { ok: false, why: "missing provider" };

  const labels = readLabels(raw.labels);
  const parent = labels[PARENT_LABEL];
  const runtime = raw.runtimeInfo;
  const lastStatus = raw.lastStatus;
  return {
    ok: true,
    rec: {
      id: raw.id,
      provider: raw.provider,
      archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
      archivedEpoch: isoEpoch(raw.archivedAt),
      status: typeof lastStatus === "string" ? lastStatus : null,
      cwd: typeof raw.cwd === "string" ? raw.cwd : null,
      internal: raw.internal === true,
      labels,
      parent: typeof parent === "string" && parent.length > 0 ? parent : null,
      sessionId:
        isObject(runtime) && typeof runtime.sessionId === "string" ? runtime.sessionId : null,
      // AGENT_JQ:220-222, key by key: `internal` present and boolean,
      // `archivedAt` present and string-or-null, `lastStatus` a string,
      // `updatedAt` a string.
      strict:
        hasOwn(raw, "internal") &&
        typeof raw.internal === "boolean" &&
        hasOwn(raw, "archivedAt") &&
        (typeof raw.archivedAt === "string" || raw.archivedAt === null) &&
        typeof lastStatus === "string" &&
        typeof raw.updatedAt === "string",
    },
  };
}

/** `labels` as a string map; anything else is `{}` (AGENT_JQ:223). */
function readLabels(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") labels[key] = entry;
  }
  return labels;
}

/** `(.startedAt // .scheduledFor) | iso_epoch` (SCHED_JQ:229). */
function runEpoch(run: Record<string, unknown>): number | null {
  return isoEpoch(run.startedAt ?? run.scheduledFor);
}

/** A run that counts as a failure (SCHED_JQ:230). */
function isFailed(run: Record<string, unknown>): boolean {
  return run.status === "failed" || (typeof run.error === "string" && run.error.length > 0);
}

/** A failure the daemon reports as "already has an active run" (SCHED_JQ:231). */
function isActiveRunFailure(run: Record<string, unknown>): boolean {
  return typeof run.error === "string"
    ? run.error.toLowerCase().includes("already has an active run")
    : false;
}

/**
 * One schedule record -> `ScheduleRec` (SCHED_JQ:228-252).
 *
 * The record carries its own `runs` array (that is what SCHED_JQ reads: `(.runs
 * | if type == "array" then . else [] end)`, :237), so nothing has to be fetched
 * per schedule and a schedule whose `runs` is not an array is a `strict: false`
 * record with zero runs — precisely the reference's reading.
 */
function readSchedule(raw: unknown, now: number): ReadResult<ScheduleRec> {
  if (!isObject(raw)) return { ok: false, why: "not a JSON object" };
  if (typeof raw.id !== "string") return { ok: false, why: "missing id" };
  if (typeof raw.status !== "string") return { ok: false, why: "missing status" };
  const target = raw.target;
  if (!isObject(target) || typeof target.type !== "string") {
    return { ok: false, why: "missing target" };
  }

  // `(.runs | if type == "array" then . else [] end) as $runs` (:237).
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  const objects = runs.filter(isObject);
  const epochs = objects
    .map(runEpoch)
    .filter((epoch): epoch is number => epoch !== null);
  const failed24 = objects.filter((run) => {
    const epoch = runEpoch(run);
    return epoch !== null && epoch >= now - DAY && isFailed(run);
  });

  const name = typeof raw.name === "string" ? raw.name : null;
  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  return {
    ok: true,
    rec: {
      id: raw.id,
      name,
      status: raw.status,
      targetType: target.type,
      targetAgent: typeof target.agentId === "string" ? target.agentId : null,
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
      nextRunAt: typeof raw.nextRunAt === "string" ? raw.nextRunAt : null,
      runs: runs.length,
      runsRunning: objects.filter((run) => run.status === "running").length,
      fail24h: failed24.length,
      // SCHED_JQ:241-242: `runs` is an array, `lastRunAt` present and
      // string-or-null, `nextRunAt` present, `updatedAt` a string. `nextRunAt`'s
      // *value* is the deletion rule's business, not this flag's — the reference
      // only checks that the key is there.
      strict:
        Array.isArray(raw.runs) &&
        hasOwn(raw, "lastRunAt") &&
        (typeof raw.lastRunAt === "string" || raw.lastRunAt === null) &&
        hasOwn(raw, "nextRunAt") &&
        typeof raw.updatedAt === "string",
      room:
        (name !== null && name.startsWith("supervisor:")) ||
        prompt.startsWith("[supervisor-heartbeat]"),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      updatedEpoch: isoEpoch(raw.updatedAt),
      lastRunEpoch: isoEpoch(raw.lastRunAt),
      fires1h: epochs.filter((epoch) => epoch >= now - HOUR).length,
      fires24h: epochs.filter((epoch) => epoch >= now - DAY).length,
      activeRunFail24h: failed24.filter(isActiveRunFailure).length,
    },
  };
}

/**
 * Every agent record under `<paseoHome>/agents`, as the deletion rule needs them.
 *
 * The scan is `extract_agents` (slp-gc.bash:623-645): one level of workspace
 * directory, `*.json` files only, symlinks never followed, an absent directory
 * answering an empty index. A record that cannot be read or parsed is dropped
 * and fails the index (the ruling's answer to the reference's `rawRefs`): a
 * failed index refuses reclamation entirely downstream, so a subset here is
 * never mistaken for the whole set. Never throws.
 */
export async function snapshotAgents(
  paseoHome: string,
  options: AgentIndexOptions = {},
): Promise<AgentSnapshot> {
  const warn = warnLog(options.log);
  const dir = options.dir ?? join(paseoHome, "agents");
  const agents: AgentRec[] = [];
  const why: string[] = [];
  const seen = new Set<string>();

  const top = await readDir(dir);
  if (!top.ok) {
    if (top.absent) return { agents, index: { ok: true, why } }; // `[ ! -d ]` -> `[]` (:627)
    warn("gc agent index failed", { error: top.why });
    return { agents, index: { ok: false, why: [top.why] } };
  }

  for (const workspace of top.entries) {
    const workspacePath = join(dir, workspace.name);
    if (workspace.isLink) {
      // `find … -maxdepth 2 -type l` (:641-643): a symlink is reported, never followed.
      why.push(`${workspacePath}: symlink (never followed)`);
      continue;
    }
    if (!workspace.isDir) continue; // `-mindepth 2`: a file at the top level is not a record

    const inner = await readDir(workspacePath);
    if (!inner.ok) {
      why.push(inner.why);
      continue;
    }
    for (const entry of inner.entries) {
      const path = join(workspacePath, entry.name);
      if (entry.isLink) {
        why.push(`${path}: symlink (never followed)`);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(RECORD_SUFFIX)) continue;

      const file = await readJsonFile(path);
      if (!file.ok) {
        why.push(file.why);
        continue;
      }
      const read = readAgent(file.raw);
      if (!read.ok) {
        why.push(`the agent record ${path}: ${read.why}`);
        continue;
      }
      if (seen.has(read.rec.id)) continue; // one record per id, like the one-file-per-agent scan
      seen.add(read.rec.id);
      agents.push(read.rec);
    }
  }

  if (why.length > 0) warn("gc agent index incomplete", { problems: why.length });
  return { agents, index: { ok: why.length === 0, why } };
}

/**
 * Every schedule record under `<paseoHome>/schedules`, as the deletion rule
 * needs them.
 *
 * The scan is `extract_schedules` (slp-gc.bash:646-661): a flat directory,
 * `*.json` files only, symlinks never followed, an absent directory answering an
 * empty index. Records carry their own runs, so `fires1h` / `fires24h` /
 * `fail24h` / `activeRunFail24h` are derived here with no extra read. A record
 * that cannot be read or parsed is dropped and fails the index. Never throws.
 */
export async function snapshotSchedules(
  paseoHome: string,
  options: ScheduleIndexOptions = {},
): Promise<ScheduleSnapshot> {
  const warn = warnLog(options.log);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const dir = options.dir ?? join(paseoHome, "schedules");
  const schedules: ScheduleRec[] = [];
  const why: string[] = [];
  const seen = new Set<string>();

  const top = await readDir(dir);
  if (!top.ok) {
    if (top.absent) return { schedules, index: { ok: true, why } }; // `[ ! -d ]` -> `[]` (:648)
    warn("gc schedule index failed", { error: top.why });
    return { schedules, index: { ok: false, why: [top.why] } };
  }

  for (const entry of top.entries) {
    const path = join(dir, entry.name);
    if (entry.isLink) {
      // `find … -mindepth 1 -maxdepth 1 -type l` (:657-659).
      why.push(`${path}: symlink (never followed)`);
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith(RECORD_SUFFIX)) continue;

    const file = await readJsonFile(path);
    if (!file.ok) {
      why.push(file.why);
      continue;
    }
    const read = readSchedule(file.raw, now);
    if (!read.ok) {
      why.push(`the schedule record ${path}: ${read.why}`);
      continue;
    }
    if (seen.has(read.rec.id)) continue;
    seen.add(read.rec.id);
    schedules.push(read.rec);
  }

  if (why.length > 0) warn("gc schedule index incomplete", { problems: why.length });
  return { schedules, index: { ok: why.length === 0, why } };
}
