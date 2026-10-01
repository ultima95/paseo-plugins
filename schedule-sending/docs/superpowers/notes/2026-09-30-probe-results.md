# Probe results — 2026-09-30

Daemon 0.10.1, plugin SDK scaffold 0.10.1, probe plugin `schedule-probe` (removed after the run), throwaway Claude agent.

| # | Question | Observed |
| --- | --- | --- |
| P1 | `process.env.PASEO_HOME` in plugin subprocess | `/Users/ultima/.paseo`; homedir `/Users/ultima` |
| P2 | `paseo` saved from a hook still works 60 s later | ok. `refresh()` and the handle both worked from a `setTimeout` 60 s after the hook returned |
| P3 | `refresh()` on an unknown agent id | THREW `Error: Agent not found: does-not-exist` (matches `/not found/i`) |
| P4 | handle at `turn_started` | status=`running` activeTurn=`{ turnId: "foreground-turn-1", startedAt: "<iso>" }` archivedAt=`null` |
| P5 | handle at `archived` | status=`idle` activeTurn=`null` archivedAt=`"2026-09-30T02:49:00.651Z"` (refresh still succeeds for an archived agent) |
| P6 | handle at `turn_ended` | status=`idle` activeTurn=`null` archivedAt=`null` |
| — | shape of a successful `refresh()` result (top-level keys) | `{ agent: { id, provider, cwd, workspaceId, model, status, activeTurn, ... } }` |

Decision-table outcome: no STOP condition; no change to Task 6 (`NOT_FOUND` regex already matches the observed message; `archivedAt` is the archival signal; busy is `activeTurn` non-null or status `running`).

Other findings:

- The scaffold's `tsconfig.json` has `"types": ["react"]` and no `@types/node`. Server code that uses `node:*` modules or `process` needs `@types/node` installed and `"node"` added to `types`.
- Other plugins on this daemon also register lifecycle hooks; hooks from several plugins run for each event.
- `paseo run --cwd <dir>` created the agent in the caller's workspace/project dir rather than `<dir>`; harmless for the trivial probe prompt.

## Follow-up probe (final review, finding 4): handle liveness over 15 minutes

A `paseo` object saved once from an `agent.turn_started` hook (04:22:18Z) was reused from timers:

| Checkpoint | Handle age | Result |
| --- | --- | --- |
| +1 min | 60 s | `refresh()` ok |
| +5 min | 300 s | `refresh()` ok |
| +15 min | 900 s | `refresh()` ok |

Not verified: handle age of hours (overnight silence). The scheduler tolerates a dead handle by keeping items pending
(lookup outages retry every tick up to 12 h past `fireAt`), and any hook or RPC replaces the handle with a fresh one.
