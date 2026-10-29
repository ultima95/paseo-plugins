# Agent Room plugin — Phase 3 design (garbage collection)

Date: 2026-10-29
Status: draft, awaiting approval
Predecessors: `2026-10-28-agent-room-plugin-phase1-design.md`, `2026-10-29-agent-room-plugin-phase2-migration-design.md`

## Intent and why

`slp-gc` is a 1359-line bash tool that watches a Paseo home: it samples memory,
proves orphaned processes, reclaims archived agents and completed schedules,
scans transcripts and retention, writes hourly reports and alerts, and runs
every 60 seconds from a launchd job. Phase 2 deliberately kept it — deleting
its state would have taken the memory history with it — so `~/.config/slp-room`
survives today as a directory containing exactly `bin/slp-gc` and
`slp-gc.conf`, plus `com.paseo-slp.slp-gc` in launchd.

Phase 3 ports that tool into the `agent-room` plugin, replaces the conf file
with plugin settings and its launchd tick with an in-plugin interval, gives it
a screen, and only then deletes the bash tool, its conf, and the launchd job.

## Decided by the user (this session)

| Topic | Decision |
|---|---|
| Where the tick lives | Plugin-only. The launchd job is removed; a hung daemon stops its own watchdog. |
| Scope | Full parity: report, record, tick, apply, kill stale, kill memory, retention, transcripts, lineage ledger, memory history, alerts, hourly reports, notifications. |
| Plugin home | Inside `agent-room`, not a separate plugin. Disabling agent-room disables GC. |
| Configuration | Plugin settings (Zod schema) with a one-time import from `slp-gc.conf`, after which the file is ignored. |
| State | Migrated into `$PASEO_HOME/plugin-data/agent-room/gc/`. |
| Destructive defaults | Everything off. Reclaim, stale kill and memory kill are enabled individually, each behind a confirm dialog naming what will be signalled. |
| UI | Its own sidebar screen: status, candidates, thresholds, toggles, history, manual report and reclaim. |
| Port approach | Faithful 1:1 transliteration into typed modules with the report JSON shape preserved, proven by golden fixtures captured from the current bash. |

## What exists today (verified 2026-10-29)

| Piece | State |
|---|---|
| `slp-gc` | 1359 lines of bash + `jq`, three subcommands (`report`, `record`, `tick`), flags `--apply`, `--kill-stale-processes`, `--kill-over-memory`, `--home`, `--json`. |
| Rules | Garbage = completed schedules and agents archived ≥ 14 days, each gated on index completeness, identity, path and signature checks. Stale kill = orphaned pids (ppid 1 or parent not Paseo) and orphaned agent descendants proven by the lineage ledger or by `PASEO_HOME` + `PASEO_AGENT_ID`, dev-tool comm, older than `SLP_GC_ORPHAN_MIN_AGE_MIN`. Memory kill = one process above `SLP_GC_MEM_KILL_MB`, never the daemon, the Supervisor, the app main or an agent child. |
| Knobs | 20 env-style keys in `slp-gc.conf`, report-only default, last value wins, flags on only when exactly `1`. |
| State | `~/Library/Logs/slp-gc/`: `memory.jsonl` (2.8 MB) + `memory.jsonl.1` (5 MB), `lineage.tsv`, `alerts.log`, `.alert-stamp`, `.last-report`, `launchd.log`, `reports/`. |
| Tick | launchd `com.paseo-slp.slp-gc`, `StartInterval` 60 s, `SLP_GC_CONFIG` pointing at the conf. |
| Plugin runtime | `PluginServerContext` supports `registerSettings`, `handle`, provider and usage registration, and lifecycle hooks, with a contribution that returns a cleanup function — so an interval is hostable. `PluginHandlerContext.paseo` is the typed `PaseoApi`; the SDK exports `spawnProcess`, `execCommand`, `terminateProcess`. |
| Reclamation APIs | `paseo.agents.deleteAgent`, `paseo.agents.archiveAgent`, `paseo.scheduleDelete` exist — no CLI shelling needed. |

## Design

### Module shape

`agent-room/server/gc/`, one module per bash phase, rules copied rather than
redesigned:

| Module | Ports |
|---|---|
| `context.ts` | PASEO_HOME resolution, state dir, clock, PATH, RAM probe |
| `procs.ts` | `collect_ps`, `collect_top`, footprint and CMPRS parsing, classing, env reads, cwd hints |
| `identity.ts` | `paseo.pid` Supervisor/daemon/listener identification, home match |
| `agents.ts` | agent and schedule snapshots through `paseo.*` instead of six CLI calls; refs and busy refs |
| `ledger.ts` | `lineage.tsv` read, ownership/mode/size validation, write, first-seen tracking |
| `evaluate.ts` | the `EVAL_JQ` predicates: garbage, stale, overmem, orphan proofs, index completeness |
| `apply.ts` | `do_apply`: per-candidate fresh re-evaluation, signature check, budget, refusal on a failed index |
| `kill.ts` | protected classes, SIGTERM of a single pid, `MAX_KILLS`, tick budget |
| `record.ts` | `memory.jsonl` sample, 5 MB rotation keeping one predecessor, alert stamp, alerts.log, notification |
| `report.ts` | report assembly, retention scan, transcript scan, daemon metrics from `daemon.log` |
| `render.ts` | the text report |
| `tick.ts` | tick phases: record, periodic report, apply, kills |
| `settings.ts` | Zod schema, defaults, one-time conf import |
| `scheduler.ts` | 60 s interval in the server contribution, in-process mutex, budget, cleanup |

The report JSON keeps its current field names so the same fixtures, rotation
and any external reader still apply.

### Settings and the conf import

Every knob becomes a settings field with today's default: rule toggles for
apply / stale kill / memory kill, `MEM_WARN_MB` 3072, `MEM_KILL_MB` 4096
(floor 1024, never below warn), `TREE_WARN_MB` half of RAM,
`KILL_COMMS` list, `ORPHAN_MIN_AGE_MIN` 10, `TEST_CONCURRENCY_WARN` 3,
`MAX_KILLS` 10, `TICK_BUDGET_S` 45, `REPORT_INTERVAL_MIN` 60,
`CLI_TIMEOUT` 30.

The first settings read imports `~/.config/slp-room/slp-gc.conf` once:
comments and blanks skipped, `KEY=VALUE` with last value winning, a flag on
only when it is exactly `1`, unknown keys and invalid values logged and
ignored, and the settings document records that the import happened so it
never runs twice. After that the file is never read again.

### State migration

On first start the plugin copies `memory.jsonl`, `memory.jsonl.1`,
`lineage.tsv`, `alerts.log`, `.alert-stamp`, `.last-report` and `reports/` from
`~/Library/Logs/slp-gc/` into `$PASEO_HOME/plugin-data/agent-room/gc/`,
preserving modes, skipping anything already present, and never writing back.
The originals stay in place as an archive until the user deletes them; the
spec's close-out step removes the launchd job, not the archived logs.

### Identity, apply authorization, and the one deliberate parity break

Today `--apply` is refused unless the Supervisor in `paseo.pid` is proven to
serve this home, and a clean `report` never calls the Paseo CLI so it works on
a hung daemon.

Inside the daemon that proof is circular: the code executing the check *is*
the daemon. The replacement gate is: a successful agent/schedule index read, a
listener matching the configured one, and a resolved `paseo.pid` daemon entry.
A failed index still refuses the whole apply, and every candidate is still
re-evaluated and signature-checked immediately before it is touched.

Everything else ports unchanged: garbage rules, orphan proofs and the lineage
ledger, protected classes (daemon, Supervisor, app main, agent children,
other-home processes), `MAX_KILLS` per tick, the tick budget, and the rule
that the daemon is reported but never memory-killed.

### Tick

`setInterval(60_000)` in the plugin server contribution, cleared in the
returned cleanup. An in-process mutex drops a tick that arrives while one is
running. The tick records a memory sample every time, writes a report only
when `REPORT_INTERVAL_MIN` has elapsed, and acts only for rules that are
enabled. The 45 s budget aborts remaining actions.

Accepted gap: a hung daemon stops its own watchdog, and the daemon's own
memory figure comes from `ws_runtime_metrics` in `daemon.log`, i.e. it is
self-reported.

### GC screen

A sidebar screen beside Room:

- Status: daemon pid and uptime, Paseo tree footprint against warn and kill
  thresholds, last tick, next report, ledger note, index status.
- Process table: pid, ppid, class, owner, age, footprint, CMPRS, RSS, flags —
  the text report's columns as a list.
- Candidates: every garbage, stale and over-memory candidate with the rule
  that matched or the reason it failed.
- Rules: three toggles, each confirming with a sentence naming what will be
  signalled; thresholds editable through settings.
- Actions: "Run report now" always; "Reclaim now" and the kill actions only
  when their toggle is on.
- History: newest alerts and reports from the migrated artifacts.

2 s refresh while visible, `theme.colors` only, compact layout stacks the
table under the status block.

### Proof before the bash is deleted

1. Capture `slp-gc --json` output today, on this machine, as fixtures
   (report with a clean index; report with a failed identity; report with
   candidates; record sample).
2. Unit tests per module with injected `ps`/`top`/agent snapshots — no test
   reads the live process table.
3. An equivalence harness that runs the new report and the bash report on the
   same machine and diffs them field by field, ignoring timestamps, pids and
   pct churn, before and after enabling each rule in report-only mode.
4. Only when that diff is clean: unload the launchd job and delete
   `~/.config/slp-room`, each step confirmed in chat.

## Acceptance (Phase 3 done when)

1. Settings import reproduces every non-default value from `slp-gc.conf`;
   re-running the import is impossible; invalid lines are logged once.
2. The interval tick runs unattended for an hour without overlap, honors the
   budget, and survives a plugin reload (old timer cleared, new one running).
3. The new report matches the bash report field for field on the captured
   fixtures and on one live diff, modulo timestamps and pid churn.
4. All three rules default off; with a rule off, no signal and no delete
   happens; enabling a rule requires the confirm dialog.
5. Reclamation deletes only agents archived ≥ 14 days and completed
   schedules, with a fresh re-evaluation and signature check per candidate,
   and refuses entirely when the index read fails.
6. Protected classes are never signalled — table-driven tests over daemon,
   Supervisor, app main, agent child, other-home and non-allowlisted comm —
   and `MAX_KILLS` and the budget are respected.
7. State is migrated once, `memory.jsonl` rotates at 5 MB keeping one
   predecessor, and alerts stay rate-limited by the stamp.
8. The GC screen shows status, processes, candidates and history; toggles and
   thresholds work; layout is compact and theme-correct.
9. `npm test` and `npm run typecheck` pass; `paseo plugin ls` shows
   `agent-room` running; the Room screen and room features are unaffected.
10. After equivalence, the launchd job is unloaded and `~/.config/slp-room` is
    removed, each confirmed separately.

## Non-goals

- Changing any rule's semantics, thresholds or safety posture.
- Windows or Linux parity beyond graceful degradation (RSS fallback when
  `top` is unavailable).
- Splitting GC into its own plugin.
- Removing the archived `~/Library/Logs/slp-gc` history.
- Any Phase 1 room change, or Phase 2 leftovers.

## Known limits

- A hung daemon stops the GC tick; the case the launchd job existed for is
  no longer covered by an external watchdog.
- Disabling or uninstalling `agent-room` disables garbage collection.
- Daemon memory is self-reported from its own log.
- A memory kill can still end a live agent's allowlisted child when that rule
  is opted into, exactly as today.
- The port is macOS-first: classing uses `ps`/`top` output shapes.

## Calls made by the assistant (not confirmed by the user)

- Module names and the one-module-per-bash-phase layout.
- State migration by copy, originals kept as an archive.
- Import-once semantics for `slp-gc.conf`, unknown keys logged and ignored.
- Replacement of the Supervisor proof with index-plus-listener gating.
- Fixed 60 s interval, report cadence from settings.
- Golden fixtures plus a live equivalence diff as the deletion gate.
- 2 s refresh on the GC screen.

## Left to the builder

- Exact RPC contract names and the typed report model.
- How `ps`/`top`/agent snapshots are injected for tests.
- Text-report rendering fidelity versus the jq templates.
- Screen component structure and query keys.
- Whether the notification path reuses `osascript` or the plugin's own notify
  surface.
