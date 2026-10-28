# Agent Room plugin — Phase 1 design (room core)

Date: 2026-10-28
Status: draft, awaiting approval

## Intent and why

The Supervisor ⇄ Lead ⇄ Peer room ("SLP room") is a working multi-agent
protocol, but today it only runs on Claude Code. Every seat gets its role
through Claude-specific plumbing:

- role prompts are rendered by `install.sh` into Claude output styles under
  per-provider `CLAUDE_CONFIG_DIR`s (`~/.config/slp-room/claude-*`);
- seat restrictions use Claude's `disallowedTools` and per-provider
  `paseoTools.disabledTools` on the `claude-supervisor`, `claude-lead`,
  `claude-peer` providers;
- Codex can only sit as a Peer, through the `codex-peer` shell wrapper;
- the Supervisor role ships as a Claude skill (`~/.claude/skills/supervisor`).

So Codex, OpenCode, Pi, Command Code, Copilot, etc. cannot run as Supervisor
or Lead. The user wants the room to belong to Paseo instead of Claude: any
provider in any seat, configured from the Paseo app.

The routing itself is already provider-neutral: `create_agent`,
`send_agent_prompt`, `notifyOnFinish`, heartbeats are Paseo MCP tools that
every agent gets. What's missing is role delivery, seat configuration,
enforcement, and visibility. A Paseo plugin can supply all four.

## Phasing

This document covers **Phase 1 only**.

| Phase | Scope |
|---|---|
| 1 (this doc) | Room core: seat config, role injection, seat guard, Room screen, `/room`, live view. Includes whatever fix makes Command Code honor the injected role, because the acceptance run needs it. |
| 2 | Migration off the old Claude setup: back up `~/.paseo/config.json`, remove `claude-supervisor`/`claude-lead`/`claude-peer`/`codex-peer` providers and the room profiles, remove the `supervisor` skill and `~/.config/slp-room`. Every destructive step confirmed by the user. Separate design. |
| 3 | Port `slp-gc` (memory / orphan process / archived-agent cleanup) into the plugin. Separate design. |

Phase 1 must not touch the old setup; both run side by side until Phase 2.

## Goals

1. Any Paseo provider can run any seat (Supervisor, Lead, any Peer tier).
2. The user configures, per seat: provider ("tool"), model, effort
   (thinking option), mode, and provider feature values — from the Paseo
   app, saved as defaults.
3. Every seat agent receives the room protocol plus its role as its system
   prompt, regardless of provider.
4. Seat rules are enforced by the plugin, not only by prompt (see Guard).
5. The user can watch a running room live: tree of seats plus message feed.
6. A room can be started from a Room screen or from `/room <task>`.

## Non-goals (Phase 1)

- Migration / removal of the old Claude setup (Phase 2).
- `slp-gc` (Phase 3).
- A plugin-side relay of turn-end reports. Paseo's native `notifyOnFinish`
  already delivers a child's finish/error/permission (with its last
  response) to the creator on any provider. Use it.
- Per-seat tool allow/deny lists. ("Tool" in the requirements means which
  coding agent runs the seat.)
- Rewriting the protocol's substance (authority, signals, evidence rules).

## Anti-goals (fails even if it technically works)

- Any remaining dependency on Claude Code for a room to function
  (Claude-only tools, output styles, `CLAUDE_CONFIG_DIR`, Claude skill).
- Seat config that agents can silently ignore (e.g. a Lead launching a Peer
  on a model the user didn't configure).
- A Peer, or a Lead, quietly growing its own sub-tree of agents.
- Breaking or modifying the user's current Claude room before Phase 2.

## Constraints

- Lives in this repo as a new plugin directory beside `schedule-sending`
  and `command-code-provider`, same conventions: `paseo-plugin.json`,
  `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`,
  `vitest`, `tsc --noEmit`, `OVERVIEW.md`.
- Target the installed Paseo (0.13.1); set `requirements.paseo` to the
  minimum that has every API used. Use the current `@getpaseo/plugin` SDK
  (the repo's other plugins pin 0.10.1 / 0.12.0).
- Client UI: React Native primitives only, colors from `theme.colors`,
  works in compact layout (see the `paseo-plugin` skill's mobile audit).
- Do not restart the daemon to load changes; use `paseo plugin reload`.

## Decided by the user

| Topic | Decision |
|---|---|
| Plugin does | Both: room setup and live room view |
| Providers | Any provider in any seat; Command Code is the concrete priority |
| Start a room | Both a Room screen (seat setup + launch) and `/room <task>` using saved defaults |
| Seat violation | Guard + kill: prompt rule, plus the plugin archives any agent spawned against seat rules and reports it |
| Live view | Tree + feed (layout below) |
| Old setup | Plugin replaces it (in Phase 2) |
| Turn relay | Native `notifyOnFinish`; no plugin relay |
| slp-gc | Port into the plugin (Phase 3) |
| Phasing | 3 phases as above |
| Done when | A mixed-provider room runs a real small task, and the user can set provider/model/effort/etc. per seat |
| Command Code role delivery | Via a bundled Command Code mod (`appendSystemPrompt`), wired through `command-code-provider` |
| Parentless creates | Known limit: guard covers parent-linked `create_agent` only |

## Design (Phase 1)

### Seats and seat config

Seats: `supervisor`, `lead`, and named Peer tiers. Each seat config holds
`provider`, `model`, `modeId?`, `thinkingOptionId?` (effort), `features?`
(provider feature values) — the same shape `create_agent` takes.

Peer tiers are a user-editable named list, each with a short "use for"
line the Lead sees when choosing. Seed defaults from the user's current
room profiles (`~/.paseo/config.json` → `daemon.agentProfiles`):

| Tier | Seeded from |
|---|---|
| cheap | "Cheap peer" |
| default | "Peer" |
| expensive | "Expensive peer" |
| review | "Review peer" |
| cross-family | "Codex peer" |
| cross-family-review | "Codex review peer" |

(Seeding is the builder's call: read once at first run or hard-code these
values as initial defaults. The plugin never writes to the old profiles.)

Stored with `server.registerSettings` (host scope), versioned with a
`migrate` hook.

### Seat marker

A seat is identified by a namespaced agent title prefix:

- `[room:supervisor] <task>`
- `[room:lead] <workstream>`
- `[room:peer:<tier>] <bounded outcome>`

Reason: `before("agent.create")` receives only `{ config, env }` for
agent-initiated creates; `config` has `title`, but no parent, labels, or
env (the parent label is attached after the hook runs). The namespace is
required because the old Claude room titles its agents `[Lead] …`,
`[Peer] …`, `[Review] …`, `[Committee] …`, `[Advisor] …`; the hook runs
for every non-internal agent, so a bare `[Lead]` would hijack the old room
and break acceptance 6. Agents without a `[room:…]` prefix are never
touched. Keep the marker short: titles are capped at 60 characters.

Seat config is global: every concurrent room uses the same saved seat
config. The hook cannot tell which room a new Lead or Peer belongs to, so
there are no per-room seat overrides.

### Role injection and config enforcement

`server.before("agent.create", …)`: if the title carries a seat marker:

1. **Override** `config.provider`, `config.model`, `modeId`,
   `thinkingOptionId`, `featureValues` with the seat's configured values,
   whatever the creating agent passed. Unknown tier → fall back to the
   `default` tier and say so in the feed.
2. Set `config.systemPrompt` = neutral protocol + that seat's role +
   a rendered seat table (so a Supervisor knows how to title Leads, and a
   Lead knows the Peer tiers and their "use for" lines). Append to an
   existing `systemPrompt` rather than replacing it.

`AgentSessionConfig.systemPrompt` is documented by Paseo as
"provider-agnostic … mapped by each provider to its native instruction
field". The builder must **verify per target provider** (claude, codex,
opencode, command-code at minimum) that the prompt actually reaches the
model.

Verified for claude, codex, opencode: `systemPrompt` reaches the model.

**Command Code (decided: use a Command Code mod).** Paseo's ACP layer
sends the prompt as `_meta._paseo.systemPrompt` on `session/new`, but
Command Code's `handleNewSession` ignores `_meta`; it has no system-prompt
CLI flag or env var, and `AGENTS.md` is global/per-project, not per
session. The one per-session channel is a Command Code mod: mods have an
`appendSystemPrompt` hook, and `cmd acp` honors the global `--mod <path>`
and `--mod-option` flags (`applyModLaunchOptions`).

Phase 1 therefore includes, in `command-code-provider`:

- bundle a small mod whose `appendSystemPrompt` returns the seat role;
- make the connector deliver the session's `systemPrompt` to that mod.
  Paseo starts one ACP process per session, but the connector currently
  spawns it before it knows the session config, so the spawn (or the
  `session/new` handling) must be reworked so the mod receives the prompt
  (e.g. via `--mod-option`, a temp file, or an env var the mod reads).
  Mechanism is the builder's call.

Agents without a `systemPrompt` must behave exactly as today. The initial
prompt is not available to the before hook, so "prepend the role to the
first prompt" is not an option.

### Neutral protocol and roles

Bundle provider-neutral copies of the protocol and the three roles inside
the plugin. Source: `~/.claude/skills/supervisor/PROTOCOL.md`,
`~/.claude/skills/supervisor/SKILL.md` (Supervisor role),
`~/.claude/skills/supervisor/roles/lead.md`, `roles/peer.md`.

Keep the substance (authority, signals, dispositions, evidence,
acceptance). Remove or replace everything Claude- or installer-specific:

- the built-in `Agent`/`Task` tool rules → "never use your agent's own
  built-in sub-agent feature; delegate only with Paseo `create_agent`";
- `install.sh`, `claude-*`/`codex-peer` providers, output styles,
  `CLAUDE_CONFIG_DIR`, `ROOM_DIR` file fallback;
- `list_profiles` / "Lead profile" lookups → the injected seat table and
  the title-marker rule (the plugin enforces the model anyway);
- `slp-wait` → native `notifyOnFinish` (and `paseo wait` only where a seat
  genuinely needs to block);
- `$ARGUMENTS` skill templating.

Supervisor's `create_heartbeat` monitoring stays (Paseo tool, neutral).

### Guard

`server.on("agent.created", …)` with `agent.parentAgentId`:

| Parent seat | Allowed child | Otherwise |
|---|---|---|
| Supervisor | `[Lead]` | archive child |
| Lead | `[Peer:<tier>]` | archive child |
| Peer | none | archive child |
| not a room seat | anything | — |

On archive: tell the violating agent why (one short `send` explaining the
rule and the correct title), and add a guard entry to the room feed. If the
violator is a Peer, also add a plugin timeline row to its Lead's timeline.
Unmarked children of a Lead are archived too: the before hook ran without a
seat, so they carry no role.

Known limits (document in OVERVIEW.md, do not try to solve in Phase 1):

- Provider-native sub-agents (Claude `Task`, Codex multi-agent, …) never
  appear as Paseo agents, so the guard cannot see them. Prompt rule only.
- The old setup disabled schedule/heartbeat tools for Leads per provider.
  Stock providers can't do that per agent; prompt rule only.
- `notifyOnFinish` can be set false by an agent. The plugin cannot force it
  from the before hook; the role prompt forbids it. If the builder finds a
  way to enforce it, do.
- (Decided: known limit.) An agent created without a parent link escapes
  the guard: the older detached `create_agent` form
  (`relationship: {kind:"detached"}`) or the `paseo` CLI from a seat's
  shell. The role prompt forbids both; no creator tracing in Phase 1.

### Rooms

A room is the tree rooted at a `[Supervisor]` agent, followed through
`parentAgentId`. The plugin keeps a small persisted room index (root id,
task, workspace, created, ended) that survives plugin reload and daemon
restart. Storage location is the builder's call.

### Starting a room

- **Room screen** (sidebar item "Room" + Command Center item): seat config
  form for every seat and tier (provider/model pickers populated from Paseo's
  provider and model lists; effort, mode, features), save as defaults; plus a
  Launch form: task text and target workspace or project path.
- **`/room <task>`** slash command (agent and workspace context): launches
  with saved defaults in the current workspace, then opens the live view.

Launch creates the `[Supervisor]` agent through the Paseo SDK with the task
as its initial prompt. The user then talks to that agent in its normal
agent tab.

### Live view: tree + feed

```
┌ Room: fix auth retry ─────────────────────────────┐
│ SEATS              │ FEED                          │
│ ● Supervisor  idle │ 10:02 Sup→Lead  instruction   │
│   command-code     │ 10:05 Lead→Sup  STATUS        │
│ └ ● Lead   running │ 10:06 Lead→Peer brief         │
│   claude/opus      │ 10:14 Peer→Lead CANDIDATE     │
│   ├ ● Peer  done   │ 10:15 Lead→Peer ACCEPT        │
│   │ opencode       │ 10:21 Lead→Sup  DONE          │
│   └ ○ Peer  idle   │                               │
│     codex          │ ⚠ 10:09 Peer spawned agent    │
│                    │   → archived (guard)          │
└────────────────────┴───────────────────────────────┘
```

- Tree: every seat with seat name, provider/model, live status; tapping a
  seat opens its agent.
- Feed: chronological messages between seats, labeled by the protocol
  signal or disposition on the message's first line (`CANDIDATE`, `REVIEW`,
  `DONE`, `DECISION_NEEDED`, `ACCEPT`, `REJECT`, …), else "instruction" /
  "brief" by direction; guard events inline. Expand to read the full text.
- Data sources: lifecycle events (`agent.created`, `agent.turn_started`,
  `agent.turn_ended` with its timeline, `agent.archived`) and agent
  status. How sender identity of a received prompt is determined is the
  builder's call (Paseo supplies caller identity on `send_agent_prompt`;
  fall back to tree position).
- Reachable from the Room screen (room list → room) and after `/room`.
  Compact layout: tree and feed stack.

## Acceptance (Phase 1 done when)

1. From the Room screen, the user sets each seat's provider, model, effort,
   mode, and features; values persist across plugin reload.
2. A real small task runs end to end in a mixed-provider room, e.g.
   Command Code Supervisor → Claude Lead → OpenCode Peer + Codex Peer:
   each seat demonstrably runs with its role (its behavior follows the
   protocol: signals on first line, Lead never edits, etc.) and on the
   configured provider/model even if the creating agent asked for another.
3. Reports flow via native `notifyOnFinish`; the live view shows the tree
   and the feed while the room runs.
4. A forced violation (instruct a Peer to `create_agent`) gets archived,
   the Peer is told, and the feed shows it.
5. `/room <task>` starts a room with saved defaults.
6. Old Claude room still works unchanged.
7. Unit tests cover seat-marker parsing, config override, prompt rendering,
   and guard rules; `npm run typecheck` and `npm test` pass;
   `paseo plugin ls` shows the plugin `running`.

## Calls made by the assistant (not confirmed by the user)

- Plugin name/directory: `agent-room` (provider-neutral name; the room protocol keeps its SLP label).
- Seat marker = namespaced title prefix `[room:<seat>]` /
  `[room:peer:<tier>]`, chosen so it can't collide with the old room.
- No per-room seat overrides; seat config is global (the hook can't map a
  new agent to its room).
- Plugin **overrides** the creating agent's provider/model with the seat
  config, rather than only advising it.
- Unmarked children of a Lead are archived, not auto-adopted as Peers.
- Guard tells the violator directly, plus a timeline row for a Peer's Lead.
- Peer tiers seeded from the current room profiles.
- Room screen as a sidebar screen (not a workspace panel); live view lives
  there too.

## Left to the builder

- Storage for the room index and how seeding reads current profiles.
- Exact feed classification heuristics and sender attribution.
- Whether labels can supplement the title marker.
- How the `command-code-provider` connector hands the prompt to the mod.
- UI component structure, query keys, test layout.
