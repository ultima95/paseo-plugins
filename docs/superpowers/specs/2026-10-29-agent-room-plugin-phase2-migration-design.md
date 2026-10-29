# Agent Room plugin — Phase 2 design (retire the old Claude room)

Date: 2026-10-29
Status: draft, awaiting approval
Predecessor: `2026-10-28-agent-room-plugin-phase1-design.md`

## Intent and why

Phase 1 moved the room onto Paseo: seats, role injection, the guard, the Room
screen, `/room`, and the live view. The old Claude-only room still exists
beside it — `claude-supervisor` / `claude-lead` / `claude-peer` /
`codex-peer` providers, per-provider `CLAUDE_CONFIG_DIR`s under
`~/.config/slp-room`, a `supervisor` skill, and copies of the protocol and
roles. Two ways to run a room means the old one keeps absorbing maintenance,
and the phase-1 anti-goal ("any remaining dependency on Claude Code for a room
to function") stays unmet as long as a working alternative sits in `PATH` and
`config.json`.

Phase 2 removes the old room. It writes no product code: it edits daemon
configuration, deletes the old runtime directories and the old skill, proves
the garbage collector we keep still runs, and proves a room still works
afterwards.

## Decided by the user (this session)

| Topic | Decision |
|---|---|
| `slp-gc` (Phase 3) | Keep it running in place. Phase 2 deletes the room-only parts of `~/.config/slp-room` and leaves `bin/slp-gc`, `slp-gc.conf`, the launchd job, and its logs. Phase 3 ports it, then removes the rest. |
| Backup | None. No archive of `config.json`, `slp-room`, or the skill is taken. |
| Proxy credentials | Expendable. The `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` values carried by the four providers, and the credential files under `slp-room/claude-*`, are not preserved anywhere. |
| Gate order | Delete first, smoke room after. There is no fallback room once the wipe starts. |
| Execution | Staged manual: one step at a time, each destructive step confirmed in chat, no migration script. |

Because there is no backup, every safety property in this design comes from
ordering, verification, and small steps — not from a restore path.

## What exists today (verified 2026-10-29)

| Location | State |
|---|---|
| `~/.paseo/config.json` → `agents.providers` | `claude-supervisor`, `claude-lead`, `claude-peer`, `codex-peer`; each extends `claude` or `codex`, pins a `CLAUDE_CONFIG_DIR` into `slp-room`, and three of them set the proxy base URL and token. Each carries `disallowedTools` and (Lead/Peer/Codex Peer) `paseoTools.disabledTools`. |
| `~/.paseo/config.json` → `daemon.agentProfiles` | Five profiles, none of them room profiles: Researcher, Executor, UI/UX Designer, Command Code Default, Claude Default. The old room profiles are already gone; nothing to remove here. |
| `~/.config/slp-room` (920K) | `claude-supervisor/`, `claude-lead/`, `claude-peer/`, `codex-peer/` runtime dirs; `bin/{slp-gc,slp-wait,codex-peer}`; `lead.md`, `peer.md`, `supervisor.md`; `room/` (PROTOCOL.md + roles/); four proxy credential files; `slp-gc.conf`; `install.sh`-generated layout. |
| `~/.claude/skills/supervisor` | `SKILL.md`, `PROTOCOL.md`, `roles/{lead,peer}.md`. |
| `~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist` | Loaded. Runs `slp-room/bin/slp-gc tick` every 60s with `SLP_GC_CONFIG=slp-room/slp-gc.conf`; logs to `~/Library/Logs/slp-gc/launchd.log`. Report-only (`SLP_GC_APPLY=0`, kill flags off). |
| References elsewhere | None. No crontab, no shell rc entry, no schedule, no live agent on an old provider, and neither plugin mentions a removed id except a guard assertion in `agent-room/server/prompts/prompts.test.ts`. |
| `bin/slp-gc` dependencies on `slp-room` | Two: it scans `slp-room/claude-*` for oversized transcripts (guarded by `[ -d ]`, so absence is harmless), and it reads `slp-gc.conf`. It never reads the proxy credential files. |
| Removal mechanism | `paseo provider` has no write subcommands. Providers are removed by editing `config.json` and running `paseo reload`, which reloads configuration without restarting the daemon. |
| Replacement room | In real use: saved seats (Command Code Supervisor and Lead, mixed peer tiers), three rooms recorded, the latest on `~/workspace/minimal-browser`. |

## Scope

Remove:

1. Provider keys `claude-supervisor`, `claude-lead`, `claude-peer`,
   `codex-peer` from `agents.providers`.
2. `~/.claude/skills/supervisor/`.
3. Under `~/.config/slp-room`: `claude-supervisor/`, `claude-lead/`,
   `claude-peer/`, `codex-peer/`, `bin/codex-peer`, `bin/slp-wait`,
   `lead.md`, `peer.md`, `supervisor.md`, `room/`, `anthropic-api-key`,
   `anthropic-auth-header`, `anthropic-base-url`, `auth-mode`.

Keep, unchanged:

- `~/.config/slp-room/bin/slp-gc` and `~/.config/slp-room/slp-gc.conf`.
- `~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist` and
  `~/Library/Logs/slp-gc/`.
- The `claude-worker` provider, all five `agentProfiles`, the `agent-room`
  and `command-code` plugins, and every live room.

## Sequence

Each step is confirmed in chat before it runs. Steps 1–3 are destructive.

**Step 0 — preflight (read-only).** Confirm the `agent-room` plugin is
`running`, saved seats exist, the launchd job is loaded, the running room on
`minimal-browser` is untouched by provider removal (its seats are `claude`
and `command-code`), and print the exact delete list with path and size.
Re-run the reference sweep over `~/.claude`, `~/.agents`, `~/.paseo/schedules`,
`~/.paseo/projects`, and the shell rc files.

**Step 1 — providers.** Delete the four keys from `config.json`, run
`paseo reload`, then `paseo provider ls` to confirm the four ids are absent and
`claude`, `codex`, `opencode`, `pi`, `copilot`, `antigravity`, `muse`,
`claude-worker` are still listed. This step is reversible in shape: the four
blocks are plain JSON and can be re-added (without working credentials).

**Step 2 — files.** Delete the supervisor skill directory and the
`slp-room` group from Scope item 3, after printing the resolved list. Verify
afterwards that `slp-room` contains only `bin/slp-gc` and `slp-gc.conf`.

**Step 3 — gc still works.** Run `slp-gc report` manually with
`SLP_GC_CONFIG` set to the kept conf and require exit 0 and a parseable
report; then confirm the launchd job writes a fresh line to its log within one
tick. This proves the kept pieces survived the deletions, including the
transcript scan that no longer finds `claude-*` directories.

**Step 4 — smoke room (non-destructive).** Start a `[room:supervisor]` agent on
the saved Command Code seat with a small task that writes one file. Confirm: a
`[room:lead]` child and one `[room:peer:*]` child exist with the configured
provider/model, the peer wrote the file, and the feed recorded the exchange.
Then archive the smoke agents.

**Step 5 — docs.** Update `agent-room/OVERVIEW.md` wherever it still describes
the old setup or the side-by-side period, and add
`agent-room/docs/acceptance-phase2-2026-10-29.md` recording each step's
evidence.

## Failure handling

| Failure | Response |
|---|---|
| `paseo reload` rejects the edited config | Stop. Re-add the four provider blocks as JSON, reload, report. Provider routing returns but the proxy credentials are gone, so the old room would not actually run. |
| A remaining provider list is wrong after reload | Same as above. |
| The smoke room fails after deletion | Stop. Phase 2 is blocked on an agent-room defect and the path upgrades to a phase-1 fix; there is no old room to fall back to. |
| `slp-gc` fails after deletion | Fix forward by pulling Phase 3 (the port) ahead, since nothing gc needs was deleted. |
| A preflight reference sweep finds a consumer we missed | Stop and report before Step 1. That consumer becomes a scope decision, not an improvised deletion. |

## Acceptance (Phase 2 done when)

1. `paseo provider ls` does not list the four removed ids and still lists the
   providers in Step 1.
2. `~/.claude/skills/supervisor` does not exist and no loaded skill is named
   `supervisor`.
3. `~/.config/slp-room` contains only `bin/slp-gc` and `slp-gc.conf`.
4. The launchd job is loaded, `slp-gc report` exits 0, and the log shows a tick
   after the deletions.
5. A smoke room runs end to end on the saved seats: Supervisor starts a Lead,
   the Lead starts a Peer, the Peer writes the file, the feed shows it.
6. `agent-room` `npm test` and `npm run typecheck` still pass.
7. `agent-room/OVERVIEW.md` and the phase-2 acceptance record are updated.

## Non-goals

- Porting `slp-gc` into the plugin (Phase 3).
- Removing `claude-worker`, or any provider other than the four named.
- Cleaning up archived agents from the old room.
- Changes to `command-code-provider` or to any agent-room code.
- Removing the `slp-gc` launchd job.

## Known limits

- No backup exists for anything removed. Deletion is final, including the proxy
  credentials.
- Rollback for Step 1 restores routing shape only; the old room cannot run
  without credentials the user chose not to keep.
- If a consumer of the old setup exists outside the swept locations (a remote
  machine, a phone pairing, a note in an unswept config), this design will not
  find it.
- Phase 2 leaves `~/.config/slp-room` in place as a gc home, so the directory
  name outlives the room it was created for until Phase 3 moves gc.
