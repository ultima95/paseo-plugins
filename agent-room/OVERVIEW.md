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

Room state is one `rooms.json` under the daemon's plugin data directory (`$PASEO_HOME/plugin-data/agent-room`, or `~/.paseo/plugin-data/agent-room` when `PASEO_HOME` is unset). It holds rooms, seats, and each room's newest 500 feed events, and it is the plugin's only store.

## Known limits

- Provider-native sub-agents, such as Claude's `Task` tool, Codex multi-agent, and similar features, never appear as Paseo agents, so the guard cannot see them. The protocol forbids them; that is a prompt rule only.
- A Lead's schedule and heartbeat tools cannot be turned off per seat. The protocol forbids scheduling work from a Lead; that is a prompt rule only.
- An agent can pass `notifyOnFinish: false`, and the plugin cannot force it back on. Leaving it on is a prompt rule only.
- An agent created without a parent link, from a detached `create_agent` call or the `paseo` CLI in a seat's shell, escapes the guard entirely. Only a child the Paseo MCP `create_agent` tool created carries the link the guard reads, so avoiding the other forms is a prompt rule only.
- Seats are global. Every room running at the same time uses the same saved seats, and a seat change applies to the next agent created, including a Peer a running Lead launches later.
