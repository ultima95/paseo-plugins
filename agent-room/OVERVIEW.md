Agent Room runs a supervised team of Paseo agents around one or more tasks: a Supervisor that works with you, a Lead per independent task, and worker roles that do bounded work. The room protocol reaches every role as a system prompt and the plugin enforces it, so the same room runs on Claude Code, Codex, Command Code, and the other providers Paseo supports.

## Three kinds of role

Every role has a kind, and the kind is the whole hierarchy:

- `supervisor`: the root of the room, your only point of contact, and the room's orchestration plane. It pins down what you want, dispatches every independent task to its own Lead as it arrives, keeps them on course against that intent, and reports back. It does not edit project work.
- `lead`: owns project framing, technical decisions, integration, verification, and acceptance, and launches worker roles.
- `worker`: takes one bounded outcome from a Lead and talks to that Lead in both directions. It launches nothing.

A role is a name, a kind, a seat (provider, model, and optionally a mode, a thinking level, and provider feature values), a `use for` line, and an optional brief. Roles are saved as one host settings document, so one catalog serves every room on the daemon and survives a plugin reload. The schema requires at least three roles: exactly one supervisor, at least one lead, and at least one worker. Ids and names are unique (names case-insensitively), a name is at most 20 characters and may not contain a colon, because the name is what the title parser reads.

The stock catalog is nine roles. The Claude roles run in `bypassPermissions`; the two Codex roles run in `full-access`, because `bypassPermissions` is a Claude mode id and Codex offers `auto`, `auto-review` and `full-access` instead. The catalog is `Supervisor` (supervisor, `claude/claude-opus-5-5` at `xhigh`), `Lead` (lead, `claude/claude-opus-5-5` at `high`), and seven worker roles — `Implementer` and `Researcher` (`claude/claude-sonnet-5-5` at `medium`), `Reviewer` (`claude/claude-sonnet-5-5` at `high`, with a read-only brief), `Mechanic` (`claude/claude-haiku-4-5` at `medium`), `Specialist` (`claude/claude-opus-5-5` at `medium`), and `Codex` and `Codex Review` (`codex/gpt-5.6-sol` at `medium` and `high`). A Lead picks a role because it fits the work, not because it was told which model to use. The old `peerTiers` document is still read and transformed into roles on load, so an existing settings file keeps working; the first save writes the role shape.

## Orchestration is parallel

The Supervisor is an orchestrator, not a queue. Every independent task Human sends becomes its own Lead, and the ready ones are launched together in one turn; the Supervisor never makes a task wait for a running Lead to finish and never holds a turn open to watch one. A new task arriving mid-run is dispatched in the same turn. Sequencing is reserved for a task whose input is not ready or whose write scope overlaps another Lead's. The guard keeps the hierarchy — a Supervisor creates only Leads, a Lead only workers — and records every Lead create as a `dispatch` row in the room feed, so parallel tasks are visible there and in the status card. Supervision is event-driven: Paseo finish, error and permission notifications wake the Supervisor, and its `supervisor: room` heartbeat every 2 minutes covers the idle gaps. No seat blocks or polls (`paseo wait`, `sleep`, `pgrep`, retry loops), because a blocked Supervisor is what serialized the room.

## Titles decide roles

Every room agent carries its role in the first token of its title:

```
<Role name>: <text>
```

`Supervisor: migrate billing`, `Lead: billing migration`, `Reviewer: audit the diff`, `Implementer: fix invoice rounding`. The name is matched case-insensitively against the catalog, the separator is a single colon, and the rest of the title is free text — the task, workstream, or bounded outcome; the plugin writes it as `<role name>: <text>`. Titles stay under Paseo's 60-character cap: the writer truncates the text and never the role name, so the role stays readable on a long title.

The role name selects the seat. The plugin forces that role's provider, model, mode, thinking level, and feature values onto the create request, and a provider or model named anywhere else in the request is ignored. A control the role leaves unset is removed from the request rather than taken from the caller, along with the caller's provider-specific options when the role changes provider. The provider-agnostic `mcpServers` and `toolPolicy` are left alone.

A colon is required, and the name must be in the catalog. `Reviewer audit the diff` (no separator) and `Data migration: phase 2` (no such role) name no role, so an ordinary title is never seized just for starting with a word.

Legacy titles are read, never written. A room created before this grammar keeps working for one release: `[room:supervisor] <task>`, `[room:lead] <workstream>`, and `[room:peer:<tier>] <bounded outcome>` are parsed and mapped onto the catalog — supervisor and lead onto those roles, and a tier onto its successor role, so `default` runs as `Implementer`, `cheap` as `Mechanic`, `expensive` as `Specialist`, `review` as `Reviewer`, and `cross-family` and `cross-family-review` as `Codex` and `Codex Review`. A tier that is no longer configured falls back to the first worker role, logs `unknown legacy peer tier`, and records a feed note naming the tier and the role it got. No emitted title contains a bracket marker again, and no agent's title is rewritten in place: an existing agent keeps its title until it is archived.

A title that names no configured role is unmanaged. The plugin never modifies, records, or steers such an agent, whatever its parent or its task looks like. The one exception is a child created by a room seat, which the guard treats as a violation and archives, as described under The guard.

## Members

A member is a durable Supervisor or Lead: a name, a role (`supervisor` or `lead`), a seat, a memory policy, a charter, and the lessons it has learned. A role is the seat recipe every room shares; a member is the identity that keeps what that seat learned, so it outlives one room and is reused by the next. Members are not worker roles. A worker is launched by a Lead for one bounded outcome and carries no memory of its own, so only the two seats a room binds — Supervisor and Lead — can be bound to a member.

A room launched on a member runs that member's seat. The Supervisor is created on it directly — the plugin forces the member's provider, model, mode, thinking level, and feature values onto the create request, the same way a title forces a role's — and the Supervisor's role table shows the Lead member's provider and model, so the first Lead it launches arrives on the Lead member's seat and the plugin completes that seat from the member. A room launched with no member named runs the catalog role's seat and records no member ids, which is what every room created before members looks like. The first load of a version 1 `rooms.json` seeds two members from the saved catalog — `default-supervisor` and `default-lead`, named after the Supervisor and Lead roles and carrying their seats — and never re-seeds: an existing or corrupt `members.json` is left alone. The Members screen writes one whole member record at a time, its charter, and the accept or reject of a pending candidate, and shows the lessons and episodes the member has accumulated.

## Memory scopes

Memory is scoped so a lesson reaches the rooms it is true for and no others. A scope is one of three strings:

- `global` — true for every room on this daemon.
- `repo:<sha8>` — one repository, identified by the first eight hex characters of the SHA-256 of its normalized identity.
- `workspace:<path>` — one workspace directory, matched exactly after normalizing its trailing slash.

A room loads the lessons in `global`, its repository's scope when it has one, and its own workspace's scope. Repository identity is the normalized `origin` remote — host and path, without the transport, the user, or a `.git` suffix, so two clones of one repository share a scope — and a repository with no remote falls back to its root path. A room whose directory cannot be resolved loads `global` only.

## Promotion

A finished room proposes; it does not write lessons by itself. When a room is archived, its episodes become candidates — one per decision and one per rejection — scoped to the room's repository, or to its workspace when it has no repository, and each candidate is routed by the member's memory policy:

- `human` — every candidate waits in the member's `pending.jsonl` until someone accepts it on the Members screen. Accepting writes a lesson; rejecting appends a tombstone carrying the same id, so the candidate is not proposed again.
- `auto` — a candidate whose scope type is listed in `autoScopes` becomes a lesson without review. The default `autoScopes` is `["repo", "workspace"]`, so a repository or workspace lesson is promoted while a `global` one still waits for review.

A candidate is dropped when the same lesson already exists in the same scope. Its id is content-addressed from the scope and the normalized text, so the same decision in the same scope always proposes the same candidate.

## Episodes

An episode is a deterministic row taken from what a Supervisor or Lead turn actually said. Five signals become facts and nothing else does: `DECISION_NEEDED` becomes a decision, `REJECT` a rejection, `BLOCKED` a blocked row, and `ACCEPT` and `DONE` an outcome. A worker's signals reach its Lead as messages and contribute no episode of their own. The signals are read from the room feed row a turn already wrote, an obvious credential in the text is replaced with `[redacted]` before the fact is stored, and closing a room adds one `outcome` fact carrying a shortened copy of the room's task. An episode is not retrieved into a prompt in v1: only the lessons promoted from it reach a prompt, and the Members screen shows the rest read-only.

## Prompt delivery

Every role gets its prompt through `config.systemPrompt`: any system prompt the caller already set is kept first, and the shared protocol, the role's kind prompt, the role's own brief, the member section when the seat is bound to a member, and a role table rendered from the saved catalog are appended after it, in that order. The member section names the member, its charter, and up to 12 of the lessons in the scopes the room loads, newest first; an oversized charter, lessons beyond 12, or a section over its cap are truncated deterministically and the room feed gets one `member note`. The brief is how a `Reviewer` becomes the worker prompt plus review-specific instructions. Turn reports are not relayed by the plugin. A child's report reaches its parent through Paseo's native `notifyOnFinish` completion notification.

The separate `command-code` plugin carries the same prompt to Command Code roles. It is not bundled with agent-room. Command Code has no ACP field for a session system prompt, so that plugin stages the prompt in a per-connection file and ships a small Command Code mod that appends it.

## The guard

A Supervisor may create only Leads, a Lead only worker roles, and a worker role nothing. When a room agent breaks that rule, the new child is archived, the violator is told which rule it broke and which title to use instead — named from the catalog, so the message says `Lead: <workstream>` or `Implementer: <outcome>` for the roles actually configured — the room feed gets a guard row, and a worker's Lead also gets a `room-guard` row in its timeline. A child whose title names no role carries no role, so it counts as the same kind of violation and is archived the same way: that is the only case in which an unmanaged agent is touched.

## Room screen and live view

The Room screen holds the role editor (one card per role with its name, kind, provider, model, mode, thinking level, features, `use for`, and brief, plus adding a role and removing a worker role; the kind is offered only on worker rows, because the catalog must keep exactly one supervisor and at least one lead), the launch form (a task and either a workspace or a directory), and the room list. The sidebar row opens that screen, and its chevron opens a popover of recent rooms that jumps straight into one. `/room <task>` starts a room for the current workspace from the composer, and `/room` alone opens the Room screen. The launch form also carries two member pickers — a Supervisor member and a Lead member — that offer only the members of that role, and the Members screen opens from its own sidebar row (the `UserCog` icon) or the Command Center's "Members" entry.

The live view of one room shows the role tree depth first from the Supervisor, with each agent's role name, provider, model, and live status, and the room feed oldest first with sender, recipient, and label. Both refresh every 2 seconds. A tap on an agent opens it on hosts that offer agent navigation.

The Supervisor ends every turn with one room-state block inside a `room-status` fenced code block. The plugin's timeline transformer parses that fence, and its timeline renderer draws it as a native card: one surface per Lead with the workstream, its live state, the current detail, running workers, and the worker the Supervisor is blocking on. The reply text around the fence stays Markdown, the room feed shows the same rows as plain lines, and a host without the plugin shows the fence as preformatted text.

## Setup

A room uses the providers you have already signed in on the daemon machine, so set each role to a provider, model, mode, and thinking level that is available there. The plugin needs no account, token, or API key of its own, and Paseo 0.13.1 or newer. A Command Code role also requires the separate `command-code` plugin installed and enabled on the daemon alongside agent-room, because that plugin is what delivers the role prompt; without it the agent starts but arrives with no room prompt.

Room state is `rooms.json` (version 2) and `members.json` (version 1) under the daemon's plugin data directory (`$PASEO_HOME/plugin-data/agent-room`, or `~/.paseo/plugin-data/agent-room` when `PASEO_HOME` is unset). Member memory lives in `members/<memberId>/`: `charter.md`, `lessons.jsonl`, `pending.jsonl`, and `episodes/<roomId>.jsonl`. `rooms.json` is forward-only after version 2. It holds rooms, the member ids a room is bound to, the room's role seats, and each room's newest 500 feed events; the GC state directory below is the plugin's other store.

## Garbage collection

The plugin carries a port of the `slp-gc` collector: one GC screen, one 60 s in-process tick, and three rules that are all off by default.

- **The screen** (`gc.status` and `gc.run`) shows the last tick's own verdicts, the rule toggles and the thresholds they act on, the candidates a reclaim would take with the reason each other row is refused, the process rows with the warn verdict, the newest `alerts.log` lines, and every `gc.run` answer the screen started. Two buttons run one tick now: "Run report now" and "Reclaim now". A run requested while a tick is in flight is refused, never queued.
- **Three rules, all off**: reclaim (`SLP_GC_APPLY`) deletes completed schedules and long-archived agents through the paseo CLI; kill stale (`SLP_GC_KILL_STALE`) and kill over-memory (`SLP_GC_KILL_MEMORY`) signal processes, and both also require `SLP_GC_APPLY=1`. Off by default is the posture, not a placeholder: the plugin records, samples, reports and alerts, and touches nothing.
- **Thresholds** come from two layers now — the plugin's own `gc` settings document edited from the screen, and the code defaults: warn at 3072 MB, kill at 4096 MB, tree warn at 50 % of RAM, orphan minimum age 10 min, test-concurrency warn 3, at most 10 signals per tick, a 45 s tick budget, and one report an hour. The reference's `~/.config/slp-room/slp-gc.conf` (KEY=VALUE) was the first layer, imported once per process and logged as `gc conf imported { keys: 3, problems: 0 }`; the removal deleted both the file and `~/.config/slp-room`, so that import now finds nothing and yields the code defaults. A settings read that fails or times out falls back to the imported baseline, never to an acting posture.
- **State** is one directory, `~/.paseo/plugin-data/agent-room/gc`: `memory.jsonl` with its rotated `.1`, `lineage.tsv`, `alerts.log`, `reports/`, and the `.last-report` and `.alert-stamp` stamps. It was seeded once from the reference's `~/Library/Logs/slp-gc`, read-only, and it keeps the reference's 5 MB rotation with one predecessor.
- **The watchdog is plugin-only.** The tick is a timer inside the plugin, so it has no supervisor above it: the reference ran under launchd, which restarted it every 60 s whatever the last run did, while here a hung daemon stops its own watchdog with it. What remains is cooperative — a 45 s tick budget, per-command timeouts, and one mutex that keeps a second tick from overlapping the first.
- **Disabling `agent-room` disables GC entirely**: no tick, no `gc.status` or `gc.run`, no state writes. The state directory and its migrated files stay where they are.

## Known limits

- Provider-native sub-agents, such as Claude's `Task` tool, Codex multi-agent, and similar features, never appear as Paseo agents, so the guard cannot see them. The protocol forbids them; that is a prompt rule only.
- A Lead's schedule and heartbeat tools cannot be turned off per role. The protocol forbids scheduling work from a Lead; that is a prompt rule only.
- An agent can pass `notifyOnFinish: false`, and the plugin cannot force it back on. Leaving it on is a prompt rule only.
- An agent created without a parent link, from a detached `create_agent` call or the `paseo` CLI in a role's shell, escapes the guard entirely. Only a child the Paseo MCP `create_agent` tool created carries the link the guard reads, so avoiding the other forms is a prompt rule only.
- Roles are global. Every room running at the same time uses the same saved catalog, and a role change applies to the next agent created, including a worker a running Lead launches later. Role names are reserved on this daemon, and a role rename is not supported: add a role under the new name and archive the old one, which keeps legacy titles resolvable.
- A title is the only pre-create channel the plugin has. Paseo's `agent.create` hook exposes no labels, so an agent titled with an ordinary `Word: text` that happens to equal a configured role name is read as that role.
- One Lead member per room, and every Lead in a room shares it. A room binds one Supervisor member and one Lead member; a second Lead launched later runs the same member, memory included.
- The pre-create hook sees no parent and no room, so it recognizes a Lead member's seat by matching provider and model. Two Lead members saved on the same seat are indistinguishable there, and the first one in the list is the member that seat is read as.
- Global candidates are not produced by a live room in v1. A room's candidates are scoped to its repository or workspace, so a `global` lesson arrives only through an explicit import or a test, and it defaults to pending under the shipped policies.
- The `room-status` card does not show member names. The role tree and the room list name the member behind a bound seat; the Supervisor's status card stays role-only.
- No worker members, no mid-room memory edits, and no cross-member memory. Only a Supervisor or Lead seat has member memory; lessons are promoted when the room closes and a member's lessons are read by that member alone.
- `rooms.json` is forward-only after version 2: do not roll the plugin back, because the previous schema cannot read member bindings or role-only seats.
