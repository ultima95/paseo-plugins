Agent Room runs a supervised team of Paseo agents around one task: a Supervisor that works with you, a Lead that owns the project, and worker roles that do bounded work. The room protocol reaches every role as a system prompt and the plugin enforces it, so the same room runs on Claude Code, Codex, Command Code, and the other providers Paseo supports.

## Three kinds of role

Every role has a kind, and the kind is the whole hierarchy:

- `supervisor`: the root of the room and your only point of contact. It pins down what you want, launches Leads, keeps them on course against that intent, and reports back. It does not edit project work.
- `lead`: owns project framing, technical decisions, integration, verification, and acceptance, and launches worker roles.
- `worker`: takes one bounded outcome from a Lead and talks to that Lead in both directions. It launches nothing.

A role is a name, a kind, a seat (provider, model, and optionally a mode, a thinking level, and provider feature values), a `use for` line, and an optional brief. Roles are saved as one host settings document, so one catalog serves every room on the daemon and survives a plugin reload. The schema requires at least three roles: exactly one supervisor, at least one lead, and at least one worker. Ids and names are unique (names case-insensitively), a name is at most 20 characters and may not contain a colon, because the name is what the title parser reads.

The stock catalog is nine roles, all in `bypassPermissions`: `Supervisor` (supervisor, `claude/claude-opus-5-5` at `xhigh`), `Lead` (lead, `claude/claude-opus-5-5` at `high`), and seven worker roles — `Implementer` and `Researcher` (`claude/claude-sonnet-5-5` at `medium`), `Reviewer` (`claude/claude-sonnet-5-5` at `high`, with a read-only brief), `Mechanic` (`claude/claude-haiku-4-5` at `medium`), `Specialist` (`claude/claude-opus-5-5` at `medium`), and `Codex` and `Codex Review` (`codex/gpt-5.6-sol` at `medium` and `high`). A Lead picks a role because it fits the work, not because it was told which model to use. The old `peerTiers` document is still read and transformed into roles on load, so an existing settings file keeps working; the first save writes the role shape.

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

## Prompt delivery

Every role gets its prompt through `config.systemPrompt`: any system prompt the caller already set is kept first, and the shared protocol, the role's kind prompt, the role's own brief, and a role table rendered from the saved catalog are appended after it, in that order. The brief is how a `Reviewer` becomes the worker prompt plus review-specific instructions. Turn reports are not relayed by the plugin. A child's report reaches its parent through Paseo's native `notifyOnFinish` completion notification.

The separate `command-code` plugin carries the same prompt to Command Code roles. It is not bundled with agent-room. Command Code has no ACP field for a session system prompt, so that plugin stages the prompt in a per-connection file and ships a small Command Code mod that appends it.

## The guard

A Supervisor may create only Leads, a Lead only worker roles, and a worker role nothing. When a room agent breaks that rule, the new child is archived, the violator is told which rule it broke and which title to use instead — named from the catalog, so the message says `Lead: <workstream>` or `Implementer: <outcome>` for the roles actually configured — the room feed gets a guard row, and a worker's Lead also gets a `room-guard` row in its timeline. A child whose title names no role carries no role, so it counts as the same kind of violation and is archived the same way: that is the only case in which an unmanaged agent is touched.

## Room screen and live view

The Room screen holds the role editor (one card per role with its name, kind, provider, model, mode, thinking level, features, `use for`, and brief, plus adding a role and removing a worker role; the kind is offered only on worker rows, because the catalog must keep exactly one supervisor and at least one lead), the launch form (a task and either a workspace or a directory), and the room list. The sidebar row opens that screen, and its chevron opens a popover of recent rooms that jumps straight into one. `/room <task>` starts a room for the current workspace from the composer, and `/room` alone opens the Room screen.

The live view of one room shows the role tree depth first from the Supervisor, with each agent's role name, provider, model, and live status, and the room feed oldest first with sender, recipient, and label. Both refresh every 2 seconds. A tap on an agent opens it on hosts that offer agent navigation.

The Supervisor ends every turn with one room-state block inside a `room-status` fenced code block. The plugin's timeline transformer parses that fence, and its timeline renderer draws it as a native card: one surface per Lead with the workstream, its live state, the current detail, running workers, and the worker the Supervisor is blocking on. The reply text around the fence stays Markdown, the room feed shows the same rows as plain lines, and a host without the plugin shows the fence as preformatted text.

## Setup

A room uses the providers you have already signed in on the daemon machine, so set each role to a provider, model, mode, and thinking level that is available there. The plugin needs no account, token, or API key of its own, and Paseo 0.13.1 or newer. A Command Code role also requires the separate `command-code` plugin installed and enabled on the daemon alongside agent-room, because that plugin is what delivers the role prompt; without it the agent starts but arrives with no room prompt.

Room state is one `rooms.json` under the daemon's plugin data directory (`$PASEO_HOME/plugin-data/agent-room`, or `~/.paseo/plugin-data/agent-room` when `PASEO_HOME` is unset). It holds rooms, the room's role seats, and each room's newest 500 feed events; the GC state directory below is the plugin's other store.

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
