// The agent and schedule index — the `PaseoApi` half of the GC port.
//
// The reference read one JSON file per agent and per schedule and reduced each
// one with jq:
//
//   iso_epoch, JQ_COMMON   slp-gc.bash:198-203 (the UTC form and its epoch)
//   AGENT_JQ               slp-gc.bash:212-225
//   SCHED_JQ               slp-gc.bash:228-252
//   the `strict` flags     slp-gc.bash:220-222 (agents), :241-242 (schedules)
//   room detection         slp-gc.bash:248
//   fires1h / fires24h     slp-gc.bash:229, 250-251
//   fail24h                slp-gc.bash:230, 239, 252
//   activeRunFail24h       slp-gc.bash:231, 252
//
// This module asks the daemon instead of reading files, so two things differ
// from a literal transliteration, both recorded here because they are the only
// places the port is not mechanical:
//
// 1. **The SDK's own shapes.** `paseo.agents.list` answers `{ entries: [{
//    agent }], pageInfo }` (`@getpaseo/client` index.d.ts:70-76, 310-325 and
//    protocol `FetchAgentsResponseMessageSchema`), not a bare agent array, and
//    the snapshot's `status` is the record's `lastStatus`. The list is a paged
//    read, so this module follows `pageInfo.nextCursor` to the end: a truncated
//    index would hide a live parent or a targeting schedule, and the deletion
//    rules lean on both.
// 2. **Schedules are not on `PaseoApi`.** `PaseoApi` (index.d.ts:398-408) has
//    hosts, terminals, workspaces, projects, agents, providers and config — no
//    schedules at all. The schedule surface exists one layer down, on
//    `DaemonClient` (`scheduleList` / `scheduleLogs`, daemon-client.d.ts:1376,
//    1378). So `snapshotSchedules` takes a structurally typed object whose
//    schedule methods are optional and answers `index.ok: false` — never an
//    empty, healthy-looking list — when the surface is absent. Reclamation
//    refuses on a failed index (Task 10), which is the reference's own answer
//    to an index it could not build (slp-gc.bash:686, 1054-1057).
//
// Nothing here throws. Every failure ends as `index.ok: false` with the reason
// in `index.why`, and the list is empty: a partial index must never be mistaken
// for a complete one.
import type { GcLog } from "./settings";

/** One agent record, reduced to what the deletion rule reads (AGENT_JQ, slp-gc.bash:212-225). */
export interface AgentRec {
  id: string;
  provider: string;
  /** `archivedAt` verbatim, or null (AGENT_JQ:218). */
  archivedAt: string | null;
  /** `archivedAt` in epoch seconds; null when absent or not the daemon's UTC form. */
  archivedEpoch: number | null;
  /** The record's `lastStatus` (AGENT_JQ:217), i.e. `status` on the API snapshot. */
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
   * (AGENT_JQ:220-222). The reference decides this on the file; here it is
   * decided on the snapshot the daemon returned, key presence included, so a
   * snapshot that omits a field is refused exactly like a file that does.
   */
  strict: boolean;
}

/**
 * One schedule record (SCHED_JQ, slp-gc.bash:228-252).
 *
 * Every field the reference's completed-schedule rule reads is here: `runs`
 * and `runsRunning` (:539), `room` (:535), `strict` (:531), `targetType` /
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
  /** The 24 h failures the daemon blamed on an already-active run (:231, 252). */
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

/**
 * What `paseo.agents.list` accepts, narrowed to what this module sends.
 * `PaseoApi` satisfies it (see `PaseoAgentListOptions`), and the filter is the
 * important part: the reference indexed *every* file under `agents/`
 * (extract_agents, slp-gc.bash:623-645), archived and internal records
 * included, and the daemon hides both unless asked.
 */
export interface AgentListOptions {
  requestId?: string;
  filter?: { includeArchived?: boolean; includeInternal?: boolean };
  page?: { limit: number; cursor?: string };
}

/** The part of `PaseoAgentListResult` this module reads. */
export interface AgentListLike {
  readonly entries?: unknown;
  readonly pageInfo?: unknown;
}

/** The agent surface as this module needs it. `PaseoApi["agents"]` satisfies it. */
export interface AgentsApi {
  readonly agents: {
    list(options?: AgentListOptions): Promise<AgentListLike>;
  };
}

/**
 * The schedule surface as this module needs it. Both methods are optional
 * because today's `PaseoApi` has neither; the names and payloads are
 * `DaemonClient`'s (`scheduleList` -> `{ schedules, error }`,
 * `scheduleLogs` -> `{ runs, error }`, daemon-client.d.ts:1376, 1378).
 */
export interface SchedulesApi {
  readonly scheduleList?: () => Promise<unknown>;
  readonly scheduleLogs?: (options: { id: string }) => Promise<unknown>;
}

export interface SnapshotOptions {
  /** Epoch seconds the window comparisons use; defaults to the wall clock. */
  now?: number;
  /** Where a failed read is reported; the index carries the same message. */
  log?: GcLog;
}

/** The parent link the reference reads out of the label map (AGENT_JQ:224). */
const PARENT_LABEL = "paseo.parent-agent-id";

const HOUR = 3600;
const DAY = 86400;

/**
 * How many pages one agent read may follow. A daemon that keeps claiming more
 * agents fails the index rather than spinning; the reference has no equivalent
 * because a directory listing is finite.
 */
const MAX_PAGES = 50;

/** The page size a first continuation asks for, when nothing better is known. */
const DEFAULT_PAGE_LIMIT = 100;

/** A ceiling on the copied page size, so one huge page cannot ask for more. */
const MAX_PAGE_LIMIT = 500;

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** An error's message, for `index.why`. Never the stack: this text reaches a report. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One record, or the reason it cannot be indexed (the reference's `{ok:false, reason}`). */
type ReadResult<T> = { ok: true; rec: T } | { ok: false; why: string };

/**
 * A `warn` sink for the log the caller passed: a function, a logger shape or
 * nothing at all. Kept local rather than imported because `settings.ts` owns
 * the conf importer's logging and this module must not widen it.
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

/**
 * One agent snapshot -> `AgentRec` (AGENT_JQ:212-225). `id` and `provider` are
 * the reference's own admission gate; a record missing either is not indexed at
 * all, and the caller turns that into an incomplete index.
 */
function readAgent(raw: unknown): ReadResult<AgentRec> {
  if (!isObject(raw)) return { ok: false, why: "not a JSON object" };
  if (typeof raw.id !== "string" || raw.id.length === 0) return { ok: false, why: "missing id" };
  if (typeof raw.provider !== "string") return { ok: false, why: "missing provider" };

  const labels = readLabels(raw.labels);
  const parent = labels[PARENT_LABEL];
  const runtime = raw.runtimeInfo;
  return {
    ok: true,
    rec: {
      id: raw.id,
      provider: raw.provider,
      archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
      archivedEpoch: isoEpoch(raw.archivedAt),
      status: typeof raw.status === "string" ? raw.status : null,
      cwd: typeof raw.cwd === "string" ? raw.cwd : null,
      internal: raw.internal === true,
      labels,
      parent: typeof parent === "string" && parent.length > 0 ? parent : null,
      sessionId:
        isObject(runtime) && typeof runtime.sessionId === "string" ? runtime.sessionId : null,
      // AGENT_JQ:220-222, key by key: `internal` present and boolean,
      // `archivedAt` present and string-or-null, `lastStatus` a string (the
      // snapshot's `status`), `updatedAt` a string.
      strict:
        hasOwn(raw, "internal") &&
        typeof raw.internal === "boolean" &&
        hasOwn(raw, "archivedAt") &&
        (typeof raw.archivedAt === "string" || raw.archivedAt === null) &&
        typeof raw.status === "string" &&
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
 * One schedule summary plus its runs -> `ScheduleRec` (SCHED_JQ:228-252).
 *
 * `runsKnown` is the adapted form of the reference's `(.runs | type) ==
 * "array"`: the daemon's list payload is a `ScheduleSummary`, which carries no
 * runs at all, so the runs arrive from the schedule logs instead. Having them
 * from either source is what the rule needs; not having them refuses the index.
 */
function readSchedule(
  raw: unknown,
  runs: unknown[],
  runsKnown: boolean,
  now: number,
): ReadResult<ScheduleRec> {
  if (!isObject(raw)) return { ok: false, why: "not a JSON object" };
  if (typeof raw.id !== "string") return { ok: false, why: "missing id" };
  if (typeof raw.status !== "string") return { ok: false, why: "missing status" };
  const target = raw.target;
  if (!isObject(target) || typeof target.type !== "string") {
    return { ok: false, why: "missing target" };
  }

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
      // AGENT_JQ's sibling for schedules (SCHED_JQ:241-242): an array of runs,
      // `lastRunAt` present and string-or-null, `nextRunAt` present, `updatedAt`
      // a string. `nextRunAt`'s value is the deletion rule's business, not this
      // flag's — the reference only checks that the key is there.
      strict:
        runsKnown &&
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
 * The runs of one schedule: from the record when the daemon inlines them, else
 * from `scheduleLogs`. `known: false` is not "no runs" — it is "this schedule's
 * runs could not be read", which fails the index.
 */
async function resolveRuns(
  raw: unknown,
  paseo: SchedulesApi,
): Promise<{ runs: unknown[]; known: boolean; why: string | null }> {
  if (isObject(raw) && Array.isArray(raw.runs)) {
    return { runs: raw.runs, known: true, why: null };
  }
  const logs = paseo.scheduleLogs;
  const id = isObject(raw) && typeof raw.id === "string" ? raw.id : null;
  if (id === null) {
    return { runs: [], known: false, why: "no id to read its runs" };
  }
  if (typeof logs !== "function") {
    return {
      runs: [],
      known: false,
      why: "the list payload carries no runs and paseo.scheduleLogs is unavailable",
    };
  }
  try {
    const listed = await logs.call(paseo, { id });
    if (!isObject(listed)) {
      return { runs: [], known: false, why: "schedule logs returned no object" };
    }
    if (typeof listed.error === "string" && listed.error.length > 0) {
      return { runs: [], known: false, why: listed.error };
    }
    if (!Array.isArray(listed.runs)) {
      return { runs: [], known: false, why: "schedule logs returned no runs array" };
    }
    return { runs: listed.runs, known: true, why: null };
  } catch (error) {
    return { runs: [], known: false, why: reason(error) };
  }
}

/**
 * Every agent the daemon knows about, as the deletion rule needs them.
 *
 * A failed read yields `index.ok: false` and no agents: reclamation refuses
 * entirely on an incomplete index (slp-gc.bash:686, 1054-1057), so returning a
 * subset here would be worse than returning nothing. A record that cannot be
 * identified is dropped and also fails the index, the same fail-closed answer
 * the reference gives an unreadable file (its id could otherwise hide a
 * reference). Never throws.
 */
export async function snapshotAgents(
  paseo: AgentsApi,
  options: SnapshotOptions = {},
): Promise<AgentSnapshot> {
  const warn = warnLog(options.log);
  const agents: AgentRec[] = [];
  const why: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  // `page.limit` is required alongside a cursor but the daemon's default page
  // size is not documented, so continuation pages copy the size of the page
  // before them instead of inventing a limit.
  let limit = DEFAULT_PAGE_LIMIT;

  try {
    for (let pageNo = 0; ; pageNo += 1) {
      if (pageNo >= MAX_PAGES) {
        why.push(`agent list still had more agents after ${MAX_PAGES} pages`);
        break;
      }
      const request: AgentListOptions = {
        filter: { includeArchived: true, includeInternal: true },
      };
      if (cursor !== undefined) request.page = { limit, cursor };

      const listed = await paseo.agents.list(request);
      const entries = isObject(listed) ? listed.entries : undefined;
      if (!Array.isArray(entries)) {
        why.push("the agent list returned no entries array");
        break;
      }

      for (const item of entries) {
        const raw = isObject(item) ? item.agent : undefined;
        const read = readAgent(raw);
        if (!read.ok) {
          why.push(`agent record ${describeId(raw)}: ${read.why}`);
          continue;
        }
        if (seen.has(read.rec.id)) continue; // a page overlap, not a second agent
        seen.add(read.rec.id);
        agents.push(read.rec);
      }

      const info = isObject(listed) && isObject(listed.pageInfo) ? listed.pageInfo : {};
      if (info.hasMore !== true) break;
      const next = typeof info.nextCursor === "string" ? info.nextCursor : "";
      if (next.length === 0) {
        why.push("the agent list reported more agents but no cursor to fetch them");
        break;
      }
      if (next === cursor) {
        why.push("the agent list page cursor did not advance");
        break;
      }
      cursor = next;
      limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, entries.length));
    }
  } catch (error) {
    const message = reason(error);
    warn("gc agent index failed", { error: message });
    return { agents: [], index: { ok: false, why: [message] } };
  }

  if (why.length > 0) warn("gc agent index incomplete", { problems: why.length });
  return { agents, index: { ok: why.length === 0, why } };
}

/**
 * Every schedule the daemon knows about, as the deletion rule needs them.
 *
 * A failed read yields `index.ok: false` and no schedules — including "this
 * `PaseoApi` has no schedule surface", which is today's answer because the SDK
 * exposes schedules only on `DaemonClient`. A record that cannot be identified,
 * or whose runs cannot be read, is kept only as a reason in `index.why` and
 * fails the index: the deletion rule compares `runsRunning` and the run stamps,
 * so a schedule with unknown runs must not look finished. Never throws.
 */
export async function snapshotSchedules(
  paseo: SchedulesApi,
  options: SnapshotOptions = {},
): Promise<ScheduleSnapshot> {
  const warn = warnLog(options.log);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const list = paseo.scheduleList;
  if (typeof list !== "function") {
    const message =
      "paseo.scheduleList is unavailable: this PaseoApi exposes no schedule surface, so schedules cannot be indexed";
    warn("gc schedule index unavailable", { error: message });
    return { schedules: [], index: { ok: false, why: [message] } };
  }

  let listed: unknown;
  try {
    listed = await list.call(paseo);
  } catch (error) {
    const message = reason(error);
    warn("gc schedule index failed", { error: message });
    return { schedules: [], index: { ok: false, why: [message] } };
  }

  if (!isObject(listed)) {
    const message = "the schedule list returned no object";
    warn("gc schedule index failed", { error: message });
    return { schedules: [], index: { ok: false, why: [message] } };
  }
  if (typeof listed.error === "string" && listed.error.length > 0) {
    const message = listed.error;
    warn("gc schedule index failed", { error: message });
    return { schedules: [], index: { ok: false, why: [message] } };
  }
  if (!Array.isArray(listed.schedules)) {
    const message = "the schedule list returned no schedules array";
    warn("gc schedule index failed", { error: message });
    return { schedules: [], index: { ok: false, why: [message] } };
  }

  const schedules: ScheduleRec[] = [];
  const why: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of listed.schedules.entries()) {
    const id = isObject(raw) && typeof raw.id === "string" ? raw.id : `#${index + 1}`;
    const resolved = await resolveRuns(raw, paseo);
    const read = readSchedule(raw, resolved.runs, resolved.known, now);
    if (!read.ok) {
      why.push(`schedule ${id}: ${read.why}`);
      continue;
    }
    if (seen.has(read.rec.id)) continue;
    seen.add(read.rec.id);
    schedules.push(read.rec);
    if (!resolved.known) {
      why.push(`schedule ${read.rec.id}: ${resolved.why ?? "its runs are unavailable"}`);
    }
  }

  if (why.length > 0) warn("gc schedule index incomplete", { problems: why.length });
  return { schedules, index: { ok: why.length === 0, why } };
}

/** The id of a record that is about to be rejected, for the `why` line. */
function describeId(raw: unknown): string {
  return isObject(raw) && typeof raw.id === "string" && raw.id.length > 0 ? raw.id : "(no id)";
}
