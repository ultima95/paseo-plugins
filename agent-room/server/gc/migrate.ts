// One-time copy of the reference tool's state into the plugin's data dir.
//
// Reference: `slp-gc.bash` keeps everything in `$STATE`
// (`${SLP_GC_STATE_DIR:-$HOME/Library/Logs/slp-gc}`, slp-gc.bash:169):
// `memory.jsonl` (+ its one rotated predecessor), `lineage.tsv`, `alerts.log`,
// `.alert-stamp`, `.last-report` and the `reports/` directory of rendered text
// reports. The port's state lives under the plugin's own data dir, so the history
// a user already has would otherwise be orphaned the day the plugin takes over.
//
// Four properties matter more than tidiness:
//
// 1. **Copy only, never move.** The reference script keeps working after the
//    plugin is installed — a user can still run `slp-gc report` by hand, and the
//    deployed launchd job may still fire. Deleting or renaming its files would
//    break it mid-run and lose the only history a rollback could return to. The
//    source directory is therefore *read*, never written: no file is renamed, no
//    directory is created, nothing's mtime moves.
// 2. **Idempotent.** A destination that already exists is skipped, never
//    overwritten. The plugin loads many times (every daemon restart, every
//    reload), and after the first copy the plugin's own files are the newer
//    truth — a second copy would silently roll the memory history back.
// 3. **An absent source is not an error.** Most machines never ran the
//    reference tool. Nothing is created, nothing is logged as a failure, and the
//    answer says so (`copied: []`, `skipped: []`).
// 4. **Modes survive.** The state dir is `0700` and the files are `0600` in the
//    reference (the ledger reader refuses anything else: slp-gc.bash:708-709), so
//    the copy re-applies the source's permission bits explicitly rather than
//    trusting the platform's `copyFile` to carry them.

import { chmod, copyFile, cp, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The files the reference's state dir holds (slp-gc.bash:1213, 1219-1229, 1305,
 * 1309, 1326). `memory.jsonl.1` is `rotate`'s predecessor; `reports/` is handled
 * separately because it is a directory.
 */
export const MIGRATED_FILES: readonly string[] = [
  "memory.jsonl",
  "memory.jsonl.1",
  "lineage.tsv",
  "alerts.log",
  ".alert-stamp",
  ".last-report",
];

/** The directory of rendered reports (`$STATE/reports`, slp-gc.bash:1325). */
export const MIGRATED_REPORT_DIR = "reports";

/** The state dir's mode, the reference's `chmod 700` (slp-gc.bash:1187). */
const STATE_DIR_MODE = 0o700;

export interface MigrateInput {
  /** The reference tool's state dir: `~/Library/Logs/slp-gc` in production. */
  from: string;
  /** The plugin's GC state dir, under `$PASEO_HOME/plugin-data/agent-room/gc`. */
  to: string;
  /** Test seam for the file copy; defaults to `fs.promises.copyFile`. */
  copyFile?: (source: string, target: string) => Promise<void>;
}

export interface MigrateResult {
  /** The names copied this run, `reports/` included when the directory was copied. */
  copied: string[];
  /** The names left alone because the destination already existed. */
  skipped: string[];
  /** Whether the source dir existed at all; `false` means nothing was attempted. */
  present: boolean;
}

/** `lstat` without following a link: a symlinked state entry is not evidence we own it. */
async function statOrNull(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** The source's permission bits, or `null` when they cannot be read. */
async function modeOf(path: string): Promise<number | null> {
  const info = await statOrNull(path);
  return info === null ? null : Number(info.mode) & 0o777;
}

/**
 * Copy the reference tool's state into the plugin's state dir.
 *
 * Order is the file list's order, so the result is deterministic and a test can
 * assert it. Every step is individually forgiving: a file that cannot be copied
 * (a permission error, a vanished source) is left out of `copied` rather than
 * aborting the migration, because a half-migrated history is far better than a
 * plugin that will not load. Nothing here rejects.
 */
export async function migrateState(input: MigrateInput): Promise<MigrateResult> {
  const result: MigrateResult = { copied: [], skipped: [], present: false };

  const source = await statOrNull(input.from);
  // Absent, or not a directory: nothing to copy, and nothing to create on the
  // destination side either (property 3).
  if (source === null || !source.isDirectory()) return result;
  result.present = true;

  try {
    await mkdir(input.to, { recursive: true, mode: STATE_DIR_MODE });
  } catch {
    // A destination we cannot create is a destination we cannot copy into; the
    // per-file steps below would each fail the same way, so answer "copied
    // nothing" instead of throwing.
    return result;
  }

  const copy =
    input.copyFile ?? (async (from: string, to: string) => void (await copyFile(from, to)));

  for (const name of MIGRATED_FILES) {
    const from = join(input.from, name);
    const to = join(input.to, name);
    const info = await statOrNull(from);
    // Only a regular, non-symlink source file is copied: `-f`/`-L` from the
    // reference's own gate (slp-gc.bash:1245) applied to the whole state dir.
    if (info === null || !info.isFile() || info.isSymbolicLink()) continue;
    if ((await statOrNull(to)) !== null) {
      result.skipped.push(name);
      continue;
    }
    try {
      await copy(from, to);
      const mode = await modeOf(from);
      if (mode !== null) {
        try {
          await chmod(to, mode);
        } catch {
          // The copy landed; the mode is a nicety.
        }
      }
      result.copied.push(name);
    } catch {
      // Leave it out of `copied`: the next plugin load retries it.
    }
  }

  // `reports/`: a directory of text reports, copied recursively when absent from
  // the destination. `force: false` keeps every file already there, and an
  // existing destination directory is reported as skipped so the caller can see
  // the migration did not touch it.
  const reportSource = join(input.from, MIGRATED_REPORT_DIR);
  const reportSourceInfo = await statOrNull(reportSource);
  if (reportSourceInfo !== null && reportSourceInfo.isDirectory()) {
    const reportTarget = join(input.to, MIGRATED_REPORT_DIR);
    if ((await statOrNull(reportTarget)) !== null) {
      result.skipped.push(`${MIGRATED_REPORT_DIR}/`);
    } else {
      try {
        await cp(reportSource, reportTarget, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        // The reference writes `0700` for the dir and default modes for the files
        // it renders; the directory's own bits are the ones worth carrying.
        const mode = await modeOf(reportSource);
        if (mode !== null) {
          try {
            await chmod(reportTarget, mode);
          } catch {
            // Best effort, as above.
          }
        }
        result.copied.push(`${MIGRATED_REPORT_DIR}/`);
      } catch {
        // A directory that will not copy costs the old reports, nothing else.
      }
    }
  }

  return result;
}

/**
 * The report files in a state dir, for the pruning the reference does after
 * writing one (`ls -1 | sort -r | tail -n +49 | rm`, slp-gc.bash:1327). Exported
 * so the tick's writer and its test agree on the ordering.
 */
export async function listReports(stateDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(stateDir, MIGRATED_REPORT_DIR));
    return entries.filter((name) => name.endsWith(".txt")).sort().reverse();
  } catch {
    return [];
  }
}
