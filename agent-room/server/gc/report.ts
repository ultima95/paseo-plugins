// Report assembly and the three I/O collectors the report is made of.
//
// Reference (`agent-room/docs/gc-port/slp-gc.bash`, byte-identical to the deployed copy):
//
//   is_uint                :40      (digits only, at most 12)
//   iso_now                :48      (`date -u +%Y-%m-%dT%H:%M:%SZ`)
//   run_to                 :57-61   (the external alarm timeout; exit 142 on expiry)
//   collect_transcripts    :795-809 (CLAUDE_CONFIG_DIR/projects/*/<sessionId>.jsonl, largest first)
//   collect_metrics        :811-817 (the daemon's `ws_runtime_metrics` lines: last three)
//   collect_retention      :835-872 (the report-only scan of the home)
//   du_kb / count_files    :821-822
//   ret / age_days         :823-827
//   git_state              :828-834
//   evaluate full          :885-908 (the three collectors, then assembly)
//   ASSEMBLE_JQ            :879-884 (the report's eleven top-level keys, `version: 1`)
//   report --json          :1351    (`del(.procs.procs[].cmd, .procs.orphans[].cmd)`)
//
// Four properties matter more than tidiness:
//
// 1. **The report is an artifact with a fixed shape.** `buildReport` emits exactly the eleven
//    top-level keys of `__fixtures__/report-live.json`, in the fixture's order and nesting, and
//    `version` is the literal `1`. The `procs` section keeps every key the fixture has
//    (`ident`, `unreadableRows`, `procs`, `orphans`, `ledgerNext`, `ledgerNote`, `ledgerDropped`,
//    `tree`, `envBlind`, `totals`, `overall`, `warnMb`, `killMb`), with the tree's `agents` and
//    `tests` sub-objects. A consumer may therefore read the JSON by key without a shape test.
//
// 2. **`cmd` never reaches the report** (:1351). Command lines carry `--mcp-config` payloads and
//    bearer tokens, which is why the reference deletes them from the JSON artifact it prints —
//    the text report never showed them either. Both row kinds are stripped here, so a caller can
//    hand in the full `ProcEntry`/`OrphanEntry` and cannot leak a command line by forgetting.
//
// 3. **Nothing here throws, and no exec call is unbounded.** Every process call takes a budget
//    (`DU_TIMEOUT_MS` 60 s, `FIND_TIMEOUT_MS` 30 s, `GIT_TIMEOUT_MS` 15 s — the reference's own
//    `run_to` values) and a failed, timed-out or throwing `exec` degrades to *nothing collected*
//    rather than an exception: an empty array, a zero size, or a skipped row. Retention and
//    transcripts are pure report data (nothing in either can cause a deletion), so losing a row
//    to a timeout costs a line of the report and never a safety property.
//
// 4. **Purity split.** `buildReport` is a pure function of its inputs: every decision, snapshot,
//    process row, retention row, transcript and metric sample arrives as a value. The three
//    collectors own the I/O, take an injected `GcExec` and an injected clock (`now`), and are
//    called by the tick *before* assembly. Values the caller does not supply are derived from
//    values it did (`totals`/`overall` from the process rows, `envBlind` from the agent-family
//    rows, the agent counts from the rows) or defaulted fail-closed.
//
// The collectors mirror the reference's argv, not its shell: `find`, `du`, `stat`, `test`, `ls`,
// `git` and `tail` are invoked as argument vectors, so no path is ever re-parsed by a shell. Two
// small differences are deliberate and marked at the code:
//
//   - `stat -f %z` / `stat -f %m` are BSD/macOS forms (the reference picks its `stat` flavour at
//     startup, :51-55, and the deployed copy runs on macOS). A caller on another platform injects
//     an `exec` that translates, or its sizes and ages read as unknown — which degrades to 0.
//   - the reference has no timeout on `stat`, `test`, `ls` or `tail`; each one is given a budget
//     here (`PROBE_TIMEOUT_MS`, `TAIL_TIMEOUT_MS`) so no collector can outlive the tick.

import { join } from "node:path";

import type { AgentRec } from "./agents";
import { isAgentFamily } from "./evaluate";
import type { Decision, GarbageCandidate, GarbageRule, OrphanEntry, ProcEntry } from "./evaluate";
import type { HomeState, Identity } from "./identity";

// ---------------------------------------------------------------------------
// The exec boundary
// ---------------------------------------------------------------------------

/**
 * One finished command. The shape is deliberately the smallest thing the collectors need: a
 * verdict (`code`/`timedOut`), the stdout they parse, and the stderr they never read (the
 * reference redirects it to `/dev/null` everywhere, :795-872).
 */
export interface ExecResult {
  /** Exit status, or `null` when the command could not be started at all. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The watchdog fired — `run_to`'s 142, or `spawnSync`'s `ETIMEDOUT`. */
  timedOut: boolean;
}

export interface ExecOptions {
  /** The reference's `run_to <secs>`, in milliseconds. Always finite. */
  timeoutMs: number;
}

/**
 * The one I/O dependency the collectors have: run this argv with this budget, and answer with
 * what it produced. A real implementation is a `spawnSync` (or an async worker) that enforces
 * `timeoutMs`; a test is a lookup table. It may throw — the collectors catch.
 */
export type GcExec = (argv: readonly string[], options: ExecOptions) => ExecResult;

/** `run_to 60` — the home scan and every `du` (:821, :839, :855, :862). */
export const DU_TIMEOUT_MS = 60_000;
/** `run_to 30` — `count_files` and the worktree directory scans (:822, :859, :861). */
export const FIND_TIMEOUT_MS = 30_000;
/** `run_to 15` — both `git_state` calls (:831-832). */
export const GIT_TIMEOUT_MS = 15_000;
/** The port's budget for `tail -c 3000000` (:814, which the reference leaves unbounded). */
export const TAIL_TIMEOUT_MS = 15_000;
/** The port's budget for one `stat`/`test`/`ls` (:51-55, 821-828, 860, which have none). */
export const PROBE_TIMEOUT_MS = 5_000;

/** `SLP_GC_TRANSCRIPT_MIN_KB`'s default (:796): the `-size +512k` floor. */
export const TRANSCRIPT_MIN_KB = 512;
/** `head -n 15` (:807). */
export const TRANSCRIPT_LIMIT = 15;
/** `tail -c 3000000` (:814). */
export const DAEMON_LOG_TAIL_BYTES = 3_000_000;
/** `tail -n 3` (:816). */
export const DAEMON_METRIC_SAMPLES = 3;
/** `head -n 30` on the live-agent cwds (:867). */
export const OTHER_WORKTREE_LIMIT = 30;

/** `is_uint` (:40): digits only, at most 12 of them. */
const UINT = /^[0-9]+$/;

function isUint(text: string): boolean {
  return UINT.test(text) && text.length <= 12;
}

function failed(): ExecResult {
  return { code: null, stdout: "", stderr: "", timedOut: false };
}

/**
 * Run one command, never throwing and never handing a half-built result to a parser.
 *
 * An injected `exec` is foreign code: it can throw (a missing binary), answer `undefined` (a
 * stub), or answer with the wrong field types. Each of those becomes the same "nothing came
 * back" result, which every caller already treats as a degradation.
 */
function run(exec: GcExec, argv: readonly string[], timeoutMs: number): ExecResult {
  let result: ExecResult;
  try {
    result = exec(argv, { timeoutMs });
  } catch {
    return failed();
  }
  if (result === null || typeof result !== "object") return failed();
  return {
    code: typeof result.code === "number" ? result.code : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: result.timedOut === true,
  };
}

/** The reference's success test: `cmd` exited 0 and `run_to` did not alarm. */
function succeeded(result: ExecResult): boolean {
  return result.timedOut !== true && result.code === 0;
}

/** `test -d` / `test -f` / `test -L`, which answer through the exit status. */
function probe(exec: GcExec, argv: readonly string[]): boolean {
  return succeeded(run(exec, argv, PROBE_TIMEOUT_MS));
}

function isDirectory(exec: GcExec, path: string): boolean {
  return probe(exec, ["test", "-d", path]);
}

function isRegularFile(exec: GcExec, path: string): boolean {
  return probe(exec, ["test", "-f", path]);
}

function isSymlink(exec: GcExec, path: string): boolean {
  return probe(exec, ["test", "-L", path]);
}

/** `fsize` (:51-55) — `stat` without following symlinks. `null` when unreadable. */
function sizeBytes(exec: GcExec, path: string): number | null {
  const result = run(exec, ["stat", "-f", "%z", path], PROBE_TIMEOUT_MS);
  if (!succeeded(result)) return null;
  const text = result.stdout.trim();
  return isUint(text) ? Number(text) : null;
}

/** `fmtime` (:55) — the mtime in epoch seconds. `null` when unreadable. */
function mtimeSeconds(exec: GcExec, path: string): number | null {
  const result = run(exec, ["stat", "-f", "%m", path], PROBE_TIMEOUT_MS);
  if (!succeeded(result)) return null;
  const text = result.stdout.trim();
  return isUint(text) ? Number(text) : null;
}

/** `du_kb` (:821): `du -skP -- <path> | awk '{print $1}'`. */
function duKb(exec: GcExec, path: string): number | null {
  const result = run(exec, ["du", "-skP", "--", path], DU_TIMEOUT_MS);
  if (!succeeded(result)) return null;
  const field = result.stdout.trim().split(/\s+/)[0] ?? "";
  return isUint(field) ? Number(field) : null;
}

/**
 * `count_files` (:822): `find <path> -type f | wc -l`.
 *
 * `wc -l` counts newlines, so that is what is counted here: a trailing partial line (a path
 * ending in a newline of its own) is not a file the reference counted either.
 */
function countFiles(exec: GcExec, path: string): number | null {
  const result = run(exec, ["find", path, "-type", "f"], FIND_TIMEOUT_MS);
  if (!succeeded(result)) return null;
  return (result.stdout.match(/\n/g) ?? []).length;
}

/** A `find … -print0` scan: the NUL-separated paths, or `null` when the scan failed. */
function findPaths(exec: GcExec, argv: readonly string[], timeoutMs: number): string[] | null {
  const result = run(exec, argv, timeoutMs);
  if (!succeeded(result)) return null;
  return result.stdout.split("\u0000").filter((path) => path.length > 0);
}

/** `base` (:201): the last `/`-separated segment, for a token that may have none. */
function baseName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/** `age_days` (:827): whole days, floored, and a future mtime reads as 0. */
function ageDays(exec: GcExec, path: string, now: number): number {
  const mtime = mtimeSeconds(exec, path);
  if (mtime === null) return 0;
  const days = Math.floor((now - mtime) / 86400);
  return days < 0 ? 0 : days;
}

/** `printf '%s' "$out" | grep -c .` — non-empty lines, which `$(…)` has already de-newlined. */
function nonEmptyLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) if (line.length > 0) count += 1;
  return count;
}

/**
 * `git_state` (:828-834): `dirty=<n> unpushed=<n|no-upstream>`, or a sentence saying why the
 * answer is unknown.
 *
 * The two protective arms are the point of the function. A directory that is not there (or is a
 * symlink, which the reference refuses to follow) is `missing`; a `git status` that fails — no
 * git, no repository, a permissions error, a 15 s timeout — is `unknown (git status failed)`.
 * Neither ever reports `dirty=0`, because a directory whose state cannot be read must never look
 * clean to the operator reading the report.
 */
export function gitState(exec: GcExec, dir: string): string {
  if (!isDirectory(exec, dir) || isSymlink(exec, dir)) return "missing";
  const status = run(exec, ["git", "-C", dir, "status", "--porcelain"], GIT_TIMEOUT_MS);
  if (!succeeded(status)) return "unknown (git status failed)";
  const upstream = run(
    exec,
    ["git", "-C", dir, "rev-list", "--count", "@{u}..HEAD"],
    GIT_TIMEOUT_MS,
  );
  const unpushed = succeeded(upstream) ? upstream.stdout.trim() : "no-upstream";
  return `dirty=${nonEmptyLines(status.stdout)} unpushed=${unpushed}`;
}

// ---------------------------------------------------------------------------
// Transcripts (slp-gc.bash:795-809)
// ---------------------------------------------------------------------------

/**
 * One transcript row (:808): the file, its size, the session it belongs to and — after
 * `buildReport`'s join — the agent that owns that session.
 */
export interface TranscriptRow {
  /** `fsize` of the `.jsonl` file, in bytes. */
  bytes: number;
  path: string;
  /** The file's stem: `split("/") | last | sub("\\.jsonl$"; "")`. */
  sessionId: string;
  /**
   * `$bySess[.sessionId]` (:880, :884) — `state` is `archived` when the record carries
   * `archivedAt`, else `live`. `null` when no record names the session.
   */
  agent?: { id: string; state: string; provider: string } | null;
}

export interface TranscriptOptions {
  /** `$HOME`. */
  home: string;
  /** `$CLAUDE_CONFIG_DIR`, when the environment carries one (:797). */
  claudeConfigDir?: string | null;
  /** `SLP_GC_TRANSCRIPT_MIN_KB`, default 512 (:796). */
  minKb?: number;
  /** `head -n 15` (:807). */
  limit?: number;
}

/** The `~/.config/slp-room/claude-*` dirs the reference also scans (:799). */
function slpRoomClaudeDirs(exec: GcExec, home: string): string[] {
  const base = join(home, ".config/slp-room");
  if (!isDirectory(exec, base)) return [];
  const paths =
    findPaths(
      exec,
      ["find", base, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-name", "claude-*", "-print0"],
      FIND_TIMEOUT_MS,
    ) ?? [];
  // A shell glob expands in name order; `find` answers in directory order.
  return paths.sort(compareStrings);
}

/**
 * `collect_transcripts` (:795-809): every `<dir>/projects/<project>/<sessionId>.jsonl` above the
 * size floor, largest first, fifteen of them.
 *
 * The three source directories are the reference's: `$CLAUDE_CONFIG_DIR` when set, `~/.claude`,
 * and every `~/.config/slp-room/claude-*`. A directory that is not there is skipped, which is how
 * a machine without Claude Code answers an empty list rather than an error.
 *
 * Ordering is `sort -rn` followed by `awk '!seen[$0]++'` and `head`, so: numeric descending by
 * size, ties broken by the reversed byte order of the whole line (which the path decides), then
 * de-duplicated by line — which for real files means by path, and is why a `CLAUDE_CONFIG_DIR`
 * equal to `~/.claude` cannot list a file twice.
 */
export function collectTranscripts(exec: GcExec, options: TranscriptOptions): TranscriptRow[] {
  const minKb = options.minKb ?? TRANSCRIPT_MIN_KB;
  const limit = options.limit ?? TRANSCRIPT_LIMIT;

  const dirs: string[] = [];
  const configDir = options.claudeConfigDir;
  if (typeof configDir === "string" && configDir !== "") dirs.push(configDir);
  dirs.push(join(options.home, ".claude"));
  dirs.push(...slpRoomClaudeDirs(exec, options.home));

  const found: TranscriptRow[] = [];
  for (const dir of dirs) {
    const projects = join(dir, "projects");
    if (!isDirectory(exec, projects)) continue;
    const paths = findPaths(
      exec,
      [
        "find",
        projects,
        "-mindepth",
        "2",
        "-maxdepth",
        "2",
        "-type",
        "f",
        "-name",
        "*.jsonl",
        "-size",
        `+${minKb}k`,
        "-print0",
      ],
      FIND_TIMEOUT_MS,
    );
    // A scan that failed (no permission, a timeout) contributes no rows: `2>/dev/null` plus the
    // `[ -d ]` gate is the reference's own answer.
    if (paths === null) continue;
    for (const path of paths) {
      // `is_uint "$size" && printf` — a file whose size cannot be read is dropped, not zeroed.
      const bytes = sizeBytes(exec, path);
      if (bytes === null) continue;
      found.push({ bytes, path, sessionId: sessionIdOf(path) });
    }
  }

  found.sort((left, right) =>
    left.bytes !== right.bytes
      ? right.bytes - left.bytes
      : compareStrings(right.path, left.path),
  );

  const rows: TranscriptRow[] = [];
  const seen = new Set<string>();
  for (const row of found) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/** `split("/") | last | sub("\\.jsonl$"; "")` (:808). */
function sessionIdOf(path: string): string {
  const name = baseName(path);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}

// ---------------------------------------------------------------------------
// Daemon self-metrics (slp-gc.bash:811-817)
// ---------------------------------------------------------------------------

/**
 * One `ws_runtime_metrics` sample (:815). Every field is passed through as the daemon wrote it:
 * the report is evidence about the daemon, so the port does not normalise timestamps or units.
 */
export interface DaemonMetricRow {
  /** The log record's `time` (epoch milliseconds). */
  time: unknown;
  pid: unknown;
  /** `memory.rss`. */
  rss: unknown;
  /** `memory.heapUsed`. */
  heapUsed: unknown;
  /** `agents.timelineStats`, printed with `tojson` by the text report (:946). */
  timelineStats: unknown;
}

export interface DaemonMetricsOptions {
  /** `$PHOME`. */
  home: string;
}

/**
 * `collect_metrics` (:811-817): the last three `ws_runtime_metrics` records in `daemon.log`.
 *
 * The log is held open by the Supervisor, so only its last 3 MB are read, and only when it is a
 * regular file that is not a symlink — a symlinked `daemon.log` is not evidence about this home.
 *
 * A line that is not JSON is skipped (`fromjson?`), and so is a JSON line that is not a metrics
 * record. The reference's `jq` would abort the *whole* run on a line whose shape it cannot index
 * (`"42".msg`); skipping it is the protective answer here, and the only divergence: one malformed
 * line costs at most its own sample instead of the section.
 */
export function collectDaemonMetrics(
  exec: GcExec,
  options: DaemonMetricsOptions,
): DaemonMetricRow[] {
  const path = join(options.home, "daemon.log");
  if (!isRegularFile(exec, path) || isSymlink(exec, path)) return [];

  const tail = run(exec, ["tail", "-c", String(DAEMON_LOG_TAIL_BYTES), path], TAIL_TIMEOUT_MS);
  if (!succeeded(tail)) return [];

  const rows: DaemonMetricRow[] = [];
  for (const line of tail.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // `fromjson?`
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.msg !== "ws_runtime_metrics") continue;
    const memory = asRecord(record.memory);
    const agents = asRecord(record.agents);
    rows.push({
      time: record.time ?? null,
      pid: record.pid ?? null,
      rss: memory?.rss ?? null,
      heapUsed: memory?.heapUsed ?? null,
      timelineStats: agents?.timelineStats ?? null,
    });
  }

  return rows.slice(-DAEMON_METRIC_SAMPLES);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Retention data (slp-gc.bash:835-872)
// ---------------------------------------------------------------------------

/** One retention row — `ret()`'s object (:823-826), field for field. */
export interface RetentionRow {
  /** `home-entry` / `log` / `config-backup` / a daemon-owned dir name / `paseo-worktree` / `other-worktree`. */
  cat: string;
  path: string;
  /** `du -sk` kilobytes, or 0 when the size could not be read. */
  kb: number;
  /** Files in the entry, or 0/1 as the reference counts them. */
  count: number;
  note: string;
}

export interface RetentionOptions {
  /** `$PHOME`. */
  home: string;
  /** `$NOW` in epoch seconds — the only clock `age_days` reads (:827). */
  now: number;
  /**
   * `.[] | select(.ok and .archivedAt == null and .cwd != null) | .cwd` (:867) — the cwds of the
   * agents that are still live, from the agent index the caller already parsed.
   *
   * The reference reads `$T/agents.json` itself; the port takes the values, because the index is
   * an input of this module's caller (task 12). Deduplication, sorting and the 30-row cap are
   * applied here, exactly as the reference's `sort -u | head -n 30`.
   */
  liveAgentCwds?: readonly string[];
}

/** The daemon-owned directories the reference reports (:853). */
const DAEMON_DIRS: readonly string[] = ["agent-requests", "creations", "uploads", "desktop-attachments"];

/** The three globs of :845 (`daemon.log`, `daemon.log.*`, `*-daemon.log`), in that order. */
const LOG_NAME_PATTERNS: readonly RegExp[] = [
  /^daemon\.log$/,
  /^daemon\.log\..*$/,
  /^.*-daemon\.log$/,
];

/** `config.json.bak*` (:849). */
const CONFIG_BACKUP_NAME = /^config\.json\.bak.*$/;

/**
 * `collect_retention` (:835-872): where the bytes are, report-only.
 *
 * Six categories, in the reference's order:
 *
 * | cat | What | Reference |
 * |---|---|---|
 * | `home-entry` | every top-level entry of the home, not following symlinks | :839-844 |
 * | `log` | `daemon.log`, `daemon.log.*`, `*-daemon.log` | :845-848 |
 * | `config-backup` | `config.json.bak*` — never read, they may hold a token | :849-852 |
 * | `<dir>` | `agent-requests`, `creations`, `uploads`, `desktop-attachments` | :853-856 |
 * | `paseo-worktree` | `worktrees/<hash>/<name>`, with a `git_state` per worktree | :857-865 |
 * | `other-worktree` | a live agent's cwd outside the Paseo tree — never garbage | :866-871 |
 *
 * Nothing here has a reclaim path in this version: every `note` says `report-only`, which is the
 * reference's own wording.
 *
 * Degradations, all of them protective: a `du` or `find` that fails gives `kb: 0` / `count: 0`; an
 * entry whose liveness cannot be established is skipped; a failed home scan yields no
 * `home-entry`, `log` or `config-backup` rows (the log and backup rows are matched against the
 * home listing, which is the same set the reference's globs expand to). No path can be lost in a
 * way that makes something look smaller than it is, and nothing in this section can be deleted.
 */
export function collectRetention(exec: GcExec, options: RetentionOptions): RetentionRow[] {
  const home = options.home;
  const now = options.now;
  const rows: RetentionRow[] = [];

  // `find "$PHOME" -mindepth 1 -maxdepth 1 -print0` (:839). One listing serves the first three
  // categories: the shell globs of :845 and :849 expand to names in exactly this directory.
  const entries =
    findPaths(exec, ["find", home, "-mindepth", "1", "-maxdepth", "1", "-print0"], DU_TIMEOUT_MS) ??
    [];

  // --- home-entry (:839-844)
  for (const entry of entries) {
    const link = isSymlink(exec, entry);
    const kb = link ? 0 : (duKb(exec, entry) ?? 0);
    const count = !link && isDirectory(exec, entry) ? (countFiles(exec, entry) ?? 0) : 0;
    rows.push({
      cat: "home-entry",
      path: entry,
      kb,
      count,
      note: link ? "symlink (not followed)" : "report-only: no Paseo CLI path",
    });
  }

  // --- log (:845-848). One row per (pattern, file) pair, in glob order, as the reference emits.
  for (const pattern of LOG_NAME_PATTERNS) {
    for (const path of matchingEntries(entries, pattern)) {
      if (!isRegularFile(exec, path) || isSymlink(exec, path)) continue;
      rows.push({
        cat: "log",
        path,
        kb: Math.floor((sizeBytes(exec, path) ?? 0) / 1024),
        count: 1,
        note: `age ${ageDays(exec, path, now)} d; report-only (daemon.log is held open by the Supervisor)`,
      });
    }
  }

  // --- config-backup (:849-852). Never read: the file may hold a token.
  for (const path of matchingEntries(entries, CONFIG_BACKUP_NAME)) {
    if (!isRegularFile(exec, path) || isSymlink(exec, path)) continue;
    rows.push({
      cat: "config-backup",
      path,
      kb: Math.floor((sizeBytes(exec, path) ?? 0) / 1024),
      count: 1,
      note: `age ${ageDays(exec, path, now)} d; may hold a token: never read; report-only`,
    });
  }

  // --- the daemon-owned directories (:853-856)
  for (const name of DAEMON_DIRS) {
    const path = join(home, name);
    if (!isDirectory(exec, path) || isSymlink(exec, path)) continue;
    rows.push({
      cat: name,
      path,
      kb: duKb(exec, path) ?? 0,
      count: countFiles(exec, path) ?? 0,
      note: "daemon-owned; report-only (no CLI path)",
    });
  }

  // --- Paseo worktrees (:857-865): worktrees/<project-hash>/<name>
  const worktrees = join(home, "worktrees");
  if (isDirectory(exec, worktrees) && !isSymlink(exec, worktrees)) {
    const projects =
      findPaths(
        exec,
        ["find", worktrees, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print0"],
        FIND_TIMEOUT_MS,
      ) ?? [];
    for (const project of projects) {
      const listing = run(exec, ["ls", "-A", project], PROBE_TIMEOUT_MS);
      // `[ -z "$(ls -A …)" ]` is true for an empty directory *and* for a failed `ls`, which
      // answers empty here too — so an unreadable project dir reads as empty rather than as a
      // worktree whose state was checked (the reference's own answer).
      if (listing.stdout.trim() === "") {
        rows.push({
          cat: "paseo-worktree",
          path: project,
          kb: 0,
          count: 0,
          note: "empty project-hash dir; report-only",
        });
        continue;
      }
      const children =
        findPaths(
          exec,
          ["find", project, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print0"],
          FIND_TIMEOUT_MS,
        ) ?? [];
      for (const child of children) {
        rows.push({
          cat: "paseo-worktree",
          path: child,
          kb: duKb(exec, child) ?? 0,
          count: 1,
          note: `${gitState(exec, child)}; report-only (paseo worktree archive is a follow-up)`,
        });
      }
    }
  }

  // --- a live agent's cwd outside the Paseo tree (:866-871): never garbage
  const worktreesPrefix = `${home.replace(/\/+$/, "")}/worktrees/`;
  const cwds = uniqueSorted(options.liveAgentCwds ?? []).slice(0, OTHER_WORKTREE_LIMIT);
  for (const cwd of cwds) {
    if (cwd.startsWith(worktreesPrefix)) continue;
    if (!isDirectory(exec, cwd) || isSymlink(exec, cwd)) continue;
    rows.push({
      cat: "other-worktree",
      path: cwd,
      kb: 0,
      count: 1,
      note: `live agent cwd: ${gitState(exec, cwd)}; never garbage`,
    });
  }

  return rows;
}

/** The entries whose *name* matches a shell glob, in name order (how a glob expands). */
function matchingEntries(entries: readonly string[], pattern: RegExp): string[] {
  return entries.filter((path) => pattern.test(baseName(path))).sort(compareStrings);
}

/** Byte order, which is what `sort`/`sort -u` and jq's own string order both use. */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// The report's shape (ASSEMBLE_JQ, slp-gc.bash:879-884, plus `report --json` :1351)
// ---------------------------------------------------------------------------

/** One class total — `$P.totals[]` (:475). */
export interface ClassTotal {
  class: string;
  n: number;
  footprint_mb: number;
  rss_mb: number;
  cmprs_mb: number;
}

/** `$P.overall` (:476). */
export interface OverallTotal {
  n: number;
  footprint_mb: number;
  rss_mb: number;
}

/**
 * One row of the tree's per-agent table (:457-462), and of the test-runner table (:463-465):
 * the reference builds the second as a filter of the first, so they share a shape.
 */
export interface ReportTreeRow {
  pid: number;
  class: string;
  /** `$a.owner // ("pid:" + pid + "@" + lstart)`. */
  owner: string;
  n: number;
  footprint_mb: number;
  testWorkers: number;
  testMb: number;
}

/** `$P.tree.tests` (:465). */
export interface ReportTreeTests {
  agents: number;
  warnAt: number;
  over: boolean;
  rows: ReportTreeRow[];
}

/** `$P.tree` (:469-472): the app's memory tree, reported and never acted on. */
export interface ReportTree {
  totalMb: number;
  appMb: number;
  orphanMb: number;
  orphanN: number;
  warnMb: number;
  ramMb: number;
  over: boolean;
  /** The identified daemon and its footprint; `identified` is the reference's own crumb. */
  daemon: { pid: number; footprint_mb: number; identified?: boolean } | null;
  agents: ReportTreeRow[];
  tests: ReportTreeTests;
}

/** The tree as a caller supplies it: any subset, filled in from the empty tree. */
export type ReportTreeInput = Partial<Omit<ReportTree, "agents" | "tests">> & {
  agents?: readonly ReportTreeRow[];
  tests?: Partial<ReportTreeTests>;
};

/**
 * A process row as the caller has it: the port's `ProcEntry` (with `cmd`) plus the two decisions
 * the reference attaches after classification (:375). `cmd` is optional because the report strips
 * it (:1351) — a caller may hand in either shape.
 */
export interface ReportProcInput extends Omit<ProcEntry, "cmd"> {
  cmd?: string;
  /** `$P.procs[].stale`; absent reads as a refusal with no sentence. */
  stale?: Decision;
  /** `$P.procs[].overmem`; absent reads as a refusal with no sentence. */
  overmem?: Decision;
}

/** A process row as the report carries it: no `cmd`, both decisions present. */
export type ReportProcRow = Omit<ReportProcInput, "cmd"> & { stale: Decision; overmem: Decision };

/** An orphan row as the caller has it (`OrphanEntry`, whose `cmd` the report strips). */
export type ReportOrphanInput = Omit<OrphanEntry, "cmd" | "hint"> & {
  cmd?: string;
  /**
   * The reference's placeholder for a future remediation (:432), which every row the port
   * produces leaves `null`. It is widened to `string` here because the text report already knows
   * how to print one (`hint (never proof): cwd …`, :956) and the row type must not be the reason a
   * caller cannot exercise it.
   */
  hint?: string | null;
};

/** An orphan row as the report carries it. */
export type ReportOrphanRow = Omit<ReportOrphanInput, "cmd">;

/** The `procs` section of the report (fixture keys, in fixture order). */
export interface ReportProcs {
  ident: Identity;
  unreadableRows: number;
  procs: ReportProcRow[];
  orphans: ReportOrphanRow[];
  /** `$ledgerNext` (:467): the ledger the *record* tick should write back, or null. */
  ledgerNext: unknown;
  ledgerNote: string;
  ledgerDropped: number;
  tree: ReportTree;
  /** `$procs.envBlind` (:474): the agent-family pids whose environment could not be read. */
  envBlind: number[];
  totals: ClassTotal[];
  overall: OverallTotal;
  warnMb: number;
  killMb: number;
}

/** The `procs` section as a caller supplies it; everything but `ident` is optional. */
export interface ReportProcsInput {
  /** `$idt` (:327-339). Only `ok`/`why` are required: the rest default fail-closed. */
  ident: Partial<Identity> & { ok: boolean; why: string };
  procs?: readonly ReportProcInput[];
  orphans?: readonly ReportOrphanInput[];
  /** `$badrows | length` (:468). */
  unreadableRows?: number;
  ledgerNext?: unknown;
  ledgerNote?: string;
  ledgerDropped?: number;
  tree?: ReportTreeInput;
  envBlind?: readonly number[];
  /** Overrides the derived class totals (:475). */
  totals?: readonly ClassTotal[];
  /** Overrides the derived overall totals (:476). */
  overall?: OverallTotal;
  warnMb?: number;
  killMb?: number;
}

/** One agent row (`$agentRows`, :495-522). */
export interface ReportAgentRow {
  /** Defaulted to `"agent"` by assembly, so a row can never lose its section. */
  category?: "agent";
  path: string;
  id: string | null;
  /** `live` / `archived` / `closed-unarchived` / `unreadable` (:491-502). */
  state: string;
  garbage: boolean;
  reason: string;
  /**
   * The reference's `action` (`"none"`, or a `paseo … delete …` command). Never `null`: a row the
   * rules refused gets the reference's own sentence, exactly as `$agentRows` sets it (:503-519).
   */
  action: string;
}

/** One schedule row (`$schedRows`, :523-548). */
export interface ReportScheduleRow {
  category?: "schedule";
  path: string;
  /** The record file's size in bytes (`size`), printed with `bytes` (:971). */
  size: number;
  ok: boolean;
  id: string | null;
  name: string | null;
  status: string;
  strict: boolean;
  targetType: string;
  targetAgent: string | null;
  /** `.cadence.expression // (.cadence.type + ":" + …)`, or null (:244). */
  cadence: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  updatedEpoch: number | null;
  lastRunAt: string | null;
  lastRunEpoch: number | null;
  nextRunAt: string | null;
  /** The room marker (:248). */
  room: boolean;
  runs: number;
  runsRunning: number;
  fires1h: number;
  fires24h: number;
  fail24h: number;
  activeRunFail24h: number;
  /** `astate` of the target agent, or `"n/a"` (:528-529). */
  targetState: string;
  garbage: boolean;
  reason: string;
  /** The reference's `action`, never `null` (:530-547); the anomaly row keeps its own sentence. */
  action: string;
  /** Set on the report-only anomaly row (:546). */
  anomaly?: boolean;
}

/** The `agents` section (`{agents: …}`, :549-556). */
export interface ReportAgents {
  total: number;
  live: number;
  archived: number;
  closedUnarchived: number;
  unreadable: number;
  trusted: boolean;
  rows: ReportAgentRow[];
}

/**
 * The `agents` section as a caller supplies it: the rows alone (the counts are derived), or the
 * summary with any of its counts already known.
 */
export type ReportAgentsInput =
  | readonly ReportAgentRow[]
  | (Partial<Omit<ReportAgents, "rows">> & { rows?: readonly ReportAgentRow[] });

/** One garbage candidate as the report carries it (`$ev[0].garbage | map(. + {sig})`, :883). */
export interface ReportGarbageRow {
  category: "agent" | "schedule";
  id: string;
  path: string;
  /** `inode:size:mtime` taken right after the decision (:883, :893-897); `""` = unverified. */
  sig: string;
  rule: GarbageRule;
  /** The reference's `GARBAGE: …` sentence. */
  reason: string;
  /** `paseo agent delete …` / `paseo schedule delete …`; `"none"` when the row carries none. */
  action: string;
}

/** The report — the fixture's eleven top-level keys, in its order, `version: 1`. */
export interface GcReport {
  version: 1;
  generated: string;
  home: string;
  procs: ReportProcs;
  agents: ReportAgents;
  schedules: ReportScheduleRow[];
  index: { ok: boolean; why: string[] };
  garbage: ReportGarbageRow[];
  transcripts: TranscriptRow[];
  daemonMetrics: DaemonMetricRow[];
  retention: RetentionRow[];
}

/** Everything `buildReport` reads. No I/O, no clock: `now` is a value, not a call. */
export interface BuildReportInput {
  /** `$NOW`, epoch seconds. Used only when `generated` is absent. */
  now: number;
  /** `iso_now` (:48, :904). */
  generated?: string;
  /** `$PHOME`. */
  home: string;
  procs: ReportProcsInput;
  agents: ReportAgentsInput;
  schedules?: readonly ReportScheduleRow[];
  /** `$ev[0].index` (:882). */
  index: { ok: boolean; why?: readonly string[] };
  /**
   * `$ev[0].garbage` (:883) — every candidate the rules judged. Only the eligible ones
   * (`refusedBy === null`) reach the report, which is the reference's `map(select(.garbage))`
   * (:557); pass the whole list, or the filtered one, and the report says the same thing.
   */
  garbage?: readonly GarbageCandidate[];
  /** `$tr` (:884): the collector's rows. */
  transcripts?: readonly TranscriptRow[];
  /** `$met` (:884): the collector's rows. */
  daemonMetrics?: readonly DaemonMetricRow[];
  /** `$ret` (:884): the collector's rows. */
  retention?: readonly RetentionRow[];
  /** `$warnMb`: `SLP_GC_MEM_WARN_MB`, when the procs section does not carry its own. */
  warnMb?: number;
  /** `$killMb`: `SLP_GC_MEM_KILL_MB`, when the procs section does not carry its own. */
  killMb?: number;
  /**
   * `$sigBy` (:883): the fresh `inode:size:mtime` of each candidate path, taken right after the
   * decision. When a path is absent the candidate's own `sig` is kept — which is `""` for a
   * candidate that was never statted, and `""` must be refused by whoever acts on it.
   *
   * (The reference writes `null` for an absent signature; `""` is this port's zero value for
   * "unverified", and both mean the same thing to an action step.)
   */
  sigs?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /**
   * `$ag[0]` (:880): the agent index, for the transcript join. When supplied, every transcript's
   * `agent` is resolved from it — last record wins, as `from_entries` does — so a session the
   * index does not name reads `null`. When absent, the transcripts keep whatever `agent` they
   * arrived with.
   */
  agentRecords?: readonly AgentRec[];
}

/** `iso_now` (:48): `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function isoUtc(now: number): string {
  return new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `mb1` (:202): one decimal, jq's `round` (away from zero) on the scaled value. */
function mb1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * `totals` (:475): `group_by(.class)` — classes in name order — with `mb1` on each sum.
 *
 * The sums fold in row order, as jq's `add` does, so the one-decimal rounding lands on the same
 * value the reference prints (the fixture's totals are reproduced exactly).
 */
function classTotals(procs: readonly ReportProcRow[]): ClassTotal[] {
  const groups = new Map<string, ReportProcRow[]>();
  for (const row of procs) {
    const key = String(row.class);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups.keys()].sort(compareStrings).map((key) => {
    const rows = groups.get(key) ?? [];
    return {
      class: key,
      n: rows.length,
      footprint_mb: mb1(rows.reduce((sum, row) => sum + row.footprint_mb, 0)),
      rss_mb: mb1(rows.reduce((sum, row) => sum + row.rss_mb, 0)),
      cmprs_mb: mb1(rows.reduce((sum, row) => sum + (row.cmprs_mb ?? 0), 0)),
    };
  });
}

/** `overall` (:476). */
function overallTotals(procs: readonly ReportProcRow[]): OverallTotal {
  return {
    n: procs.length,
    footprint_mb: mb1(procs.reduce((sum, row) => sum + row.footprint_mb, 0)),
    rss_mb: mb1(procs.reduce((sum, row) => sum + row.rss_mb, 0)),
  };
}

/** The empty tree: every scalar zero, no daemon, no rows (:790's failure shape). */
function emptyTree(): ReportTree {
  return {
    totalMb: 0,
    appMb: 0,
    orphanMb: 0,
    orphanN: 0,
    warnMb: 0,
    ramMb: 0,
    over: false,
    daemon: null,
    agents: [],
    tests: { agents: 0, warnAt: 0, over: false, rows: [] },
  };
}

function normalizeTree(input: ReportTreeInput | undefined): ReportTree {
  const base = emptyTree();
  if (input === undefined) return base;
  return {
    totalMb: input.totalMb ?? base.totalMb,
    appMb: input.appMb ?? base.appMb,
    orphanMb: input.orphanMb ?? base.orphanMb,
    orphanN: input.orphanN ?? base.orphanN,
    warnMb: input.warnMb ?? base.warnMb,
    ramMb: input.ramMb ?? base.ramMb,
    over: input.over ?? base.over,
    daemon: input.daemon ?? base.daemon,
    agents: [...(input.agents ?? [])],
    tests: { ...base.tests, ...(input.tests ?? {}), rows: [...(input.tests?.rows ?? [])] },
  };
}

/**
 * `$idt` (:327-339), filled in fail-closed: an identification the caller only half described is
 * never a successful one, and `supHome` defaults to `unreadable` rather than `match`.
 */
function normalizeIdentity(input: Partial<Identity> & { ok: boolean; why: string }): Identity {
  return {
    pidFile: input.pidFile ?? false,
    supervisor: input.supervisor ?? false,
    daemon: input.daemon ?? false,
    listener: input.listener ?? false,
    supervisorPid: input.supervisorPid ?? null,
    daemonPid: input.daemonPid ?? null,
    appPid: input.appPid ?? null,
    supHome: input.supHome ?? ("unreadable" as HomeState),
    listen: input.listen ?? null,
    homeBound: input.homeBound ?? false,
    ok: input.ok === true,
    why: input.why,
  };
}

/** `del(.procs.procs[].cmd, .procs.orphans[].cmd)` (:1351): the report never carries a command. */
function dropCmd<T extends { cmd?: string }>(row: T): Omit<T, "cmd"> {
  const copy: T = { ...row };
  delete copy.cmd;
  return copy;
}

function normalizeProcs(input: BuildReportInput): ReportProcs {
  const source = input.procs;
  const procs: ReportProcRow[] = (source.procs ?? []).map((row) => ({
    ...dropCmd(row),
    stale: row.stale ?? { eligible: false, why: "" },
    overmem: row.overmem ?? { eligible: false, why: "" },
  }));
  return {
    ident: normalizeIdentity(source.ident),
    unreadableRows: source.unreadableRows ?? 0,
    procs,
    orphans: (source.orphans ?? []).map(dropCmd),
    ledgerNext: source.ledgerNext ?? null,
    ledgerNote: source.ledgerNote ?? "",
    ledgerDropped: source.ledgerDropped ?? 0,
    tree: normalizeTree(source.tree),
    // `$procs.envBlind` (:474): the agent-family rows whose environment could not be read.
    envBlind: [
      ...(source.envBlind ??
        procs.filter((row) => isAgentFamily(row.class) && !row.envRead).map((row) => row.pid)),
    ],
    totals: [...(source.totals ?? classTotals(procs))],
    overall: source.overall ?? overallTotals(procs),
    warnMb: source.warnMb ?? input.warnMb ?? 0,
    killMb: source.killMb ?? input.killMb ?? 0,
  };
}

function normalizeAgents(input: ReportAgentsInput): ReportAgents {
  // `Array.isArray` does not narrow a `readonly T[]` union, so the two shapes are cast once here.
  const rowsOnly = Array.isArray(input);
  const section = input as Partial<Omit<ReportAgents, "rows">> & {
    rows?: readonly ReportAgentRow[];
  };
  const sourceRows: readonly ReportAgentRow[] = rowsOnly
    ? (input as readonly ReportAgentRow[])
    : (section.rows ?? []);
  const supplied: Partial<Omit<ReportAgents, "rows">> = rowsOnly ? {} : section;
  const rows: ReportAgentRow[] = sourceRows.map((row) => ({
    ...row,
    category: row.category ?? "agent",
  }));
  const countState = (state: string): number => rows.filter((row) => row.state === state).length;
  return {
    // `total: ($agents | length)` (:550): every record, including the ones that did not parse.
    total: supplied.total ?? rows.length,
    live: supplied.live ?? countState("live"),
    archived: supplied.archived ?? countState("archived"),
    closedUnarchived: supplied.closedUnarchived ?? countState("closed-unarchived"),
    unreadable: supplied.unreadable ?? countState("unreadable"),
    // `$trusted` (:484): at least one record parsed. A run of nothing but unreadable rows is not
    // a trusted index, which is what stops `missing` from being read off it.
    trusted: supplied.trusted ?? rows.some((row) => row.state !== "unreadable"),
    rows,
  };
}

/** `$ev[0].garbage | map(. + {sig: $sigBy[.path]})` (:883), filtered to the eligible rows. */
function garbageRows(input: BuildReportInput): ReportGarbageRow[] {
  const rows: ReportGarbageRow[] = [];
  for (const candidate of input.garbage ?? []) {
    if (candidate.refusedBy !== null) continue;
    rows.push({
      category: candidate.kind,
      id: candidate.id,
      path: candidate.path,
      sig: signatureOf(input.sigs, candidate.path) ?? candidate.sig,
      rule: candidate.rule,
      reason: candidate.reason,
      action: candidate.action ?? "none",
    });
  }
  return rows;
}

function signatureOf(
  sigs: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
  path: string,
): string | undefined {
  if (sigs === undefined) return undefined;
  if (typeof (sigs as ReadonlyMap<string, string>).get === "function") {
    return (sigs as ReadonlyMap<string, string>).get(path);
  }
  const record = sigs as Readonly<Record<string, string>>;
  return Object.hasOwn(record, path) ? record[path] : undefined;
}

/** `($tr | map(. + {agent: $bySess[.sessionId]}))` (:880, :884). */
function transcriptRows(input: BuildReportInput): TranscriptRow[] {
  const rows = input.transcripts ?? [];
  if (input.agentRecords === undefined) {
    return rows.map((row) => ({ ...row, agent: row.agent ?? null }));
  }
  // `($okA … | map({key: .sessionId, value: …}) | from_entries)` — the last record wins.
  const bySession = new Map<string, { id: string; state: string; provider: string }>();
  for (const record of input.agentRecords) {
    if (record.sessionId === null) continue;
    bySession.set(record.sessionId, {
      id: record.id,
      state: record.archivedAt !== null ? "archived" : "live",
      provider: record.provider,
    });
  }
  return rows.map((row) => ({ ...row, agent: bySession.get(row.sessionId) ?? null }));
}

/**
 * Assemble the report (`ASSEMBLE_JQ`, :879-884; the JSON printer's `del`, :1351).
 *
 * Pure: every value it reads is an input, including the clock (`now`) and every collector's
 * output. It emits the fixture's eleven keys in the fixture's order and nothing else; the two
 * derivations it performs (`totals`/`overall`, and the agent counts) are the reference's own jq
 * reductions, reproduced exactly, and both can be overridden by a caller that already has them.
 *
 * The three things it *removes* are as load-bearing as what it adds:
 *
 * - `cmd` from every process and orphan row (:1351) — see the file header;
 * - every non-eligible garbage candidate (:557) — a refused row can never be counted as garbage;
 * - any `undefined` a caller left behind, because every field is materialised with a default.
 */
export function buildReport(input: BuildReportInput): GcReport {
  return {
    version: 1,
    generated: input.generated ?? isoUtc(input.now),
    home: input.home,
    procs: normalizeProcs(input),
    agents: normalizeAgents(input.agents),
    schedules: (input.schedules ?? []).map((row) => ({
      ...row,
      category: row.category ?? ("schedule" as const),
    })),
    index: { ok: input.index.ok === true, why: [...(input.index.why ?? [])] },
    garbage: garbageRows(input),
    transcripts: transcriptRows(input),
    daemonMetrics: [...(input.daemonMetrics ?? [])],
    retention: [...(input.retention ?? [])],
  };
}
