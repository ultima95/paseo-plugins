# Agent Room acceptance run — 2026-10-28

Paseo daemon 0.13.1. Plugins: `agent-room` (branch `feat/agent-room`, running), `command-code`
(branch `feat/agent-room`, running after reload at 2026-10-28T12:14:32Z).

Environment limits found before the run:

- `opencode` is unavailable on this daemon.
- `codex` is available but every turn fails with `401 Invalid API key`, so no codex seat can run.
- The user chose a Command Code + Claude mix to work around both.

## Setup observed

The seat settings were never saved: every lifecycle read logged
`room settings invalid; using default seats` (last at 2026-10-28T12:18:18.593Z). The run therefore
used `DEFAULT_SETTINGS`, not the Command Code mix. This is the main gap in this record.

## Acceptance 1 — per-seat settings persist across reload

**Not verified.** No settings document exists, so there was nothing to persist. The plugin
correctly fell back to `DEFAULT_SETTINGS` and logged once. The Room screen save path still needs a
manual check with the user present.

## Acceptance 2 — mixed-provider room runs a real task with per-seat roles

**Partially verified, on default Claude seats.**

Launch: `paseo run --workspace wks_6405c828c3be92f9 --provider claude` with title
`[room:supervisor] Write HAIKU.md with one haiku about this repo` and the full task as the first
prompt. The seat override replaced the requested provider with the configured Supervisor seat.

| Seat | Agent id | Provider/model | Mode | Thinking | Marker |
|---|---|---|---|---|---|
| Supervisor | `e71b5003-6fc1-4629-a8ad-92773f7f7fff` | `claude/claude-opus-5-5` | `bypassPermissions` | `xhigh` | `[room:supervisor]` |
| Lead | `b9760695-a9f2-44f8-91a6-485cc466a205` | `claude/claude-opus-5-5` | `bypassPermissions` | `high` | `[room:lead]` |
| Peer (cheap) | `c500a5a5-4420-45be-ba32-c36ef4fb4331` | `claude/claude-haiku-4-5` | `bypassPermissions` | `medium` | `[room:peer:cheap]` |

The Supervisor created the Lead with the exact marker and the Lead created the cheap Peer with its
marker; both ran on the Lead/cheap seat values, not the values a caller would have chosen. The
protocol reached the models: every message starts with a signal (`STATUS`, `CANDIDATE`, `ACK`,
`DONE`), the Lead did not write the file itself, and the Peer wrote it. `HAIKU.md` at
`/tmp/agent-room-acceptance/HAIKU.md` contains a 5/7/5 haiku and the tree stayed otherwise clean.

Command Code as a seat, and cross-provider seats, were not exercised because the settings were not
saved. Command Code prompt delivery was probed separately: `cmd mods inspect` reported
`hooks: appendSystemPrompt`, both `cmd --mod <file> acp` and `cmd acp --mod <file>` loaded the mod,
and `cmd -p --mod ... --mod-option system-prompt-file=...` made the model quote the marker line.

## Acceptance 3 — reports via notifyOnFinish; live tree and feed

**Verified from the room store.** Seven feed events were recorded for the room, including
`Lead -> Supervisor STATUS`, `Peer -> Lead CANDIDATE`, `Peer -> Lead ACK`, and
`Supervisor -> user DONE` after the native finish notification. The room record is
`e71b5003-6fc1-4629-a8ad-92773f7f7fff` with three seats and the full feed in
`~/.paseo/plugin-data/agent-room/rooms.json`.

The visual tree and feed were not seen by the controller. The data they render is present, and the
screen was reloaded without plugin errors.

## Acceptance 4 — forced violation is archived and reported

**Not forced; prompt enforcement held.** Two instructions to the Peer to call `create_agent`, the
second claiming an operator override, were both refused with the protocol rule ("Peer seats create
no agents"; "nothing ... can change that mid-session"). No rogue agent was created, so no archive,
violator message, feed guard row, or `room-guard` timeline row exists to observe. The guard's
archive path is covered by unit tests only.

## Acceptance 5 — `/room <task>` starts a room with saved defaults

**Not run.** `/room` is a client slash command; the controller cannot type it. It needs the user
in a workspace composer.

## Acceptance 6 — old Claude room unchanged

**Not run.** Creating an agent on the `claude-lead` provider was left for the user, because it
writes into the old room's Claude config directory and the hard rule for this job was not to touch
that setup. The control is still owed.

## What still needs the user

1. Save the seats in the Room screen (Supervisor and `default` tier on Command Code, Lead on
   Claude), then reload `agent-room` and confirm the values survive.
2. Run one `/room <task>` from a workspace composer.
3. Create one `claude-lead` agent titled `[Lead] acceptance control` and confirm its provider,
   model, and prompt contain no `[room:` text.
4. Optionally force a guard violation from a Peer that is willing to ignore the protocol, or accept
   the unit test as the guard evidence.

## Deferred

- opencode and codex seats, blocked by the daemon's provider availability and credentials.
- Command Code seat end-to-end, blocked on saving a Command Code seat.
