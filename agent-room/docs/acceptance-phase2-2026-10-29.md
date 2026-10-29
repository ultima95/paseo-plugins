# Phase 2 migration acceptance — 2026-10-29

Migration: retire the Phase 1 room (seat providers `claude-supervisor`, `claude-lead`,
`claude-peer`, `codex-peer`, their proxy credentials and the room-only files) and run the
Phase 2 `agent-room` plugin on its saved seats.

Environment: Paseo daemon `0.14.0-beta.2`, pid `1317` / worker `1320`, `startedAt
2026-10-29T04:43:22.838Z`, `listen 127.0.0.1:6767`, `connectedDaemon: reachable`. The daemon was
never restarted; `paseo reload` was the only configuration-apply step. Branch `feat/agent-room`,
base commit `6c6667a`.

Evidence sources, named per section: the five task reports under
`.superpowers/sdd/2026-10-29-agent-room-plugin-phase2-migration/` (`task-0-report.md` …
`task-4-report.md`), the scratchpad artifacts those reports list, and the read-only re-checks run
while writing this record (each re-check is quoted with its command).

## Step 0 — preflight

**Plugin running, seats saved.** `paseo plugin ls | grep -E '^agent-room'`
(`task-0-report.md` §Step 1; re-checked unchanged for this record):

```
agent-room                      running     yes       /Users/ultima/Workspace/paseo-plugins/agent-room
```

`~/.paseo/plugin-settings/agent-room/seats.json` (single line, mode 0600): `supervisor` =
`command-code` / `deepseek/deepseek-v4.1-flash` / `modeId bypass` / `thinkingOptionId default`;
`lead` = the same triple; `peerTiers` = 6 entries:

| tier | provider | model | mode | thinking |
|---|---|---|---|---|
| `cheap` | `claude` | `claude-haiku-5-5` | `bypassPermissions` | `medium` |
| `default` | `command-code` | `deepseek/deepseek-v4.1-flash` | `bypass` | `default` |
| `expensive` | `claude` | `claude-opus-5-5` | `bypassPermissions` | `medium` |
| `review` | `command-code` | `deepseek/deepseek-v4.1-flash` | `bypass` | `max` |
| `cross-family` | `claude` | `claude-sonnet-5-5[1m]` | `bypassPermissions` | `high` |
| `cross-family-review` | `claude` | `claude-opus-5-5[1m]` | `bypassPermissions` | `xhigh` |

The live seats name only `command-code` and `claude`, so no seat pointed at a provider scheduled
for removal.

**launchd line.** `launchctl list | grep com.paseo-slp.slp-gc`:

```
-	0	com.paseo-slp.slp-gc
```

**Reference sweep.** The preflight sweep for references to the files to be deleted returned one
hit:

```
.paseo/projects/workspaces.json
```

Exactly one matching line, `~/.paseo/projects/workspaces.json:3181`:
`"title": "Implement slp-room Phase 1 via subagents",`. It is a workspace title string in Paseo's
project registry, not a path, script or provider reference, and nothing depends on the deleted
files. Left in place (rewriting daemon-managed registry state was out of scope). Re-checked while
writing this record: line 3181 is still the only known hit. The full recursive re-scan was not
repeated — it exceeded the 30 s command limit against the daemon logs.

**Before-state and delete list.** `paseo provider ls` was 14 rows (saved as 2790 bytes in
`$COMMANDCODE_SCRATCHPAD/phase2-providers-before.txt`). The delete list was 15 `du -sh` lines
with 0 `MISSING` (`phase2-delete-list.txt`):

```
84K  .config/slp-room/claude-supervisor
84K  .config/slp-room/claude-lead
64K  .config/slp-room/claude-peer
392K .config/slp-room/codex-peer
4.0K .config/slp-room/bin/codex-peer
4.0K .config/slp-room/bin/slp-wait
44K  .config/slp-room/lead.md
24K  .config/slp-room/peer.md
44K  .config/slp-room/supervisor.md
52K  .config/slp-room/room
4.0K .config/slp-room/anthropic-api-key
4.0K .config/slp-room/anthropic-auth-header
4.0K .config/slp-room/anthropic-base-url
4.0K .config/slp-room/auth-mode
84K  .claude/skills/supervisor
```

A rollback aid for the four provider blocks was written to
`$COMMANDCODE_SCRATCHPAD/phase2-providers-removed.json` (5205 bytes, mode 600). It is
session-scoped and is **not** a backup: no archive of anything was created.

## Step 1 — providers

**Before → after.** `~/.paseo/config.json` `agents.providers`: 11 ids before, 7 after
(`task-1-report.md` §Steps 2–3). Surviving ids:

```
antigravity, claude, claude-worker, copilot, muse, opencode, pi
```

Removed: `claude-supervisor`, `claude-lead`, `claude-peer`, `codex-peer`. `codex` and
`command-code` are built-in providers — they never appeared in `config.json` and are unaffected.

Re-derived while writing this record:

```
$ python3 -c "... json.loads(~/.paseo/config.json) ..."
provider count: 7
ids: ['antigravity', 'claude', 'claude-worker', 'copilot', 'muse', 'opencode', 'pi']
```

**`paseo provider ls`.** 14 rows before → 10 rows after, the four removed rows exactly
(`task-1-report.md` §Step 5). Re-checked now: still 10 rows, removed-id matches `0`:

```
$ paseo provider ls | grep -E '^(claude-supervisor|claude-lead|claude-peer|codex-peer)\b'
(no output; grep exit 1)
```

Final rows: `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp`, `antigravity`, `muse`,
`command-code`, `claude-worker`. `omp` appears in `paseo provider ls` but was never in
`config.json`; it was there before the migration and is unchanged.

**Reload.** `paseo reload` printed `Configuration reloaded.` and exited 0. `paseo status`
immediately after: `localDaemon: running`, `listen: 127.0.0.1:6767`,
`configuredListen: 127.0.0.1:6767`, `connectedDaemon: reachable`, and `pid: 1317` with
`startedAt 2026-10-29T04:43:22.838Z` — hours older than the reload, i.e. no restart. The daemon
log records the apply as an in-process `daemon.config.reload.request` / `response` pair (4 ms) on
`pid: 1320`. The reload both reported success and actually changed the provider list, which is the
failure mode the plan called out (a reload that reports success but keeps the old config).

**Live room intact.** `paseo ls` for the `minimal-browser` room: 10 ids before the reload, the
same 10 after (`ids identical: True`, `missing after: []`, `new after: []`); only age-column ticks
differed. Supervisor `cf391bb` present and `running` throughout. Step 6 of `task-1-report.md`.

Re-checked for this record: supervisor `cf391bb3-f6ee-4cd3-9e00-6d901a5e1772`
`[room:supervisor] start implement task 13`, status `idle`, `command-code/deepseek/deepseek-v4.1-flash`,
cwd `~/workspace/minimal-browser`, still listed; its room record `cf391bb3…` holds 19 seats and
401 feed events and has no `endedAt`.

## Step 2 — files

**Deleted 15 of 15, no misses** (`task-2-report.md`). `rm -rf "${paths[@]}"` printed `removed`,
exit 0; a post-delete sweep reported `gone` for all 15 paths. Re-checked for this record:

```
$ ls -d ~/.claude/skills/supervisor ~/.config/slp-room/claude-* ~/.config/slp-room/room \
       ~/.config/slp-room/lead.md ~/.config/slp-room/peer.md ~/.config/slp-room/supervisor.md \
       ~/.config/slp-room/bin/codex-peer ~/.config/slp-room/bin/slp-wait \
       ~/.config/slp-room/anthropic-api-key ~/.config/slp-room/auth-mode
ls: ...: No such file or directory      # every path, no survivors
```

**Survivor listing.**

```
$ ls -A ~/.config/slp-room
bin
slp-gc.conf

$ ls -A ~/.config/slp-room/bin
slp-gc
```

Exactly `bin/slp-gc` and `slp-gc.conf`; nothing else. Both still carry Sep 30 mtimes, and
`test -x` / `test -f` passed (`gc executable OK`, `gc conf OK`):

```
Sep 30 15:33 -rwxr-xr-x /Users/ultima/.config/slp-room/bin/slp-gc
Sep 30 15:33 -rw------- /Users/ultima/.config/slp-room/slp-gc.conf
```

Keep-list integrity: `slp-gc` (104149 B,
`ac7a4c5071ebbd2f5a94fd9dcd5dc8606858804d9d297bbb45bfdd55b8e53a28`), `slp-gc.conf` (1133 B,
`64dd02c7078c06f30d4a3426d4cb7382d0aa8b2b1177b5594836c12e3fec80f4`) and
`~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist` (1422 B,
`64d01ac9b25e73d9ac7efbc49441ddb1a0478e73680309ab923404e083adf10b`) are byte-identical before and
after, and `~/Library/Logs/slp-gc/` still holds its nine entries.

**Skill gone.** `~/.claude/skills/supervisor` is absent (re-checked above), the other 41 skills
remain, and `grep -rl '"name": *"supervisor"\|^name: *supervisor' ~/.claude/skills ~/.agents/skills`
returned nothing — no loaded skill named `supervisor`.

## Step 3 — gc

**Report.** `SLP_GC_CONFIG=~/.config/slp-room/slp-gc.conf ~/.config/slp-room/bin/slp-gc report`
exited **0**; body 113 lines / 10059 bytes, fully readable, ending
`summary: 0 garbage candidate(s); actions only with --apply. Exit 0.` Sections parsed:
`(a)` processes, `(a2)` orphaned descendants, `(a3)` tree memory, `(a4)` test-runner concurrency
(0 agents), `(b)` recurring machinery (0), `(c)` `274 records live 4 archived 256
closed-unarchived 14 unreadable 0`, `(d)` 0 garbage candidates, `(e)` retention data
(`$COMMANDCODE_SCRATCHPAD/phase2-gc-report.txt`). No error line affecting the exit code or the
`claude-` scan; the pre-existing `identification: FAILED` header is recorded in Deviations 6. The
collector's `for d in "$HOME"/.config/slp-room/claude-*` loop
(`bin/slp-gc:799`) guards with `[ -d "$d" ]`, so the deleted directories are "nothing to scan"
rather than a failure.

**launchd.** Job still loaded; `last exit code = 0`; `runs` advanced across the migration while
the job ticked on its own (never kickstarted):

| sample | `runs` | `last exit code` | `launchctl list` |
|---|---|---|---|
| Task 0 preflight | 243 | 0 | `-	0	com.paseo-slp.slp-gc` |
| Task 3, before its 70 s wait | 243 | 0 | `-	0` |
| Task 3, after its 70 s wait | 245 | 0 | `-	0` |
| end of migration (controller read) | 246 | 0 | `-	0` |
| this record's re-check (later) | 255 | 0 | `-	0` |

Re-check command and output:

```
$ launchctl print "gui/$(id -u)/com.paseo-slp.slp-gc" | grep -E 'runs =|last exit code'
	runs = 255
	last exit code = 0
$ launchctl list | grep com.paseo-slp.slp-gc
-	0	com.paseo-slp.slp-gc
```

`255` rather than `246` because the job has kept ticking at `run interval = 60 seconds` since the
migration finished; the counter only ever increases, and every sample after the deletions has
`last exit code = 0`.

**Log tail.** `~/Library/Logs/slp-gc/launchd.log` is 44 lines / 3792 bytes, mtime `Oct 24 20:59`
— five days before the deletions — and `diff` shows no growth across Task 3's wait.
`grep -inE 'error|no such file|claude-'` over the whole file: no matches. `tick` is silent on
success, so the absence of a new line is expected; the load-bearing evidence is `runs` advancing
with exit 0.

## Step 4 — smoke room

Launch: `paseo run --no-wait --json --cwd /tmp/phase2-smoke --provider claude --title
"[room:supervisor] phase 2 smoke"` with the smoke brief as the first prompt, then `paseo wait`.
**It took two attempts.** The record below cites attempt 2 (room
`0bcfe1d9-53af-4ff1-adae-e24784c17fa7`) as the result; attempt 1 is recorded under Deviations.

**Seat rows** (`paseo ls --json`, and `rooms.json` seats; re-derived live for this record):

| Seat | Agent id | Provider / model | Mode | Thinking | Marker |
|---|---|---|---|---|---|
| Supervisor | `0bcfe1d9-53af-4ff1-adae-e24784c17fa7` | `command-code` / `deepseek/deepseek-v4.1-flash` | `bypass` | `default` | `[room:supervisor]` |
| Lead | `4b316b99-d477-48fc-9955-0e595bb54dc5` | `command-code` / `deepseek/deepseek-v4.1-flash` | `bypass` | `default` | `[room:lead]` |
| Peer (`default`) | `aaba4b3d-8b16-41a4-83fc-b5d16cfe791d` | `command-code` / `deepseek/deepseek-v4.1-flash` | `bypass` | `default` | `[room:peer:default]` |

Parent chain from the store: supervisor `parentId null` → lead `parentId 0bcfe1d9…` → peer
`parentId 4b316b99…`, marker `{seat: peer, tier: default}`. The caller requested
`--provider claude`; **the applied provider was `command-code/deepseek/deepseek-v4.1-flash`** on
all three seats, and `paseo run --json` already reported `"provider":"command-code"` at create
time, before the agent ran — the seat override (`server/inject.ts` `applySeat()`, which sets
`config.provider` / `config.model` and drops the caller's `modeId` / `thinkingOptionId` /
`featureValues`) is applied at creation and the requested provider never reaches the provider.
The Supervisor's stored record confirms `config.modeId = bypass`,
`config.thinkingOptionId = default`, `lastModeId = bypass`, and a 43,866-character
`config.systemPrompt` beginning `# Room Protocol — Supervisor · Lead · Peer`.

**`SMOKE.md`.** 10 bytes, exactly `phase2-ok` plus one trailing newline, captured before
`/tmp/phase2-smoke` was removed:

```
$ cat /tmp/phase2-smoke/SMOKE.md
phase2-ok
$ od -c /tmp/phase2-smoke/SMOKE.md
0000000    p   h   a   s   e   2   -   o   k  \n
0000012
```

A **Peer**, not the Supervisor and not the Lead, wrote it. Two independent proofs: the feed event
at `09:13:12.696Z` is `from aaba4b3d…` (the peer seat) `to 4b316b99…` (its Lead), label `reply`,
text `WROTE SMOKE.md`; and `paseo logs aaba4b3d-…` shows the brief arriving from the Lead, the
write, then `WROTE SMOKE.md`. The Supervisor's log ends by inspecting and reporting the result.

**Feed.** Room `0bcfe1d9-53af-4ff1-adae-e24784c17fa7`: **3 seats, 8 feed events**, created
`09:10:15.297Z`, `endedAt 09:14:03.338Z` (3 m 11 s).

```
09:11:27.386  message  null       -> supervisor  "Have your Lead launch one Peer that writes SMOKE.md …"
09:11:27.386  message  null       -> supervisor  guard notice: child "SMOKE peer" (ca9963de…) archived
09:11:27.388  guard    supervisor -> ca9963de    a [room:supervisor] may only create [room:lead] agents
09:13:12.696  message  peer aaba4b3d -> lead 4b316b99   "WROTE SMOKE.md"
09:13:20.659  message  lead 4b316b99 -> supervisor      "DONE"
09:13:22.673  message  null       -> supervisor  guard notice re-delivered
09:13:26.463  message  null       -> supervisor  guard notice re-delivered
09:13:26.463  message  supervisor -> room        "DONE. Lead … launched one Peer … SMOKE.md = 10 bytes, exactly phase2-ok\n. One file only."
```

The guard fired once, correctly: the Supervisor's first attempt created an unmarked child
(`ca9963de-5bcc-4e68-a83b-07d8dbc581a5` — an unmarked child, so no seat override applied,
`inject.ts:32-33`); its provider was `claude-worker/claude-haiku-4-5`. `server/guard.ts` archived
it and told the Supervisor the rule, and the Supervisor then created the proper Lead and finished.

**Cleanup.** All three smoke agents archived (plus the attempt-1 supervisor and the guard's
`ca9963de`), `/tmp/phase2-smoke` removed, 0 live smoke rows in `paseo ls` afterwards. The live
`minimal-browser` room was untouched: 25 rows before and 25 after, no row added or removed, the
only diff a status tick on its supervisor.

## Deviations

**1. The smoke room needed two attempts — attempt 1 failed.** Room
`0432c7f1-e207-4649-825b-aab26f34fdaa` (workspace `wks_ff67ba715422c373`) produced **1 seat and
2 feed events** and went idle in ~27 s. The Supervisor (`command-code` /
`deepseek/deepseek-v4.1-flash`) never called `create_agent` for a Lead; its log reads *"Have your
Lead launch one Peer … this sounds like a hierarchy. I should just use the agent tool (general) to
write the file."* It then used the provider's built-in `[general]` sub-agent to write `SMOKE.md`
itself and reported DONE. That violates its injected protocol verbatim (`# Room Protocol` lines
61–69: never use the agent's own built-in sub-agent, delegate only with Paseo `create_agent`).
The plugin side was healthy throughout — room record, seat, both feed events and the 43,866-char
system prompt were written, the provider was correctly overridden, `paseo logs` shows no error.
The identical command on retry produced the full tree.

This is a **Phase 1 behaviour defect, not a migration failure**: the seat can silently substitute
its own sub-agent and report success while the room never exists, and that failure mode is
invisible unless the seat tree is checked. Retry room `0bcfe1d9…` is the accepted result. One of
two attempts is not a rate, but this model is the default for both Supervisor and Lead, so it
warrants a Phase 1 follow-up (a stronger protocol line near the task, or a post-turn check that a
Supervisor turn ended with a child when its brief named one).

**2. `paseo run --json` returns `agentId`, not `id`.** The plan's `run.json['id']` lookup raises
`KeyError` against this CLI; the working field is `agentId`
(`{"agentId":"0bcfe1d9-…","status":"running","provider":"command-code",…}`) and it was used
directly and passed to `paseo wait`. The plan's `paseo ls | grep` fallback was **not** needed and
is not claimed to work here — it was never exercised.

**3. Two rooms share the task string `phase 2 smoke`,** so the plan's Step 5 feed assertion
(`next(r for r in rooms if "phase 2 smoke" in r["task"])`) selects the failed attempt and its
`assert len(events) >= 3` fails against it. That is a script defect, not a room defect: the same
assertions pass on `0bcfe1d9…`. This record asserts on the successful room id.

**4. `omp` remains in `paseo provider ls`** though it was never in `agents.providers`. It was there
before the migration and is unchanged — sourced outside `agents.providers`.

**5. Two stale workspace records point at the deleted `/tmp/phase2-smoke`:**
`wks_ff67ba715422c373` (attempt 1) and `wks_b550834eb395286d` (attempt 2). They were left in place:
removing them means editing daemon-managed `~/.paseo/projects/workspaces.json`, which is outside
this migration's permissions. They are inert metadata that resolve to a non-existent directory.

**6. A pre-existing `slp-gc` identification failure appears in every report**
(`phase2-gc-report.txt:3`, and echoed through the `(d)` groupings as 161x/73x/15x/7x "not
garbage"):

```
identification: FAILED: the Supervisor's PASEO_HOME is "unreadable": not proven to serve this
home (an unreadable env always refuses; a readable env without PASEO_HOME is accepted only for
the default home) -> --apply would be refused
```

It predates the deletions, is unrelated to `slp-room/claude-*`, gates `--apply` only, and does not
affect the exit code or the read-only report. Deferred; it matters only if `--apply` is ever
intended to work.

**7. The daemon logs a `spawn git ENOENT` warning** roughly every 60 s for `cwd:
/tmp/agent-room-acceptance` ("Git worktree discovery failed; treating directory as non-Git"). That
directory is the 2026-10-28 acceptance run's, is not a git repo, and is unrelated to this
migration. Noted for awareness.

**8. Cosmetic, non-numeric:** the daemon's global `appendSystemPrompt` made both the Supervisor and
the Peer call `Activate skill` before working, competing with the room protocol for the first turn.

## Global-constraint check

| Constraint (plan §Global Constraints) | Result |
|---|---|
| No archive created | Met. No archive of any deleted file or credential. The single retained artifact is `phase2-providers-removed.json` (mode 600, session scratchpad) — the four provider blocks only, as sanctioned by the brief's §Rollback notes; it is not an archive of the deleted paths or credentials. The two `~/.paseo/config.json.bak-*` files are pre-existing (mtimes `2026-09-21 22:18` and `2026-09-30 15:33`). |
| Daemon never restarted | Met. `pid 1317`, `startedAt 2026-10-29T04:43:22.838Z` unchanged at every checkpoint; `paseo reload` only, exit 0. |
| Live `minimal-browser` room untouched | Met. 10 ids identical across the reload; 25 rows before/after the smoke run; supervisor `cf391bb` still listed, never stopped, unarchived. Only agents whose cwd was `/tmp/phase2-smoke` were archived. |
| `slp-room` reduced to exactly two entries | Met. `bin/slp-gc` + `slp-gc.conf`, both unchanged (SHA-256 and Sep 30 mtimes). |
| `claude-worker` and all five `agentProfiles` present | Met. `claude-worker` is a surviving provider with its `paseo status` row; `daemon.agentProfiles` still has 5 entries (Researcher, Executor, UI/UX Designer, Command Code Default, Claude Default), none naming a removed provider. |
| Both plugins untouched | Met. `paseo plugin ls` still lists agent-room `running` and command-code `running`; neither was stopped or reloaded. Re-checked for this record: `agent-room                      running     yes       /Users/ultima/Workspace/paseo-plugins/agent-room` and `command-code                    running     yes       /Users/ultima/Workspace/paseo-plugins/command-code-provider`. |
| No `agent-room/` source file modified | Met. The only file added by this migration is this record; `git status` shows nothing else. |
| Work on `feat/agent-room`, never `main` | Met. Record committed on `feat/agent-room`. |

## Not done

- **`slp-gc` port (Phase 3).** `slp-gc` still runs from `~/.config/slp-room/bin/slp-gc` on its
  launchd `60 s` interval, with the pre-existing `identification` failure above. Porting it is
  Phase 3.
- **`claude-worker` removal (out of scope).** The provider is untouched by design: it was never in
  the removal set. The guard's archived `SMOKE peer` child ran on `claude-worker/claude-haiku-4-5`,
  but the record does not explain where that provider came from — an unmarked title is only left
  unmodified (`inject.ts:32-33`), so no inheritance rule is claimed. It is not named by any saved
  seat — the `cheap` peer tier is `claude/claude-haiku-5-5`.
- **Stale `/tmp/phase2-smoke` workspace records** (`wks_ff67ba715422c373`,
  `wks_b550834eb395286d`) — see Deviations 5.
