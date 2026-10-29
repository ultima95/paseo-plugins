// The lineage ledger — the reference tool's proof source for orphaned agent
// descendants (`docs/gc-port/slp-gc.bash`).
//
// The ledger answers one question only: "was this ppid-1 process already seen
// as a descendant of a known agent, at this exact start time?" A row is proof
// only if it is well-formed, so the reference validates every row on every read
// and drops (and counts) the rest:
//
//   validateLedger   slp-gc.bash:379-386 — the six predicates of the
//                    `$ledgerRaw | map(select(...))` block, plus `$ledgerDropped`
//   parseLedgerTsv   slp-gc.bash:711-712 — the tsv shape filter (`load_ledger`)
//   readLedger       slp-gc.bash:703-715 — regular file only, never a symlink,
//                    state dir `uid:700`, file `uid:600`, size <= 4 MB
//   writeLedger      slp-gc.bash:739-745 — temp file in the state dir + rename
//   nextLedger       slp-gc.bash:452-466 — `$curr + $keep + $envrows`, deduped
//                    by `[pid, lstart]`, newest first, capped
//
// Three properties matter more than tidiness:
//
// 1. Nothing here throws. A refusal is a `note` (the reference's `$LEDGER_NOTE`)
//    and an empty ledger — the tick keeps running, it just loses its proof, and
//    a lost proof means fewer kills, never more. A failed write is an `ok: false`
//    and the previous ledger stays in place.
// 2. The reader never follows a symlink: `lstat` first, then the file is opened
//    with `O_NOFOLLOW` and re-checked through the descriptor, so a link swapped
//    in between the two calls fails the open instead of being read.
// 3. The rows are proof, so the predicates are the reference's verbatim — the
//    two timestamp windows included. A row that is merely plausible is dropped.

import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One `lineage.tsv` row: pid, start time, process name, owner, first seen, orphaned-at, exe. */
export interface LedgerRow {
  pid: number;
  /** `ps`'s `lstart`, whitespace-collapsed: `Mon Oct 27 10:00:00 2026`. */
  lstart: string;
  /** The basename of the real executable (or of `argv[0]` when the exe is unknown). */
  comm: string;
  /** Either the owning agent's uuid, or `pid:<n>@<lstart>` for an agent process. */
  owner: string;
  /** Epoch seconds when this pid+start was first recorded. */
  first: number;
  /** Epoch seconds when the row was first seen as ppid 1, or 0 while it is not orphaned. */
  orphaned: number;
  /** The real executable path from `lsof`, or `""` when it could not be read. */
  exe: string;
}

/** The reference's `LEDGER_CAP` (slp-gc.bash:33). */
export const LEDGER_CAP = 5000;

/** The reference's size gate: `4194304` bytes (slp-gc.bash:710). */
export const LEDGER_MAX_BYTES = 4 * 1024 * 1024;

/** `now + 300` slack on both timestamp windows (slp-gc.bash:383-384). */
const FUTURE_SLACK_S = 300;

/** The floor on `first` (slp-gc.bash:383: `first >= 1000000000`). */
const FIRST_FLOOR = 1_000_000_000;

/** `(.exe | length) < 1024` (slp-gc.bash:385). */
const EXE_MAX_CHARS = 1024;

/**
 * The five `lstart` tokens, exactly as the reference writes the pattern
 * (slp-gc.bash:380): a 1-2 digit day, a 2-digit clock and a 4-digit year. Kept
 * as a source string so the `pid:<n>@<lstart>` owner arm (:382) is the same
 * pattern and cannot drift from it.
 */
const LSTART_SOURCE =
  "[A-Za-z]{3} [A-Za-z]{3} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}";

const LSTART_RE = new RegExp(`^${LSTART_SOURCE}$`);

/** `^[A-Za-z0-9._+-]+$` (slp-gc.bash:380). */
const COMM_RE = /^[A-Za-z0-9._+-]+$/;

/** The agent-uuid owner arm (slp-gc.bash:381): lowercase hex groups, no braces. */
const OWNER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The agent-process owner arm (slp-gc.bash:382). */
const OWNER_PID_RE = new RegExp(`^pid:[0-9]+@${LSTART_SOURCE}$`);

/** `is_uint` as the reference uses it in the tsv filter (slp-gc.bash:711). */
const UINT_RE = /^[0-9]+$/;

/**
 * The ledger's identity: a row is about a pid *and* a start time, because a
 * recycled pid is a different process. Downstream code (the orphan proof, the
 * keep rule, the dedupe) keys on exactly this string.
 */
export function ledgerKey(pid: number, lstart: string): string {
  return `${pid}|${lstart}`;
}

/**
 * Is this row proof? The six predicates of slp-gc.bash:380-385, in order:
 *
 *   1. `lstart` is the five-token ps date            (:380)
 *   2. `comm` is `[A-Za-z0-9._+-]+`                  (:380)
 *   3. `owner` is a uuid or `pid:<n>@<lstart>`       (:381-382)
 *   4. `first` is in `[1000000000, now + 300]`       (:383)
 *   5. `orphaned` is 0, or in `[first, now + 300]`   (:384)
 *   6. `exe` is empty, or absolute and < 1024 chars  (:385)
 *
 * A row that fails any one of them is not proof; it is dropped. `NaN` fails
 * every numeric comparison, which is the right answer for an unreadable stamp.
 */
function isProof(row: LedgerRow, now: number): boolean {
  const horizon = now + FUTURE_SLACK_S;
  const first = row.first;
  const orphaned = row.orphaned ?? 0;
  const exe = row.exe ?? "";
  return (
    LSTART_RE.test(row.lstart) &&
    COMM_RE.test(row.comm) &&
    (OWNER_UUID_RE.test(row.owner) || OWNER_PID_RE.test(row.owner)) &&
    first >= FIRST_FLOOR &&
    first <= horizon &&
    (orphaned === 0 || (orphaned >= first && orphaned <= horizon)) &&
    (exe === "" || (exe.startsWith("/") && exe.length < EXE_MAX_CHARS))
  );
}

/**
 * Keep only the rows that are proof, counting the rest (slp-gc.bash:379-386).
 *
 * `dropped` is the reference's `$ledgerDropped` — the report shows it, so a
 * ledger that is half junk is visible rather than silently smaller. The rows
 * that survive are returned as the same objects (they enter `nextLedger` and the
 * report unchanged).
 */
export function validateLedger(
  rows: readonly LedgerRow[],
  now: number,
): { rows: LedgerRow[]; dropped: number } {
  const kept: LedgerRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (isProof(row, now)) kept.push(row);
    else dropped += 1;
  }
  return { rows: kept, dropped };
}

/**
 * Parse `lineage.tsv` the way the reference's `jq -Rn '[inputs | split("\t") |
 * select(...)]'` does (slp-gc.bash:711-712): 5 to 7 tab-separated fields, a
 * numeric pid, a numeric `first`, and a numeric `orphaned` when the field is
 * present. `orphaned` defaults to 0 and `exe` to `""`, the reference's own
 * defaults for the short shapes.
 *
 * This is the *shape* filter only: nothing here decides whether a row is proof.
 * A line that fails the shape is skipped and not counted — `$ledgerDropped` is
 * measured against this filter's output, exactly as in the reference.
 */
export function parseLedgerTsv(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 5 || fields.length > 7) continue;
    const [rawPid, lstart, comm, owner, rawFirst, rawOrphaned] = fields;
    if (!UINT_RE.test(rawPid ?? "") || !UINT_RE.test(rawFirst ?? "")) continue;
    if (fields.length >= 6 && !UINT_RE.test(rawOrphaned ?? "")) continue;
    const pid = Number(rawPid);
    const first = Number(rawFirst);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(first)) continue;
    const orphaned = fields.length >= 6 ? Number(rawOrphaned) : 0;
    if (!Number.isSafeInteger(orphaned)) continue;
    rows.push({
      pid,
      lstart: lstart ?? "",
      comm: comm ?? "",
      owner: owner ?? "",
      first,
      orphaned,
      exe: fields.length === 7 ? (fields[6] ?? "") : "",
    });
  }
  return rows;
}

/** `fum`'s `uid:mode` answer, base 8, e.g. `501:600` (slp-gc.bash:707-709). */
function uidMode(uid: number, mode: number): string {
  return `${uid}:${mode.toString(8)}`;
}

export interface ReadLedgerOptions {
  /**
   * The uid the file and its directory must belong to. Defaults to
   * `process.getuid()`; the seam exists so a test can prove the ownership check
   * without a second account.
   */
  ownerUid?: number;
}

/** The uid both the ledger and its state dir are expected to belong to, or `null` when unknowable. */
function resolveUid(options: ReadLedgerOptions): number | null {
  if (options.ownerUid !== undefined) return options.ownerUid;
  const getuid = process.getuid;
  if (typeof getuid !== "function") return null;
  try {
    return getuid.call(process);
  } catch {
    return null;
  }
}

/** A refusal: the reference's `$LEDGER_NOTE`, plus the empty ledger it implies. */
function refuse(note: string): { rows: LedgerRow[]; note: string } {
  return { rows: [], note };
}

/**
 * Load and shape-filter the ledger (slp-gc.bash:703-715).
 *
 * Every gate is fail-closed: a refusal yields no rows and a `note` naming the
 * reason, never an exception. The gates, in the reference's order:
 *
 * - absent (`lstat` ENOENT) → empty ledger, **no note** (:706)
 * - a symlink or anything not a regular file → refused (:707)
 * - the state dir is not this uid at mode `0700` → refused (:708)
 * - the file is not this uid at mode `0600` → refused (:709)
 * - the file is larger than 4 MB (or its size is not a number) → refused (:710)
 *
 * The reference `-L`/`-f` tests the path and then hands the path to `jq`; this
 * port opens the path with `O_NOFOLLOW` and re-checks through the descriptor, so
 * a symlink that appears between the checks cannot be read either. The `note`
 * for an unreadable file names the error; the reference would leave the note
 * empty there (its `jq` failure just leaves `[]` behind) — a note is strictly
 * more useful and never changes what is accepted.
 */
export async function readLedger(
  path: string,
  options: ReadLedgerOptions = {},
): Promise<{ rows: LedgerRow[]; note: string | null }> {
  const uid = resolveUid(options);

  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { rows: [], note: null };
    return refuse(`lineage.tsv could not be inspected (${code ?? String(error)}): ignored`);
  }

  if (before.isSymbolicLink() || !before.isFile()) {
    return refuse("lineage.tsv is not a regular file (symlink or directory): ignored");
  }

  if (uid !== null) {
    let dir: Awaited<ReturnType<typeof lstat>>;
    try {
      dir = await lstat(dirname(path));
    } catch {
      return refuse(`state dir is not readable: ledger ignored`);
    }
    if (dir.uid !== uid || (dir.mode & 0o777) !== 0o700) {
      return refuse(
        `state dir is not owned by uid ${uid} with mode 0700 (is ${uidMode(dir.uid, dir.mode & 0o777)}): ledger ignored`,
      );
    }
    if (before.uid !== uid || (before.mode & 0o777) !== 0o600) {
      return refuse(
        `lineage.tsv is not owned by uid ${uid} with mode 0600 (is ${uidMode(before.uid, before.mode & 0o777)}): ledger ignored`,
      );
    }
  }

  if (!Number.isSafeInteger(before.size) || before.size > LEDGER_MAX_BYTES) {
    return refuse("lineage.tsv is too large: ignored");
  }

  // Re-check through the descriptor: the path could have been replaced after the
  // `lstat` above, and a symlink swapped in must fail here, not be followed.
  let text: string;
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        return refuse("lineage.tsv is not a regular file (symlink or directory): ignored");
      }
      if (uid !== null && (info.uid !== uid || (info.mode & 0o777) !== 0o600)) {
        return refuse(
          `lineage.tsv is not owned by uid ${uid} with mode 0600 (is ${uidMode(info.uid, info.mode & 0o777)}): ledger ignored`,
        );
      }
      if (info.size > LEDGER_MAX_BYTES) return refuse("lineage.tsv is too large: ignored");
      const bytes = await handle.readFile();
      if (bytes.byteLength > LEDGER_MAX_BYTES) return refuse("lineage.tsv is too large: ignored");
      text = bytes.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { rows: [], note: null };
    return refuse(`lineage.tsv could not be read (${code ?? String(error)}): ignored`);
  }

  return { rows: parseLedgerTsv(text), note: null };
}

/** One row, seven tsv fields, the reference's `@tsv` field order (slp-gc.bash:744). */
function serializeRow(row: LedgerRow): string {
  // `@tsv` escapes the control characters a field must not carry; a space is the
  // safer substitution here because the exe is a path, not free text.
  const clean = (value: string): string => value.replace(/[\t\r\n]+/g, " ").trim();
  return [
    String(row.pid),
    clean(row.lstart),
    clean(row.comm),
    clean(row.owner),
    String(row.first),
    String(row.orphaned ?? 0),
    clean(row.exe ?? ""),
  ].join("\t");
}

/** Serialize the whole ledger (the reference's `jq -r '... | @tsv'`, slp-gc.bash:744). */
function serializeLedger(rows: readonly LedgerRow[]): string {
  return rows.map(serializeRow).join("\n") + (rows.length > 0 ? "\n" : "");
}

export interface WriteLedgerResult {
  ok: boolean;
  /** Why the write was refused, for the tick's log — never thrown. */
  note: string | null;
}

/**
 * Atomically replace the ledger (slp-gc.bash:739-745).
 *
 * The temp file is created in the ledger's own directory (same filesystem, so
 * the rename is atomic) with mode `0600`, filled, `chmod`ed to `0600` and then
 * renamed over the target. A `rename` replaces a symlink at the target rather
 * than following it, which is exactly the reference's `mv -f` — and the reason
 * `lineage.tsv` can never be pointed somewhere else by a link.
 *
 * Nothing throws: a read-only state dir, a directory at the target or a missing
 * parent answers `ok: false` with a note, and whatever ledger was there is left
 * untouched. A tick with no ledger loses its exe paths and its `first` stamps
 * next round; it does not fail.
 */
export async function writeLedger(
  path: string,
  rows: readonly LedgerRow[],
): Promise<WriteLedgerResult> {
  let targetDirectory = false;
  try {
    const existing = await lstat(path);
    targetDirectory = existing.isDirectory();
  } catch {
    // Absent (or unstattable): the rename below reports a real failure.
  }
  if (targetDirectory) {
    return { ok: false, note: "lineage.tsv is a directory: not written" };
  }

  const dir = dirname(path);
  const temp = join(dir, `.lineage.${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(temp, serializeLedger(rows), { flag: "wx", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
    return { ok: true, note: null };
  } catch (error) {
    // The temp file must not accumulate in the state dir.
    try {
      await unlink(temp);
    } catch {
      // Already gone, or never created.
    }
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, note: `lineage.tsv could not be written (${code ?? String(error)})` };
  }
}

/** The three process fields the next-ledger merge reads (a `ProcRow` satisfies it). */
export interface LedgerProc {
  pid: number;
  ppid: number;
  lstart: string;
}

export interface NextLedgerInput {
  /** The validated rows from `readLedger` + `validateLedger` — the reference's `$ledger`. */
  ledger?: readonly LedgerRow[];
  /** Rows produced for live, allowlisted descendants this tick — `$curr` (slp-gc.bash:452-460). */
  current?: readonly LedgerRow[];
  /** Rows proven by `PASEO_HOME` + `PASEO_AGENT_ID` — `$envrows` (slp-gc.bash:464-465). */
  envRows?: readonly LedgerRow[];
  /** The live process table: its `pid|lstart` keys are `$liveSet`, its ppids are `$byPid`. */
  procs: readonly LedgerProc[];
  now: number;
  /** The reference's `$ledgerCap`; defaults to 5000 and falls back to it on a bad value. */
  cap?: number;
}

/** jq compares `[.pid, .lstart]` as a number then a string; this is the same order. */
function compareKeys(a: LedgerRow, b: LedgerRow): number {
  if (a.pid !== b.pid) return a.pid < b.pid ? -1 : 1;
  if (a.lstart === b.lstart) return 0;
  return a.lstart < b.lstart ? -1 : 1;
}

/**
 * Assemble the ledger the next tick will read (slp-gc.bash:452-466).
 *
 * Three sources, in the reference's order:
 *
 * - `$curr`: the rows this tick recorded for live, allowlisted descendants.
 * - `$keep`: validated ledger rows that are still live **and** not already in
 *   `$curr` (`$liveSet[key] and not $curSet[key]`, :462). A kept row's
 *   `orphaned` is preserved when it is already set; otherwise it becomes `now`
 *   when the pid is ppid 1 and stays 0 when it is not (:463) — so the orphan
 *   age is the first tick that saw the process parentless, and re-recording a
 *   row never resets it.
 * - `$envrows`: processes proven by the environment alone (:464-465).
 *
 * Then `unique_by([.pid, .lstart])` — which keeps the first occurrence of each
 * key in input order, so a current row beats a kept row beats an env row — and
 * `sort_by(-.first)` newest first, with the key as the tie-break so the answer
 * does not depend on input order, and `.[:$ledgerCap]`.
 *
 * Dedupe happens *before* the cap, so a ledger full of duplicates still keeps
 * 5000 distinct processes. The input rows are never mutated.
 */
export function nextLedger(input: NextLedgerInput): { rows: LedgerRow[] } {
  const { procs, now } = input;
  const ledger = input.ledger ?? [];
  const current = input.current ?? [];
  const envRows = input.envRows ?? [];

  const live = new Set(procs.map((proc) => ledgerKey(proc.pid, proc.lstart)));
  const ppidByPid = new Map(procs.map((proc) => [proc.pid, proc.ppid] as const));
  const curKeys = new Set(current.map((row) => ledgerKey(row.pid, row.lstart)));

  const keep: LedgerRow[] = [];
  for (const row of ledger) {
    const key = ledgerKey(row.pid, row.lstart);
    if (!live.has(key) || curKeys.has(key)) continue;
    const recorded = row.orphaned ?? 0;
    const orphaned =
      recorded > 0 ? recorded : ppidByPid.get(row.pid) === 1 ? now : 0;
    keep.push(orphaned === row.orphaned ? row : { ...row, orphaned });
  }

  // `unique_by` on `[.pid, .lstart]`, first occurrence wins.
  const seen = new Set<string>();
  const merged: LedgerRow[] = [];
  for (const row of [...current, ...keep, ...envRows]) {
    const key = ledgerKey(row.pid, row.lstart);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  // `sort_by(-.first)`, newest first, key tie-break for a deterministic order.
  merged.sort((a, b) => (b.first - a.first) || compareKeys(a, b));

  const cap =
    input.cap !== undefined && Number.isInteger(input.cap) && input.cap >= 1
      ? input.cap
      : LEDGER_CAP;
  return { rows: merged.slice(0, cap) };
}
