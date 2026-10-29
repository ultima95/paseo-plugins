# Agent Room Phase 3 — GC port acceptance, 2026-10-30

Task 14 part A (non-destructive). This record covers the equivalence harness, the
scheduler and settings evidence, the protected classes, the rule defaults, and the
one-time state migration. It does **not** cover removing the reference (the launchd
job `com.paseo-slp.slp-gc`, `~/.config/slp-room`, `docs/gc-port/`) — that is the
controller's step, after explicit confirmation. Nothing here deletes, unloads,
restarts or rewrites anything: the harness runs the reference with a throwaway
`SLP_GC_STATE_DIR`, and every other command reads only.

```
$ git log --oneline -1        # 2f81974 fix(agent-room): gc equivalence under live process churn
$ git branch --show-current   # feat/agent-room-gc
$ cd agent-room && npm test && npm run typecheck
   Test Files  31 passed (31)
        Tests  880 passed (880)
   tsc --noEmit → no output, exit 0
```

The newest plugin report is `~/.paseo/plugin-data/agent-room/gc/reports/20261029T175431Z.json`
(200,622 bytes, `stat` mtime 2026-10-30 00:54:32 local, `generated` 2026-10-29T17:54:31Z),
written by the plugin the daemon reloaded at 17:44:31Z.

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

## 3. Equivalence — `EQUIVALENT`

The harness prints **`EQUIVALENT`** against the report HEAD's own plugin wrote. HEAD
`2f81974` changes only `scripts/gc-equivalence.mts`, so the server code that wrote the
report is `18f1866`'s — the build the daemon reloaded at 17:44:31Z (`gc conf imported`,
`~/.paseo/daemon.log:5399`) — and the report tick at 17:54:32Z wrote
`20261029T175431Z.json`: 200,622 bytes, `generated` 2026-10-29T17:54:31Z, `stat` mtime
17:54:32.127Z. The reference side is captured on every run as `report --json`
(`docs/gc-port/slp-gc.bash:1351`), with `SLP_GC_STATE_DIR` pointed at a throwaway
directory, so a harness run can never touch the live GC state.

```
$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts \
    /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T175431Z.json
EQUIVALENT (plugin report /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T175431Z.json, written 2026-10-29T17:54:32.127Z)
exit=0
```

`procs.orphans` is `[]` on **both** sides — 0 rows against 0, not the 418 of the earlier
run — and `procs.procs` is 21 rows on both, so the skip log's orphan count is
`orphans 0/0 vs 0/0`.

### The complete normalisation list

One row per class of value the comparison changes, with the reason it is an instant
rather than a decision. Everything not listed here is compared as it is.

| what | how | why it is live, not drift |
| --- | --- | --- |
| `generated`, `etime_s`, `pid`, `ppid`, `pgid`, `lstart`, `home`, `rss_mb`, `mem_mb`, `cmprs_mb`, `footprint_mb` | dropped (`IGNORE`) | the capture instant, process ages, live pids and start times as text, one absolute path, and `ps`/`top` samples — two captures seconds apart cannot agree on any of them, and the path is not a decision |
| `protected` | mapped: `in slp-gc's own process tree` and `null` both become `<own process tree or none>` (`EQUIVALENT`) | the reference protects its own process tree (`slp-gc.bash:295-298`, `:317`), so the app main, the Supervisor, the daemon and the tool's shell read as its own tree; the port runs inside the daemon and has no tree of its own by ruling `NO_SELF_PID = 0` (`server/gc/tick.ts:193`), so those rows read `null` — and they are still refused by class on both sides, by the same arm in the same order: app main and Supervisor (`slp-gc.bash:362`, `server/gc/evaluate.ts:595`), daemon (`:363`, `:598`), agent child (`:364`, `:604`), plus the invoking agent by `PASEO_AGENT_ID` / `invOwnerPid`, which no class arm replaces. **No other `protected` value is normalised** — `belongs to the invoking agent`, `in the invoking agent's process subtree` and the port's own `in the GC's own process tree` compare as they are |
| `procs.procs`, `procs.orphans`, `garbage` | compared as **sets** keyed `pid` + `lstart` (garbage rows: `category` + `id`); a row on one side only is skipped and counted per section in the `rows on one side only (skipped)` line (`ROW_SECTIONS`, `alignRowSections`) | a process that exits or a record file that appears between the two captures is a row on one side only, not a decision; a pid alone is recycled by the kernel and `lstart` alone can repeat, so the pair names one process. A section with **no** row in common is refused, not skipped — an empty section against a populated one, or two disjoint populations, is not churn |
| `why` | `<number> MB` → `<MB>` in every `why` sentence (`WHY_MB`, `EQUIVALENT.why`) | both sides quote a `top` sample taken seconds apart (`footprint 114.0 MB` vs `115.0 MB`); only the numbers go, and the sentence, its `<=`/`>` and the eligibility it states stay compared. The threshold inside the sentence collapses with them, so the thresholds are compared separately as the `warnMb` / `killMb` numbers the report carries |
| `tree.totalMb`, `tree.appMb`, `tree.orphanMb`, `retention[].kb`, `retention[].count`, `transcripts[].bytes`, `daemonMetrics[].time`, `daemonMetrics[].rss`, `daemonMetrics[].heapUsed` | dropped (`IGNORE`, second block) | sums and sizes *of* the dropped samples: the same instant one level up, and a sum of dropped inputs could only ever fail. What they decide stays compared — `tree.over`, `overall.*`, `totals[].n`, and the thresholds `warnMb`, `killMb`, `treeWarnMb` |
| `daemonMetrics[].timelineStats` | replaced by `<live counter>` on both sides (`normalizeDaemonCounters`), **after asserting the section's shape**: `daemonMetrics` must be an array of objects, each carrying a `time` key and a `timelineStats` key, and each `timelineStats` an object or `null` | the daemon's own timeline counters, which grow with every agent turn: the 17:59Z re-run read `totalItems` 3748 against the 17:54:32Z report's 3745. Dropping the key by name would drop the section's shape with it, so the object is *replaced* and its shape asserted first — a missing, non-array or restructured `daemonMetrics` fails by path. Verified on three scratched copies of the 17:54:32Z report: an entry with no `timelineStats`, `daemonMetrics` set to a string, and an entry set to a string each printed `DIFFERS at daemonMetrics…`, exit 1 |
| `procs.ledgerNext` | the port's side is dropped **only when the reference's side is exactly `null`** — asserted on every run (`REPORT_MODE_ONLY`, `reconcileReportMode`) | the reference's `report` verb never computes a ledger: `WANT_LEDGER=1` is set in exactly one place, `do_record` (`slp-gc.bash:1188`), reachable only from `tick` (`:1344`), so its `ledgerNext` is `null` on every host — while the port's file is a *tick's* report and carries the 6 rows that tick wrote (`server/gc/tick.ts:1752`). `null` here is the artifact's zero value, not "no rows" against "rows". This is the one section where the two artifacts are not the same artifact, the exemption is **asserted rather than ignored**, and it covers no rule: a reference that ever produced ledger rows keeps them and is compared normally. The ledger's own rules are pinned by `server/gc/ledger.test.ts` against the same jq, since no reference CLI emits a ledger |

There is no `pct` field in either report (`grep -n "pct" server/gc/report.ts shared/gc.ts`
→ no match, and none in the report JSON either); the percentage-shaped live numbers that
do exist are the `daemonMetrics` samples above, and they are dropped as samples.

### The exemptions cannot hide a rule change

Five controls, each run through the harness at 17:59Z on a scratch copy of the 17:54:32Z
report (the stored file untouched); each printed `DIFFERS` with exit 1:

| control | what the harness printed |
| --- | --- |
| a differing `class` (`app-main` → `daemon`) | `DIFFERS at procs.procs[19].class ("app-main" vs "daemon")` |
| a reworded `why`, numbers untouched (`footprint` → `foot print`) | `DIFFERS at procs.procs[19].overmem.why ("footprint <MB> <= <MB>" vs "foot print <MB> <= <MB>")` |
| a non-own-tree `protected` change (`null` → `belongs to the invoking agent`) | `DIFFERS at procs.procs[19].protected ("<own process tree or none>" vs "belongs to the invoking agent")` |
| an edited agent `reason` | `DIFFERS at agents.rows[10].reason (…)` |
| 0 orphans vs 1 (one row added to the port's `procs.orphans`) | `DIFFERS at procs.orphans (no row in common: 0 rows vs 1 rows)` |

So the normalisation list cannot absorb a rule change: a class, a sentence, a protection, a
reason and a whole population all still fail, and the last one fails as a refusal rather
than as a value difference — the harness never compares a population it cannot pair.

### The stale-report episode

The earlier run's 418 orphan candidates came from a **stale artifact**, not from the port:
the report it compared was written at 17:16:18Z by a build that predates the
orphan-selection gate (`server/gc/tick.ts:777-790`, added by `18f1866`), which requires a
lineage-ledger row or an env proof before a `ppid 1` row is even a candidate — without it
every unclassified launchd child on the box was listed as an orphan candidate, 418 rows
against the reference's 0, while the plugin reloaded at 17:44:31Z carries the gate and both
reports written since (`20261029T174931Z.json`, `20261029T175431Z.json`) carry
`procs.orphans: []`.

### The one difference left: `agents.rows` order

The two files list the same 300 agent rows, by `id`, in a different order: the reference
walks the record directory with `find` and takes the filesystem's order
(`slp-gc.bash:628`), while the port sorts each directory's filenames
(`server/gc/agents.ts:255`). In the pair captured for this record all 300 positions
differed, while the id sets were equal and the `live` / `archived` counts agreed (6 / 279).
The harness sorts both sides by `id` (`ORDER_INSENSITIVE`), because order is not a
decision: every row, every field of it and the row count are still compared, and nothing is
dropped or matched up.

### Repeatability: the daemon counters no longer move the verdict

`daemonMetrics[].timelineStats` — the counters behind the 17:59Z re-run's
`daemonMetrics[1].timelineStats.totalItems (3748 vs 3745)` — is now **normalised on both
sides, with the section's shape asserted first** (`normalizeDaemonCounters`,
`scripts/gc-equivalence.mts`): `daemonMetrics` must be an array of objects, every entry
carrying a `time` key and a `timelineStats` key, and every `timelineStats` an object or
`null`. Only then is the counter object replaced by `<live counter>`. A section that goes
missing, stops being an array or loses either key fails by path instead of passing quietly
(three scratched copies of the 17:54:32Z report — an entry without `timelineStats`,
`daemonMetrics: "none"`, an entry that is a string — each printed `DIFFERS at
daemonMetrics…`, exit 1). With that in place the same harness was re-run against two stored
reports, without touching `.last-report` and without reloading the plugin:

```
$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts \
    /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T175431Z.json
EQUIVALENT (… 20261029T175431Z.json, written 2026-10-29T17:54:32.127Z)                     exit=0

$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts \
    /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T174931Z.json
DIFFERS at retention[38].note ("live agent cwd: dirty=1 unpushed=no-upstream; never garbage"
                           vs "live agent cwd: dirty=0 unpushed=no-upstream; never garbage")  exit=1
```

The daemon counters are gone from both runs: `20261029T175431Z.json` is `EQUIVALENT`, and
`20261029T174931Z.json` gets past `daemonMetrics` and names `retention[38].note` instead. That
field is **a live `git status` reading of `/Users/ultima/Workspace/paseo-plugins`**, not a
decision: `git_state` (`slp-gc.bash:829-833`, port `gitState`) counts the non-empty lines of
`git -C <cwd> status --porcelain`, and the workspace genuinely changed between the two ticks —
clean at 17:49:31Z and one dirty file at 17:54:32Z (this record, committed at 18:04:30Z as
`ba1cd86`). Both re-runs above were taken with the harness change uncommitted, i.e. with that
one file as the tree's single dirty entry — the state the 17:54:32Z tick recorded. So the two
stored reports *recorded different live states*, and a live re-read can match only one of them
at a time: with a clean tree the same `note` makes the older report `EQUIVALENT` and the
newer one `DIFFERS`. It is report-only — the row is `other-worktree`, `count` 1, its own note
says "never garbage", and no rule, gate or verdict reads `retention` — so it is a live host
reading and not port drift. **It is not normalised**: this task's remit was the daemon
counters, so the field is compared as a value and the residual difference is recorded here
rather than dropped, which is why the older report does *not* print `EQUIVALENT` and the
two-report claim is not made. Every other section (`procs`, `agents`, `schedules`, `index`,
`garbage`, `transcripts`, and `daemonMetrics`' row shape) agreed on both runs.

Both commands were run a second time with this fix committed (clean tree), which is the 17:49:31Z
tick's state — the pair simply trades places on that one live field:

```
20261029T174931Z.json                                                                       exit=0
EQUIVALENT (… 20261029T174931Z.json, written 2026-10-29T17:49:32.145Z)
20261029T175431Z.json                                                                       exit=1
DIFFERS at retention[38].note ("live agent cwd: dirty=0 …" vs "live agent cwd: dirty=1 …")
```

So the daemon counters are settled — no run of either report has named `daemonMetrics` since —
and the one field that still makes the verdict depend on when it is taken is a live `git status`
reading outside the daemon counters this task covered.

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
