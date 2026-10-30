# Agent Room Phase 3 — GC port acceptance, 2026-10-30

Task 14 part A (non-destructive). This record covers the equivalence harness, the
scheduler and settings evidence, the protected classes, the rule defaults, and the
one-time state migration. Removing the reference (the launchd job `com.paseo-slp.slp-gc`,
`~/.config/slp-room`, `docs/gc-port/`) was the controller's step, after explicit
confirmation, and is recorded in **`## Removal (2026-10-30)`** at the end. Nothing in the
sections below deletes, unloads, restarts or rewrites anything: the harness ran the
reference with a throwaway `SLP_GC_STATE_DIR`, and every other command reads only.

> **The reference copy is gone.** `docs/gc-port/slp-gc.bash` and `docs/gc-port/slp-gc.conf`
> were deleted on 2026-10-30 (`## Removal (2026-10-30)`). Every citation of them in this
> record — `slp-gc.bash:<line>`, `slp-gc.conf` — is to the **removed reference copy** as it
> stood when the measurement was taken; the paths no longer exist in the tree, and the line
> numbers in the code comments are that copy's.

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

## 3. Equivalence — structurally equivalent; residual explained; harness unrerunnable

The harness printed **`EQUIVALENT`** at the time of the measurement, against the report
HEAD's own plugin wrote. That single run is no longer the whole answer, and this heading
says what the record actually establishes: the two artifacts are **structurally
equivalent** (every decision compared, the normalisation list below explained row by
row), the residual is **explained** (two named agent records the daemon changed after the
reports were written — *Final verdicts*, below), and the harness is now
**unrerunnable**, because it needs the reference as its second side:

```
$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts
reference removed; equivalence cannot re-run                                          exit=1
```

`scripts/gc-equivalence.mts` shells `bash docs/gc-port/slp-gc.bash report --json`
(`:799`, `:805`) for the reference side, and that file was deleted on 2026-10-30
(`## Removal (2026-10-30)`). The harness refuses rather than comparing one side against
itself. **Neither stored report is `EQUIVALENT`** (*Final verdicts*, `:345`): the honest
conclusion is structural equivalence plus the controls below, not a green diff.

HEAD `2f81974` changes only `scripts/gc-equivalence.mts`, so the server code that wrote the
report is `18f1866`'s — the build the daemon reloaded at 17:44:31Z (`gc conf imported`,
`~/.paseo/daemon.log:5399`) — and the report tick at 17:54:32Z wrote
`20261029T175431Z.json`: 200,622 bytes, `generated` 2026-10-29T17:54:31Z, `stat` mtime
17:54:32.127Z. The reference side is captured on every run as `report --json` of the
removed reference copy (`docs/gc-port/slp-gc.bash:1351`, deleted 2026-10-30), with
`SLP_GC_STATE_DIR` pointed at a throwaway
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
| `retention[*].note`'s `dirty=<n>` / `unpushed=<n>` counts | each numeric value replaced by `<n>` (`dirty=1` → `dirty=<n>`, `unpushed=0` → `unpushed=<n>`; `normalizeRetentionNotes`), **after asserting the section's shape**: `retention` must be an array of objects, each carrying a `note` key, and each `note` a string. Only those two numbers are replaced; the rest of the note, `unpushed=no-upstream` and every other field of the row are compared as they are | the reference's `git_state` (`slp-gc.bash:829-833`) records `dirty=<n> unpushed=<n>` for the working tree it samples, and that tree is the repository **this harness itself runs in**, so the reading changes between captures — the 17:49:31Z tick recorded `dirty=0`, the 17:54:32Z tick `dirty=1`, and a re-read later reads a third value. The counts are used only for the report's `other-worktree` annotation; no rule, gate, action or verdict reads `retention`, so they are a live host reading and not port drift. A missing, non-array or restructured `retention` entry fails by path rather than being normalised away (four scratch-copy controls below) |
| `agents.rows` | compared as a **set keyed by `id`** (`ROW_SECTIONS`, `agentKey`); every field of every row present on both sides is compared as it is, and ids on one side only are skipped and counted in the `rows on one side only (skipped)` line, like a process row. **Refused** when more than 10 % of either side's ids are one-sided (`ONE_SIDED_MAX`) | the record index is a population the daemon moves while the two captures run: the reference walks the record directory with `find` (`slp-gc.bash:628`, filesystem order), the port sorts each directory's filenames (`server/gc/agents.ts:255`), and agents are closed and archived continuously. Two records changed state *after* the stored reports were written (see *The agent section, compared by `id`* below), which is a row-level difference and not a decision of the port's; a row both captures carry is compared field by field, so a changed `state`, `reason` or `garbage` still fails |
| `agents.total`, `agents.live`, `agents.archived`, `agents.closedUnarchived`, `agents.unreadable` | dropped on both sides (`normalizeAgentPopulation`, `AGGREGATE_COUNTS`), **after asserting the shape**: `agents` an object, `rows` an array of objects each with a non-empty string `id`, every aggregate count present a number. Both sides' values are printed in every run (`agent counts (not compared, population drift): …`) | five counts of a population that is moving between the tick that wrote the report and the harness's own capture: both stored reports recorded `live 6`, `closedUnarchived 15`, while re-reads minutes later read `live 5` (`16`), then `live 4` (`17`), because the daemon closed and archived agents in between. Each count is derived from `rows` (`slp-gc.bash:550-556`; `normalizeAgents`, `server/gc/report.ts:1105-1117`) and the same rows are compared one by one, so the count adds no decision the row comparison does not already make. `agents.trusted` and the report's `index` section (`{ok, why}`) are **not** counts and stay compared as values |
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

### `agents.rows` order: a non-decision, compared sorted

The two files list the same 300 agent rows, by `id`, in a different order: the reference
walks the record directory with `find` and takes the filesystem's order
(`slp-gc.bash:628`), while the port sorts each directory's filenames
(`server/gc/agents.ts:255`). In the pair captured for this record all 300 positions
differed, while the id sets were equal and the `live` / `archived` counts agreed (6 / 279).
The harness sorts both sides by `id` (`ORDER_INSENSITIVE`), because order is not a
decision: every row, every field of it and the row count are still compared, and nothing is
dropped or matched up.

### Repeatability: counters and git-state notes no longer move the verdict

`daemonMetrics[].timelineStats` — the counters behind the 17:59Z re-run's
`daemonMetrics[1].timelineStats.totalItems (3748 vs 3745)` — is **normalised on both
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

The daemon counters are gone from both runs: `20261029T175431Z.json` was `EQUIVALENT`, and
`20261029T174931Z.json` got past `daemonMetrics` and named `retention[38].note` instead. That
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
reading and not port drift. **It was not normalised in that task** — the remit was the daemon
counters — so the field was compared as a value and the residual difference is recorded here
rather than dropped. It is normalised now, by the table's `retention[*].note` row.

### Final state: what the two re-runs actually show

With the retention-note normalisation in place, both stored reports were re-run (one bash
reference capture per run, throwaway `SLP_GC_STATE_DIR`, `.last-report` untouched, no plugin
reload), newest and one older. The pair was run twice — before and after the commit — and both
rounds name the same field:

```
$ … scripts/gc-equivalence.mts …/reports/20261029T174931Z.json
DIFFERS at agents.live (4 vs 6)                                                             exit=1
$ … scripts/gc-equivalence.mts …/reports/20261029T175431Z.json
DIFFERS at agents.live (4 vs 6)                                                             exit=1
```

(The earlier round of the same two commands printed `agents.live (5 vs 6)`; the recorded figure
is the committed harness's runs.)

Neither report prints `EQUIVALENT`, and the difference is **not** the retention note any more:
both runs stop earlier, at `agents.live`. That is a population count the comparison keeps as a
value, and it moved for a live reason: both stored reports recorded `live: 6`,
`closedUnarchived: 15` at their ticks, while the live re-reads counted `live: 5` (`16`) and then
`live: 4` (`17`) minutes apart — agents were closed or archived between the capture and the
re-reads, and the count is still moving. The `agents` rows are the same 300 record files
(sorted by `id` on both sides), but those records' status changes are a real difference between
the snapshot and the machine.
**It is not normalised and was not normalised further**: a count the rules read is a decision,
not a live sample, so the run stops there. Because `agents` precedes `retention` in the
report's key order, these runs do not reach the retention field at all — so this record does
**not** claim that the retention note is the last agreed field, only that it is no longer a
difference the harness can name.

What the same runs do show is that nothing else was relaxed. Four scratch copies of
`20261029T175431Z.json` (the stored file untouched) each failed by path, exit 1:

| scratch copy | what the harness printed |
| --- | --- |
| `retention[38]` with its `note` key removed | `DIFFERS at retention[38] (plugin side has no note key)` |
| `retention[38]` set to a string | `DIFFERS at retention[38] (plugin side is not an object)` |
| `retention` set to `{"0":"x"}` | `DIFFERS at retention (plugin side is not an array: {"0":"x"})` |
| `retention[38].note` set to the number `7` | `DIFFERS at retention[38].note (plugin side is not a string)` |

And the note's own text is still compared: because `agents.live` stops the harness before
`retention`, the shipped `normalizeRetentionNotes` was exercised directly (the source text
imported unchanged, the `main()` call stripped): `dirty=1` vs `dirty=0` and `dirty=3 unpushed=2`
vs `dirty=10 unpushed=7` collapse to the same note and compare equal, while
`unpushed=0` vs `unpushed=no-upstream`, a reworded `; never garbage` tail, and a reworded
`live agent cwd:` prefix each still produce `DIFFERS at retention[0].note (…)`. So only the two
numbers move, and only `dirty`/`unpushed` tokens that carry digits.

The daemon counters are settled — no run has named `daemonMetrics` since — and the retention
note is now normalised; the field that still moves the verdict on a stored report is
`agents.live`, a live population count, which this record leaves compared as a decision.

> **Superseded.** `agents.live` is no longer compared. The agent section is now compared row
> by row, keyed by `id`, and its five aggregate counts are dropped. See *The agent section,
> compared by `id`* immediately below for the rule, the controls and the two final verdicts.

### The agent section, compared by `id`

`agents` is the record index: 300 rows on both sides, the reference walking the record
directory with `find` (`slp-gc.bash:628`, filesystem order) and the port sorting each
directory's filenames (`server/gc/agents.ts:255`). The previous pass compared those rows
sorted by `id` but kept the section's summary counts as values, so a run stopped at
`agents.live (4 vs 6)` — a *count* of rows the row comparison had already paired. The daemon
closes and archives agents continuously, so rows change between the tick that wrote a stored
report and the harness's own capture, and a count of those rows can never agree across the
gap. The harness now:

1. **asserts the section's shape first** (`normalizeAgentPopulation`): `agents` exists on both
   sides and is a non-null object; it carries a `rows` key whose value is an array; every row
   is a non-null object carrying a non-empty string `id`; every aggregate count that is
   present is a number. A missing `agents`, a missing `rows`, a non-array `rows`, a row
   without an `id` or a non-numeric count fails by path.
2. **drops the five aggregate counts** (`AGGREGATE_COUNTS`: `total`, `live`, `archived`,
   `closedUnarchived`, `unreadable`) on both sides, printing both sides' values in the run log
   (`agent counts (not compared, population drift): …`), and
3. **compares the rows as a set keyed by `id`** (`ROW_SECTIONS`, `agentKey`): every field of
   every row present on both sides is compared as it is — `category`, `path`, `id`, `state`,
   `garbage`, `reason`, `action` — and ids present on one side only are skipped and counted in
   the `rows on one side only (skipped)` line, like a process row.

`agents.trusted` and the report's `index` section (`{ok, why}`) are not counts of that
population and stay compared as values.

**The one-sided rule.** The skip log must not be able to hide a systematic difference, so the
agent section declares `ONE_SIDED_MAX = 0.1`: if more than a tenth of *either* side's ids are
one-sided, the run prints `DIFFERS at agents.rows (n/total and m/total ids on one side only,
over 10%)` and exits 1, rather than skipping the difference as churn. A handful of ids is the
daemon's churn; a tenth of the record index is a different population — a scan that stopped
early, a moved home, a filter that narrowed. The other set sections keep the stricter
no-row-in-common refusal only, because a host's process table and garbage candidates are
supposed to turn over completely.

All controls below were run against scratch copies of
`20261029T175431Z.json` (the stored file untouched, `.last-report` untouched, no plugin
reload); each printed `DIFFERS` and exited 1:

| control | what the harness printed |
| --- | --- |
| one **shared** agent row's `reason` (sorted row 10, an `archived` record that agrees on both sides): `… (< 14 d); Paseo identification failed: …` → `… (< 14 d); CONTROL` | `DIFFERS at agents.rows[10].reason ("not garbage: archived 2 d ago (< 14 d); Paseo identification failed: … accepted only for the… vs "not garbage: archived 2 d ago (< 14 d); CONTROL")` |
| one **shared** agent row's `state` (same row: `archived` → `live`) | `DIFFERS at agents.rows[10].state ("archived" vs "live")` |
| `agents` removed | `DIFFERS at agents (plugin side is absent)` |
| `agents.rows` removed | `DIFFERS at agents.rows (plugin side has no rows key)` |
| `agents.rows` set to `"none"` | `DIFFERS at agents.rows (plugin side is not an array: "none")` |
| `agents.live` set to `"6"` | `DIFFERS at agents.live (plugin side is not a number: "6")` |
| 5 ids removed from the plugin side (1.7 % of 295) | threshold does **not** fire — the log reads `agents 5/300 vs 0/295` and the run goes on to the row residual |
| 40 ids removed from the plugin side (13.3 % of 300) | `DIFFERS at agents.rows (40/300 and 0/260 ids on one side only, over 10%)` |

So a shared row is compared as a row: its `reason` and its `state` each still fail on their
own, and the only thing the set comparison tolerates is a row that exists on one side only —
within a tenth.

### Final verdicts: the counts are gone, a record change is not

Both stored reports were re-run with the committed harness (one bash reference capture per
run, throwaway `SLP_GC_STATE_DIR`, `.last-report` untouched, no plugin reload):

```
$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts \
    /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T174931Z.json
agent counts (not compared, population drift): total 300 vs 300; live 4 vs 6; archived 279 vs 279; closedUnarchived 17 vs 15; unreadable 0 vs 0
rows on one side only (skipped): procs 0/21 vs 0/21; orphans 0/0 vs 0/0; garbage 0/0 vs 0/0; agents 0/300 vs 0/300
DIFFERS at agents.rows[32].state ("closed-unarchived" vs "live")                            exit=1

$ cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts \
    /Users/ultima/.paseo/plugin-data/agent-room/gc/reports/20261029T175431Z.json
agent counts (not compared, population drift): total 300 vs 300; live 4 vs 6; archived 279 vs 279; closedUnarchived 17 vs 15; unreadable 0 vs 0
rows on one side only (skipped): procs 0/21 vs 0/21; orphans 0/0 vs 0/0; garbage 0/0 vs 0/0; agents 0/300 vs 0/300
DIFFERS at agents.rows[32].state ("closed-unarchived" vs "live")                            exit=1
```

The aggregate counts no longer stop a run: they are printed on both lines (`live 4 vs 6`,
`closedUnarchived 17 vs 15`) and the comparison goes on past them. What stops both runs is a
**shared agent row that differs in a field**, which the brief rules semantic and not
normalisable. The rows are fully paired — 300 ids on both sides, `0/300` one-sided on each —
and exactly two of them differ, both in `state` and in the `reason` that follows from it:

| id | workspace | shared row | stored report (both ticks) | live re-read |
| --- | --- | --- | --- | --- |
| `1e355202-9498-4c85-a018-3383effd6922` | `Workspace/portfolio/thinh-dinh` | 32 (sorted) | `live`, `not garbage: unarchived agent (lastStatus idle)` | `closed-unarchived`, `not garbage: closed but not archived (report-only; the user may still see it)` |
| `ff54fa47-4aa0-4f24-b46d-74e702745915` | `Workspace/workspace-minimal-browser` | 299 (sorted) | `live`, same | `closed-unarchived`, same |

Both record files were written *after* both ticks — mtimes 2026-10-30 01:10:44 and 01:14:44
local (UTC+7), i.e. 2026-10-29T18:10:44Z and 18:14:44Z, against ticks at 17:49:31Z and
17:54:31Z — and they are exactly the two records behind `live 6 → 4` and
`closedUnarchived 15 → 17`. So the counts moved by the rows that moved, and the row comparison
now names the rows where a count used to name only a number. This is the honest residue of
comparing a **snapshot** against a **live document**: it grows with the report's age, not with
anything the port decides. The harness does not paper over it — `state` and `reason` are
compared as they are, per the brief's rule that a shared agent row differing in any field is
semantic and is not normalised.

**Neither stored report is `EQUIVALENT`.** What changed is *why*: the residual is no longer a
population count (dropped, with both sides' values logged) but two named records whose status
the daemon changed after the reports were written.

Two further observations, recorded and **not** normalised (out of this task's remit):

- Copying just those two rows' live `state`/`reason` into a scratch copy of
  `20261029T175431Z.json` (a control, not a harness rule) takes the run past the whole agent
  section — `agents 0/300 vs 0/300` — and it then stops at
  `DIFFERS at retention[9].path ("/Users/ultima/.paseo/agents" vs "/Users/ultima/.paseo/20261027-0955-01-daemon.log")`.
  The stored report lists `~/.paseo/20261027-0955-01-daemon.log`, which the daemon's own log
  rotation removed at 18:18Z (the 10 MB rotation that produced `20261030-0118-01-daemon.log`);
  the live walk sees `agents` at that position instead. `retention` is report-only — no rule,
  gate, action or verdict reads it — and its rows are compared in order, so this is a live home
  listing and the next residual in line.
- The daemon counters are still settled: no run since has named `daemonMetrics`, and the
  retention *notes* (as opposed to the row listing) no longer appear either.

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

The kill flags are additionally gated on `apply`, and **both** acting phases sit behind
the same two gates: `settings.apply && gate === null && (killStale || killMemory)`
(`server/gc/tick.ts:1879`, §9). Thresholds, from the same defaults:
`memWarnMb 3072`, `memKillMb 4096` (floor 1024, `slp-gc.bash:83`), `treeWarnMb null`
(50 % of RAM), `orphanMinAgeMin 10`, `testConcurrencyWarn 3`, `maxKills 10`,
`tickBudgetS 45`, `reportIntervalMin 60`, `cliTimeoutS 30`, `killComms`
`DEFAULT_KILL_COMMS`.

Where they live: the operator's file **was** `~/.config/slp-room/slp-gc.conf`
(KEY=VALUE, parsed not sourced; the one live copy, 1,133 bytes, all three flags `0`),
imported **once per process** and merged over the defaults; the plugin's own `gc`
settings document is layered on top per tick (`index.server.ts:170-195`); the code
defaults are `DEFAULT_GC_SETTINGS`. With the removal (`## Removal (2026-10-30)`) both the
conf and `~/.config/slp-room` are gone, so the import finds no file and yields
`DEFAULT_GC_SETTINGS` — the live layers are now the plugin's `gc` settings document over
the defaults. A settings read that times out or is invalid logs and falls back to the
imported baseline — never to an acting posture.

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
  because the reference's launchd job was still ticking at the time of that measurement
  — that is the reference writing to itself, not the port; the job is removed since, see
  `## Removal (2026-10-30)`, and `~/Library/Logs/slp-gc` stays in place as an archive.)

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

## Removal (2026-10-30)

The reference was removed by the controller after explicit confirmation, with the port
already running and sampling. Four commands, each followed by its own check:

1. Unload the launchd job —

   ```
   $ launchctl bootout gui/501/com.paseo-slp.slp-gc
   $ launchctl list | grep -c com.paseo-slp.slp-gc
   0                        # grep exit 1 — no match: nothing is loaded for this label
   ```

2. Remove its plist —

   ```
   $ rm ~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist
   $ ls ~/Library/LaunchAgents/ | grep slp
                            # no output: the plist is gone, no other slp agent is left
   ```

3. Remove the operator's config directory —

   ```
   $ rm -rf ~/.config/slp-room
   $ ls -d ~/.config/slp-room
   ls: /Users/ultima/.config/slp-room: No such file or directory
   ```

4. Remove the reference copy —

   ```
   $ rm -rf agent-room/docs/gc-port
   $ git status --short
    D docs/gc-port/slp-gc.bash
    D docs/gc-port/slp-gc.conf
   ```

That is the only trace left of the reference copy: two deletions, committed with this
record. Every `slp-gc.bash` / `slp-gc.conf` citation earlier in this file is to that copy
as it stood before this commit.

### The port kept ticking through the removal

Measured at 2026-10-30 09:22:32 local, minutes after the bootout, with no reload, no
restart and no state reset — `agent-room` stayed `running` the whole time:

```
$ wc -l ~/.paseo/plugin-data/agent-room/gc/memory.jsonl*
      14 …/gc/memory.jsonl
     537 …/gc/memory.jsonl.1
$ stat -f '%Sm %z %N' ~/.paseo/plugin-data/agent-room/gc/memory.jsonl*
Oct 30 09:22:32 2026 67,659 …/gc/memory.jsonl
Oct 30 09:08:32 2026 5,240,966 …/gc/memory.jsonl.1
```

`memory.jsonl` grew a line at 09:22:32 — the 60 s tick of a plugin that was never
restarted — and `memory.jsonl.1` holds the rotated predecessor at 537 lines /
5,240,966 B, so the port's own 5 MB rotation has run and kept exactly one predecessor.
(The controller's reading ten minutes earlier, 13 lines / 62,827 B at 09:21, is the same
series one tick back.) GC is therefore evidenced as the plugin's work alone: the launchd
job that used to write to `~/Library/Logs/slp-gc` is not loaded, and the files above are
under `~/.paseo/plugin-data/agent-room/gc`.

### `~/Library/Logs/slp-gc` is kept as an archive

The legacy log directory is deliberately **left in place** and is not a live path: the
reference wrote there, and `server/gc/migrate.ts` was seeded from it read-only (§6). It
is now only an archive — nothing in the port reads or writes it, and the port's state is
`~/.paseo/plugin-data/agent-room/gc` alone.

### The basis for the removal

The strict live diff was never fully field-clean: both stored reports stop on live
population drift (`agents.rows[32].state`, then `retention[9].path`, plus the
`retention[*].note` `git status` readings), which grows with the age of the snapshot
rather than with anything the port decides — so the removal was taken on structural
equivalence plus the harness's semantic controls (the normalisation tables and control
runs above, where a changed `class`, `why`, `protected`, agent `state` or `reason`, or a
whole population still each fail), and that is the user's explicit decision.

## Final whole-branch review (2026-10-30) — two production fixes

Two defects the review found, both fixed in one commit on `feat/agent-room-gc`; no other
rule, gate, threshold or message changed. Files: `server/gc/tick.ts`,
`server/gc/tick.test.ts`, this record.

### Finding 1 — the kill phase is behind the apply gate

**Defect.** The kill block was gated only on the settings —
`if (settings.apply && (settings.killStale || settings.killMemory))` — while
`gate = applyGateRefusal(ident, index)` was consulted for the deletes alone. The
reference refuses the whole of `do_apply`, kills included, before either of its loops
(`slp-gc.bash:1050-1057`), so the port could send a signal on a tick whose own gate said
the index is incomplete — routine, because `agents.ts` fails the whole index on one
record it cannot reduce (one agent mid-write).

**Fix.** The kill block is now
`if (settings.apply && gate === null && (settings.killStale || settings.killMemory))`
(`server/gc/tick.ts:1879`). With `apply` on and `gate !== null` the refusal row is
emitted **once**, in the acting block above, and names the gate that refused
(`refused: identification failed: …` / `refused: index incomplete: …`, `refusedBy`
`identification: …` / `index-incomplete: …`); no delete and no signal is attempted, and
no per-candidate row is produced. (`server/gc/tick.ts:1812-1818`, `:1876-1879`.)

**Tests** (`server/gc/tick.test.ts`, describe
`runTick — the apply gate covers the kill phase`):

| test | world | assertion |
| --- | --- | --- |
| `signals nothing and emits one refusal naming the index when the index is incomplete` | real identification (`ident.ok`), a real `ps` table with `process.pid` an over-threshold unprotected `agent-descendant` (`overmem.eligible: true`), plus one unreadable agent record (`invalid JSON`) so `index.ok` is false; `apply`, `killStale`, `killMemory` all on | `signal` not called, `deleteAgent` not called, `acted` has exactly one row, `kind: "refuse"`, `refusedBy` contains `index-incomplete` and the broken record's path, and no `kill` row |
| `sends the signal in the same world when the index holds` | identical, without the broken record | `index` is `{ok: true, why: []}`, `signal` called once with `(process.pid, "SIGTERM")`, one acted `kill` row, no `refuse` row |

**Mutation result.** With `gate === null &&` deleted from the kill condition (the
pre-fix line restored verbatim, nothing else touched):
`server/gc/tick.test.ts` → **1 failed | 31 passed**, the failure being
`expect(test.signal).not.toHaveBeenCalled()` — the mock recorded
`[ <pid>, "SIGTERM" ]` while `index.ok` was false. With the gate restored: **32 passed**.
So the test fails exactly when the gate is removed.

### Finding 2 — the kill phase re-reads the agent records

**Defect.** `reevaluate` passed the tick's `agentsSnapshot` into `reevaluateProc`, so the
`ownerState` behind a stale-eligibility decision could be a whole tick stale — while the
reference re-reads the agent records before every signal (`recheck`, `slp-gc.bash:1116`).

**Fix.** The kill phase now re-reads them **once per phase, not once per candidate**
(`server/gc/tick.ts:1891-1925`), and passes that snapshot into `reevaluateProc`. A
re-read that fails — throws, or comes back with an incomplete index — **refuses the
phase** the way an incomplete index refuses the deletes (`:1054-1057`): one `refuse` row
with `refusedBy: index-incomplete: the kill phase's agent re-read failed`, and no signal
from a decision whose inputs could not be read. A phase with no candidate reads nothing,
because the reference's `recheck` lives inside its per-pid loop. Test:
`refuses the kill phase once when its own agent re-read is incomplete` (the tick's index
held; a record appears mid-tick through the `procs` seam, so only the phase's own re-read
is incomplete → one refusal row, no signal). Full suite: `883 passed`; `tsc --noEmit`
clean.

## Accepted gaps (final whole-branch review, 2026-10-30)

Three gaps, recorded rather than silently carried. Gap 1 was a delivered-capability gap
at merge time and was closed on 2026-10-30; Gaps 2 and 3 remain open by decision.

### Gap 1 — the spec's deliberate parity break was NOT implemented (delivered-capability gap)

The design rules one deliberate departure from the reference: *"Replacement of the
Supervisor proof with index-plus-listener gating"* — inside the daemon the
Supervisor-serves-this-home proof is circular, so the authorised gate was to be a
successful agent/schedule index read, a listener matching `paseo.pid`, and a resolved
daemon entry (`docs/superpowers/specs/2026-10-29-agent-room-plugin-phase3-gc-design.md`,
*Identity, apply authorization, and the one deliberate parity break*).

**Resolved on 2026-10-30** (this section originally recorded the gap and the decision it
needed).

The replacement gate is implemented as the design rules, with one detail the design
could not know: Paseo runs a plugin's server code in a **child** of the daemon, not in
the daemon process. So "this code serves this home" is proven by the identified daemon
being either the running process or the one that spawned it:

- `resolveIdentity` accepts `selfPid` and `selfPpid`; `inProcess` is true when the pid
  `paseo.pid` names equals either. `ok` now requires
  `!duplicated && pidFile && supervisor && daemon && listener && (homeBound || inProcess)`
  (`server/gc/identity.ts`).
- `tick` passes `process.pid` and `process.ppid`; the plugin's server process runs as a
  child of the identified `Paseo Daemon` (observed: `selfPid 48609`, `selfPpid 1320`).
- An absent or non-numeric self pid never counts as the daemon, and the in-process proof
  cannot rescue a failed Supervisor, duplicate rows or a listener mismatch (tests
  `resolveIdentity — the in-daemon proof`).
- `homeBound` is still computed and reported; the report's `$idt` stays byte-identical to
  the reference, so `inProcess` is internal to the identity object and never serialized.
- The rest of the gate is unchanged: `applyGateRefusal` still requires `index.ok`, and
  every candidate is re-evaluated and signature-checked before it is touched.

**Live evidence.** After a reload, a forced report (`reports/20261030T033940Z.json`)
carries `ident.ok: true`, `why: "ok"`, `homeBound: false`, `supHome: "unreadable"`,
`daemonPid: 1320`, `listener: true`. Suite 890/890, typecheck clean. With every rule
still off, that report listed 161 eligible garbage candidates — so enabling `apply` now
acts, which is the capability this gap was blocking.

**Per-rule posture is unchanged by this fix:** stale kills still require the process
env's `PASEO_HOME` to match, memory kills still require class + allowlist + daemon
descent, and orphans still need a ledger or env proof.

### Gap 2 — the reference's `needsProof` / `paseo agent inspect` compensation is not ported

The reference marks a garbage row `needsProof` when an agent-class process's env could
not be read, and `do_apply` then requires `paseo agent inspect --home … --json` to prove
the agent archived and not running before the delete, refusing otherwise (the "env of
agent-class processes is unreadable and `paseo agent inspect` did not prove it archived
and not running" arm). The port has no such field and no `agent inspect` call: the same
fact is **rendered as text only**, in the row's `reason` — *"NOTE: the env of N
agent-class process(es) is unreadable, so --apply must first prove it archived and not
running with `paseo agent inspect`"* (`server/gc/evaluate.ts:1652`) — and the delete
proceeds on the record evidence.

**Mitigation.** The plugin runs as the same uid as the agents it inspects, from inside
the daemon that owns them, so env reads succeed for them by construction and `envBlind`
is structurally ~0: the reference's compensation exists for a scan run from outside
that tree, and the port is on the inside. Measured: the `20261030T015431Z.json` report
carries `envBlind: [32916]` — one row, a same-uid `claude` child whose `ps -eww` read
failed (`envRead: false`, `home: "unreadable"`) — against `garbage: 0` rows that tick.

**When it matters.** When a tick has **an agent-class process whose env this uid cannot
read** *and* **a garbage-shaped record for that agent**, the port would delete on the
record alone: "no live process carries this owner" is *unknown* rather than *proven*, so
the record of an agent that is in fact still running can be removed. It cannot matter for
a cross-uid process (the plugin cannot signal or delete another user's work into
existence) but it does matter for a same-uid read that failed, which is the one shape
observed on this host.

### Gap 3 — the reference's reserved 20 s kill window is not ported

When the tick budget was exhausted by the record phase, the reference re-stamped the
tick, set the budget to a hard 20 s, set `KILLS_ONLY=1` (no deletes, no report) and ran
an `evaluate light` plus `do_apply` so the kill phase still got a window in that tick:
*"tick budget (${TICK_BUDGET_S}s) used up by record: kill phase runs in a reserved 20 s
window (deletes and report skipped)"* (`slp-gc.bash:1311-1318`, and `:1061` for the
`KILLS_ONLY` no-delete arm).

The port has no reserved window: the budget is one `tickBudgetS` per tick, so a slow
collection phase ends the tick and the kills are deferred to the next one (60 s later).
**Availability only** — no kill is ever made or skipped on evidence the port lacks, and
nothing is left in an inconsistent state; a stale row simply lives up to one tick longer
than it would under the reference.
