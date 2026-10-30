Agent Room runs a supervised team of Paseo agents around one task: a Supervisor that works with you, a Lead that owns the project, and Peers that do bounded work. The room protocol reaches every seat as a system prompt and the plugin enforces it, so the same room runs on Claude Code, Codex, Command Code, and the other providers Paseo supports.

## The three seats

- Supervisor: the root of the room and your only point of contact. It pins down what you want, launches Leads, keeps them on course against that intent, and reports back. It does not edit project work.
- Lead: owns project framing, technical decisions, integration, verification, and acceptance, and launches Peers.
- Peer: takes one bounded outcome from a Lead and talks to that Lead in both directions. It launches nothing.

A seat is a provider, a model, and optionally a mode, a thinking level, and provider feature values. Seats are saved as host settings, so one set of seats serves every room on the daemon and survives a plugin reload. The stock seats are Claude seats in `bypassPermissions`, with a `default` peer tier and ready-made `cheap`, `expensive`, and `review` tiers, plus `cross-family` and `cross-family-review` tiers on Codex.

## Titles decide seats

Every room agent carries its seat in the first token of its title: `[room:supervisor] <task>`, `[room:lead] <workstream>`, `[room:peer:<tier>] <bounded outcome>`. The marker selects the seat. The plugin forces that seat's provider, model, mode, thinking level, and feature values onto the create request, and a provider or model named anywhere else in the request is ignored. A control the seat leaves unset is removed from the request rather than taken from the caller, along with the caller's provider-specific options when the seat changes provider. An unknown peer tier runs on the `default` tier and the room feed records the fallback.

An agent whose title carries no marker takes no seat: the plugin never modifies, records, or steers it, whatever its parent or its task looks like. The one exception is a child created by a room seat, which the guard treats as a violation and archives, as described under The guard.

## Prompt delivery

Every seat gets its role through `config.systemPrompt`: any system prompt the caller already set is kept first, and the shared protocol, that seat's role, and a seat table rendered from the saved seats are appended after it. Turn reports are not relayed by the plugin. A child's report reaches its parent through Paseo's native `notifyOnFinish` completion notification.

The separate `command-code` plugin carries the same prompt to Command Code seats. It is not bundled with agent-room. Command Code has no ACP field for a session system prompt, so that plugin stages the prompt in a per-connection file and ships a small Command Code mod that appends it.

## The guard

A Supervisor may create only Leads, a Lead only Peers, and a Peer nothing. When a room agent breaks that rule, the new child is archived, the violator is told which rule it broke and which marker to use instead, the room feed gets a guard row, and a Peer's Lead also gets a `room-guard` row in its timeline. An unmarked child of a room seat carries no role, so it counts as the same kind of violation and is archived the same way: that is the only case in which an agent with no marker is touched.

## Room screen and live view

The Room screen holds the seat editor (a Supervisor seat, a Lead seat, and one editor per peer tier with provider, model, mode, thinking level, features, and when to use it, plus adding and removing tiers), the launch form (a task and either a workspace or a directory), and the room list. The sidebar row opens that screen, and its chevron opens a popover of recent rooms that jumps straight into one. `/room <task>` starts a room for the current workspace from the composer, and `/room` alone opens the Room screen.

The live view of one room shows the seat tree depth first from the Supervisor, with each seat's provider, model, and live status, and the room feed oldest first with sender, recipient, and label. Both refresh every 2 seconds. A tap on a seat opens that agent on hosts that offer agent navigation.

## Setup

A room uses the providers you have already signed in on the daemon machine, so set each seat to a provider, model, mode, and thinking level that is available there. The plugin needs no account, token, or API key of its own, and Paseo 0.13.1 or newer. A Command Code seat also requires the separate `command-code` plugin installed and enabled on the daemon alongside agent-room, because that plugin is what delivers the seat's role prompt; without it the seat starts but arrives with no room prompt.

Room state is one `rooms.json` under the daemon's plugin data directory (`$PASEO_HOME/plugin-data/agent-room`, or `~/.paseo/plugin-data/agent-room` when `PASEO_HOME` is unset). It holds rooms, seats, and each room's newest 500 feed events; the GC state directory below is the plugin's other store.

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
- A Lead's schedule and heartbeat tools cannot be turned off per seat. The protocol forbids scheduling work from a Lead; that is a prompt rule only.
- An agent can pass `notifyOnFinish: false`, and the plugin cannot force it back on. Leaving it on is a prompt rule only.
- An agent created without a parent link, from a detached `create_agent` call or the `paseo` CLI in a seat's shell, escapes the guard entirely. Only a child the Paseo MCP `create_agent` tool created carries the link the guard reads, so avoiding the other forms is a prompt rule only.
- Seats are global. Every room running at the same time uses the same saved seats, and a seat change applies to the next agent created, including a Peer a running Lead launches later.
