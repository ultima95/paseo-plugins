# Agent Room Phase 3 — GC port acceptance, 2026-10-30

Task 14 part A (non-destructive). This record covers the equivalence harness, the
scheduler and settings evidence, the protected classes, the rule defaults, and the
one-time state migration. It does **not** cover removing the reference (the launchd
job `com.paseo-slp.slp-gc`, `~/.config/slp-room`, `docs/gc-port/`) — that is the
controller's step, after explicit confirmation. Nothing here deletes, unloads,
restarts or rewrites anything: the harness runs the reference with a throwaway
`SLP_GC_STATE_DIR`, and every other command reads only.

```
$ git log --oneline -1        # 18f1866 fix(agent-room): align gc report and scan details with the reference renderer
$ git branch --show-current   # feat/agent-room-gc
$ cd agent-room && npm test && npm run typecheck
   Test Files  31 passed (31)
        Tests  880 passed (880)
   tsc --noEmit → no output, exit 0
```

The newest plugin report is `~/.paseo/plugin-data/agent-room/gc/reports/20261029T171618Z.json`
(670,312 bytes, `stat` mtime 2026-10-30 00:16:19 local, `generated` 2026-10-29T17:16:18Z).

## 1. Settings import — `keys: 3`

```
$ grep -c "gc conf imported" ~/.paseo/daemon.log
10
$ grep -n "gc conf imported" ~/.paseo/daemon.log | tail -1
5133:{"level":30,"time":1793293518648,"pid":1320,...,"timestamp":"2026-10-29T17:05:18.648Z",
      "message":"[agent-room] gc conf imported { keys: 3, problems: 0 }","msg":"Plugin output"}
```

The plugin log line is the import's own report (`server/gc/settings.ts:322-325`:
`keys: Object.keys(values).length`, `problems: problems.length`). Three keys is the
whole surface the reference's conf carries — `SLP_GC_APPLY`, `SLP_GC_KILL_STALE`,
`SLP_GC_KILL_MEMORY` — and `problems: 0` means no unknown key was seen and no value
had to be rejected. Ten lines, one per plugin load, all `keys: 3, problems: 0`.

Source of the import: `~/.config/slp-room/slp-gc.conf`, 1,133 bytes, mtime
2026-09-30 15:33, all three flags `=0`. The import is one-time per process and can
never throw: a missing, unreadable or malformed conf logs and yields
`DEFAULT_GC_SETTINGS` (`server/gc/settings.ts:1-9`, `:270`).

## 2. Scheduler

- **60 s cadence.** `GC_INTERVAL_MS = 60_000` (`server/gc/scheduler.ts:36`), asserted
  by `defaults to the reference's 60 s interval` (`server/gc/scheduler.test.ts:105`).
  It is the same 60 s the launchd job used: `plutil -p
  ~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist` → `"StartInterval" => 60`.
- **`gc.run` is refused while a tick runs, not queued.** Tests:
  `makes an outside caller (the gc.run RPC) unable to overlap a scheduled tick`
  (`scheduler.test.ts:159`), `refuses a second caller while the first is in flight`
  (`:111`), `drops a tick that arrives while one is running` (`:11`). The refusal is
  one `refuse` row (`shared/rpc.ts:96-102`) and the daemon logs
  `gc run refused: a tick is still running` (`index.server.ts:335`).
- **One timer after a reload.** `leaves no timer behind, so a reload cannot
  accumulate intervals` (`scheduler.test.ts:38`), `clears its timer when stopped`
  (`:28`), `is idempotent: a second cleanup does not disturb anything` (`:61`). A
  reloaded plugin therefore starts from zero intervals, never from two.

## 3. Equivalence

Harness: `scripts/gc-equivalence.mts`, run as the brief specifies. It compares the
reference's `report --json` (`docs/gc-port/slp-gc.bash:1351`) against the port's
persisted report, field by field, after normalisation, and names the **first**
difference by path.

```
$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts \
    /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T171618Z.json
DIFFERS at procs.procs (21 rows vs 22)
  plugin report: /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T171618Z.json
exit=1
```

That is **not** the difference the hand-off described, so this record states what it
is instead of claiming a verdict the command does not print. The extra row is the
live process set, not the port: the stored report still lists pid 23878
(`class: "paseo-wait"`), which has since exited —

```
$ ps -p 23878 -o pid=,comm=      # no output, exit 1 (pid gone)
$ node -e 'const r=require(".../20261029T171618Z.json");console.log(r.procs.procs.length)'
22                               # 21 of those pids exist now
```

With that one stale row removed from a **scratch copy** of the report (the stored
file is untouched; no normalisation was widened), the harness moves to the next
difference:

```
$ node --experimental-strip-types scripts/gc-equivalence.mts <scratch>/report-without-exited-23878.json
DIFFERS at procs.procs[0].overmem.why ("footprint 113.0 MB <= 4096 MB" vs "footprint 114 MB <= 4096 MB")
exit=1
```

Both commands were run twice, at 2026-10-29T17:40Z and 17:42Z, with the same first
difference each time.

### The one normalisation this task added

`protected: "in slp-gc's own process tree"` ≡ `protected: null` — both map to the
sentinel `<own process tree or none>` before the comparison
(`scripts/gc-equivalence.mts`, `EQUIVALENT`). Reason and ruling: the reference
protects its own process tree, i.e. its ancestry plus every row descending from it
(`slp-gc.bash:295-298` → `:317`), so under the bash tool the app main, the
Supervisor, the daemon and the tool's own shell read `in slp-gc's own process tree`.
The port runs inside the daemon and has no tree of its own, by ruling
`NO_SELF_PID = 0` (`server/gc/tick.ts:193`), so those same rows read `null`. Every
row the reference covers that way is still refused by class on both sides, by the
same arm in the same order — app main and Supervisor (`slp-gc.bash:362`,
`server/gc/evaluate.ts:595`), daemon (`:363`, `:598`), agent child (`:364`, `:603`) —
plus the invoking agent by `PASEO_AGENT_ID` / `invOwnerPid`, which no class arm
replaces. No decision is lost. **No other `protected` value is normalised**;
`belongs to the invoking agent`, `in the invoking agent's process subtree` and the
port's own `in the GC's own process tree` compare as they are.

### The complete normalisation list

Dropped before the comparison (`IGNORE`), because two captures at two instants
cannot agree on them:

| key | why it is live |
| --- | --- |
| `generated` | the capture instant |
| `home` | an absolute path, not a decision |
| `etime_s` | process age, sampled seconds apart |
| `pid`, `ppid`, `pgid` | live pids: same processes, different numbers |
| `lstart` | process start time, as text |
| `rss_mb`, `mem_mb`, `cmprs_mb`, `footprint_mb` | `ps`/`top` samples |

Value-mapped, not dropped (`EQUIVALENT`): `protected` only — see above.

Two notes on the brief's list:

- **No `pct` field exists in either report.** `grep -n "pct" server/gc/report.ts
  shared/gc.ts` → no match; nothing to normalise under that name. The percentage-like
  live samples that do exist sit in `daemonMetrics[][]` (`rss`, `heapUsed`, `time`)
  and are **not** normalised — they show up in the residual table below.
- **JS number formatting is matched in code, not in the harness** (so it is not a
  normalisation entry): the port prints an MB figure through `footprintText`
  (`server/gc/evaluate.ts:675-679`), `.toFixed(1)` when the sample came from `top`
  and `String()` when it came from `rss`, which is what jq's `tostring` produces from
  the reference's one-decimal `mb1` values (`slp-gc.bash:202`, `:434`). Commit
  18f1866 is what added the `.toFixed(1)` arm.

### Why the harness does not print EQUIVALENT on this report

Three independent causes, all evidenced:

1. **The stored report predates HEAD.** The report was written 2026-10-29T17:16:18Z
   by the plugin instance loaded at 17:05:18Z (last `gc conf imported` line above);
   HEAD 18f1866 was committed at 2026-10-30 00:31:11 +0700 = 17:31:11Z, and the
   daemon has not reloaded the plugin since 17:05:18Z. The report is therefore a
   build *between* 48b8b59 and 18f1866, and its `overmem.why` text (`"footprint 114 MB"`)
   is exactly the pre-`.toFixed(1)` rendering.
2. **Live churn between capture and run.** One process exited (pid 23878), the agent
   index moved (`agents.live` 6 vs 7, `agents.archived` 279 vs 277), and the
   reference reads its own `top`/`ps` sample on the run.
3. **A mode difference the harness has never reconciled.** The reference's `report`
   emits `procs.orphans: []` and `procs.ledgerNext: null`; the port's persisted tick
   report carries the 418 orphan candidates and the 6 ledger rows the same tick
   computed (`server/gc/tick.ts:1744-1752`).

For completeness, every residual leaf the harness hides behind its first-difference
output, grouped (scratch analyser using the harness's own `IGNORE`/`EQUIVALENT`, run
2026-10-29T17:38Z, 1,488 leaves):

```
  300  agents.rows[].path / .id / .action / .refusedBy   (the index moved; 300 each)
  185  agents.rows[].reason
   42  agents.rows[].state
   20  procs.procs[].overmem.why        (measurement text: live `top` sample)
    4  retention[].kb
    3  daemonMetrics[].time / .rss / .heapUsed / .timelineStats.*
    3  retention[].path / .note,  2 retention[].count
    2  procs.envBlind[]                  (includes the exited pid)
    1  procs.procs (rows 22 vs 21), 1 procs.procs[].class, 1 procs.procs[].stale.why
    1  procs.orphans (rows 0 vs 418), 1 procs.ledgerNext
    1  procs.tree.totalMb / .appMb, 1 agents.live / .archived / .closedUnarchived
    1  schedules (rows 0 vs 1), 1 retention (rows 41 vs 43)
```

**Verdict: equivalence is not demonstrated on this report.** The harness prints
`DIFFERS` on it, at a different path than the hand-off reported. The `protected`
normalisation this task asked for is in place and is the only one added; nothing in
the residual list was absorbed by widening it. A verdict needs a report written by
HEAD (the next hourly tick from a reloaded plugin), and a decision — for the
controller, not for this task — on whether measurement text inside `why` strings
(`overmem.why`, `stale.why`) and the mode-only `orphans` / `ledgerNext` sections are
compared at all. No GC module was changed: every field checked against the current
code matches the reference by design (`footprintText`, the class arm order, the
orphan and ledger assembly), and changing behaviour to satisfy a stale snapshot
would be exactly the drift the harness exists to catch.

## 4. Protected classes — the tests that pin them

`server/gc/evaluate.test.ts`:

- describe `buildProcTable — protection (slp-gc.bash:295-302, 317-319)` (`:555`)
  - `protects the GC's own process and its whole subtree` (`:556`)
  - `protects an agent the GC itself cannot see, by its own pid alone` (`:586`)
  - `protects the invoking agent's processes and prefers the owner arm` (`:592`)
  - `leaves the invoking-agent arms alone when the GC was run by hand` (`:619`)
- `cannot reach eligible through a built entry for any protected shape` (`:760`) —
  every `protected != null` shape is refused by both rules.
- `refuses the daemon, supervisor and app main` (`:59`) and `refuses an agent child
  even at 9 GB` (`:64`) — the class arms that carry the decisions the own-tree
  normalisation no longer compares.

`server/gc/tick.test.ts`:

- describe `runTick — the GC's own pid (selfPid)` (`:454`)
  - `passes a sentinel that matches no row, so the daemon's tree is not the GC's tree`
  - `would have protected the whole agent tree if selfPid were the daemon (the ruled-out reading)`
  - `expect(NO_SELF_PID).toBe(0)` (`:460`) — the ruling itself, pinned.

## 5. The three rules, and their defaults

Three rules, all off in `DEFAULT_GC_SETTINGS` (`server/gc/settings.ts:18-31`), so an
imported conf that says nothing new leaves the GC report-only:

| rule | flag | default |
| --- | --- | --- |
| reclaim: delete completed schedules and long-archived agents | `SLP_GC_APPLY` → `apply` | `false` |
| signal proven orphans | `SLP_GC_KILL_STALE` → `killStale` | `false` |
| signal agent descendants over the kill threshold | `SLP_GC_KILL_MEMORY` → `killMemory` | `false` |

The kill flags are additionally gated on `apply`: `settings.apply && (killStale ||
killMemory)` (`server/gc/tick.ts:1870`). Thresholds, from the same defaults:
`memWarnMb 3072`, `memKillMb 4096` (floor 1024, `slp-gc.bash:83`), `treeWarnMb null`
(50 % of RAM), `orphanMinAgeMin 10`, `testConcurrencyWarn 3`, `maxKills 10`,
`tickBudgetS 45`, `reportIntervalMin 60`, `cliTimeoutS 30`, `killComms`
`DEFAULT_KILL_COMMS`.

Where they live: the operator's file is `~/.config/slp-room/slp-gc.conf`
(KEY=VALUE, parsed not sourced; the one live copy, 1,133 bytes, all three flags `0`),
imported **once per process** and merged over the defaults; the plugin's own `gc`
settings document is layered on top per tick (`index.server.ts:170-195`); the code
defaults are `DEFAULT_GC_SETTINGS`. A settings read that times out or is invalid logs
and falls back to the imported baseline — never to an acting posture.

## 6. State migration

The reference's state dir (`~/Library/Logs/slp-gc`) was copied once into the plugin's
GC state dir (`~/.paseo/plugin-data/agent-room/gc`) by `server/gc/migrate.ts`, whose
source is read-only by contract (`migrate.ts:16-27`) and pinned by
`copies every reference entry, reports/ included, and leaves the source alone`
(`migrate.test.ts:40`), plus `is idempotent: an existing destination is skipped,
never overwritten` (`:71`), `does nothing at all when the source is absent` (`:87`),
`copies the entries it can when one of them cannot be copied` (`:98`),
`skips a symlinked source entry rather than following it` (`:116`).

Measured now (`wc -l`, `shasum -a 256`, `ls | wc -l`, `stat`):

| file | destination | source | note |
| --- | --- | --- | --- |
| `memory.jsonl` | 25 lines, 1,909,596 B | 911 lines, 4,987,412 B | destination is the plugin's own record, one line per 60 s tick |
| `memory.jsonl.1` | 66 lines, 5,184,522 B | 713 lines, 5,241,366 B | the rotated predecessor (5 MB cap, `record.ts:69-71`) |
| `alerts.log` | 31 lines, 2,830 B | 31 lines, 2,830 B | **byte-identical**: sha256 `7aff88e4…e087d5` on both |
| `lineage.tsv` | 6 lines, 734 B | 6 lines, 734 B | **byte-identical**: sha256 `adcbed28…54c797` on both |
| `reports/` | 49 files (48 `.txt` + 1 `.json`) | 48 files (all `.txt`) | 47 source names copied, see below |

- **The copy is provably a copy, not a rewrite.** Every copied destination file
  carries the migration instant as its mtime — `alerts.log`, `lineage.tsv`,
  `reports/20261027T132628Z.txt` and the rest all read 2026-10-29 22:53:59 local —
  and `alerts.log` + `lineage.tsv` are byte-identical to the source by sha256.
- **`reports/`:** diffing the two directory listings shows 46 of the source's 48 names
  present in the destination, three files only in the destination
  (`20261029T161559Z.txt`, `20261029T171618Z.txt`, `20261029T171618Z.json` — writes the
  plugin made itself), and two source names not copied: the oldest
  (`20261027T122617Z.txt`) and the newest
  (`20261029T164923Z.txt`, written by the source after the copy). The two writers are
  independent now, which is exactly what the split looks like.
- **`memory.jsonl` line count cannot evidence the seed any more, and this record does
  not pretend otherwise.** The reference's `rotate` is a rename that keeps exactly one
  predecessor (`record.ts:97-118`, `slp-gc.bash:1181-1184`), and the predecessor now on
  disk is dated 2026-10-30 00:11:19 local; `memory.jsonl.1` begins at
  `{"ts":"2026-10-29T16:03:08Z",…}`, the plugin's own ticks, so the migrated content is
  no longer visible and was replaced by ordinary rotation rather than by any deletion.
  The copy evidence therefore rests on the files whose content is still identical
  (`alerts.log`, `lineage.tsv`) and on `reports/`.
- **Source mtimes untouched by the migration.** `stat -f '%Sm %z %N'` on the source:
  `alerts.log` 2026-10-24 20:59:38 / 2,830 B, `memory.jsonl.1` 2026-10-29 02:52:20 /
  5,241,366 B, `reports/*` their own hourly stamps. `alerts.log` has not moved since
  four days *before* the migration, which is only possible if the copy never wrote
  the source. (`memory.jsonl` and `lineage.tsv` in the source do have current mtimes
  because the reference's launchd job is still ticking — that is the reference
  writing to itself, not the port; the job is removed by the controller later.)

## 7. Live acting cannot be demonstrated on this host

The report says so itself:

```
$ node -e 'const r=require(".../20261029T171618Z.json");console.log(JSON.stringify(r.ident,null,1))'
{
  "pidFile": true, "supervisor": true, "daemon": true, "listener": true,
  "supervisorPid": 1317, "daemonPid": 1320, "appPid": 644,
  "supHome": "unreadable", "listen": "127.0.0.1:6767", "homeBound": false,
  "ok": false,
  "why": "the Supervisor's PASEO_HOME is \"unreadable\": not proven to serve this home
          (an unreadable env always refuses; a readable env without PASEO_HOME is
          accepted only for the default home)"
}
```

`ident.ok` is `false` because the Supervisor process has no readable `PASEO_HOME`, so
the port cannot prove the home it is reporting on is the home being served. Every
acting path refuses on that (`identification failed: …`), which means no live act —
no reclaim, no signal — can be demonstrated on this host, with the rules on or off.
The reference shares the limitation by construction: it computes the same `ident`
block and refuses on the same arm (`slp-gc.bash:323-342`), so "the port acts like the
reference" is demonstrable here and "acting works" is not. Acting is covered where it
can be covered: by construction and refusal tests (`server/gc/apply.test.ts`,
`kill.test.ts`, `evaluate.test.ts:29-160`), not by a live run.
