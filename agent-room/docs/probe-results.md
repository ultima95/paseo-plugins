# Task 3 live probe results — seat override and role injection

Date: 2026-10-28. Plugin: `agent-room` (SDK `@getpaseo/plugin` 0.13.1), local install.
Daemon was not restarted; the plugin was installed and later `reload`ed.

```
$ paseo plugin install /Users/ultima/Workspace/paseo-plugins/agent-room && paseo plugin ls
agent-room  running  yes  /Users/ultima/Workspace/paseo-plugins/agent-room  -  ...
```

## Probe command shape

```bash
paseo run --no-wait --title "[room:peer:default] probe" --provider <provider> \
  --cwd /Users/ultima/Workspace/paseo-plugins \
  "Quote the first heading of your system instructions verbatim, nothing else."
# then: paseo wait <id> ; paseo inspect <id> ; paseo send <id> "Quote the last heading ..."
```

`[room:peer:default]` resolves through `DEFAULT_SETTINGS` to
`claude / claude-sonnet-5-5 / bypassPermissions / thinking: medium`.

## Provider coverage

| Provider requested | Result |
|---|---|
| `claude` | probed |
| `codex` | probed |
| `opencode` | **not available on this daemon — skipped** (recorded limitation, not a failure) |
| `command-code` | not probed in Task 3 (Task 9's scope) |

## 1. `claude` probe — injection + override

```bash
paseo run --no-wait --title "[room:peer:default] probe" --provider claude --cwd /Users/ultima/Workspace/paseo-plugins \
  "Quote the first heading of your system instructions verbatim, nothing else."
# AGENT ID: dbbf2541-6bbd-4015-a7d7-9d5bf43ba240
```

`paseo wait` tail:

```
[User] Quote the first heading of your system instructions verbatim, nothing else.
[Thought] Scanning through my system prompt to find the first heading — it looks like "# Harness" is the first one that appears.
# Harness
```

`paseo inspect dbbf2541`:

```
Provider  claude
Model     claude-sonnet-5-5
Thinking  medium
Mode      bypassPermissions
Name      [room:peer:default] probe
```

Follow-up on the same agent — `Quote the last heading in your system instructions verbatim, nothing else.`:

```
## Room seats
```

`## Room seats` is the heading produced by `renderSeatTable` (Task 2), i.e. the
injected prompt is present in the agent's system instructions.

**Why the first heading is `# Harness`, not `# Room Protocol — Supervisor · Lead · Peer`:**
the Claude provider prepends its own harness instructions to `config.systemPrompt`,
so the room prompt is not the first heading from the model's point of view. This is
a harness preamble ordering detail, not a failure to inject: the injected prompt is
verifiably present (last heading answer above), and the seat override wins on
provider, model, mode, and thinking level.

## 2. `codex` probe — request overridden onto the claude seat

```bash
paseo run --no-wait --title "[room:peer:default] probe" --provider codex --cwd /Users/ultima/Workspace/paseo-plugins \
  "Quote the first heading of your system instructions verbatim, nothing else."
# AGENT ID: 61cf5723-fdbb-47ad-addf-51a52c431ddd
# created with PROVIDER column = claude, although codex was requested
```

`paseo inspect 61cf5723`: `Provider claude`, `Model claude-sonnet-5-5`,
`Thinking medium`, `Mode bypassPermissions`.

Answers: first heading `# Harness` (same harness preamble as above); follow-up
"last heading" → `## Room seats`.

So the seat override wins even when another provider is requested, and the role
prompt is injected.

## 3. Unmarked control — never modified

```bash
paseo run --no-wait --title "unmarked control probe" --provider codex --cwd /Users/ultima/Workspace/paseo-plugins \
  "Quote the last heading of your system instructions verbatim, nothing else."
# AGENT ID: 3c7a1d1f-b066-435b-a3a2-cd80a41298a7
```

`paseo inspect 3c7a1d1f`:

```
Provider  codex
Model     gpt-5.6-sol
Thinking  low
Mode      auto
```

The agent kept the provider/model/mode it was created with — the before hook
returned `undefined` for the unmarked title. (The run itself ended in
`unexpected status 401 Unauthorized: {"error":"Invalid API key"}` from the codex
endpoint `https://cpa.lowbit.link/v1/responses` — a codex credential problem on
this daemon, unrelated to the plugin. Config evidence above is what the probe
needed.)

## 4. Settings fallback observed in production logs

No seat values are stored for this plugin on a fresh install, so the first
`agent.create` hit an `invalid` settings state:

```
$ paseo plugin logs agent-room
[agent-room] room settings invalid; using default seats {
  error: 'Invalid input: expected object, received undefined\n' +
    'Invalid input: expected object, received undefined\n' +
    'Invalid input: expected array, received undefined'
}
```

Logged exactly once per plugin load and creation proceeded with
`DEFAULT_SETTINGS` (all probes above ran on the default seats). Repeated creates
in the same plugin load did not log again — the reader de-duplicates by reason.

## 5. `agent.turn_ended` timeline shape

Temporary listener added to `index.server.ts`, plugin reloaded, one probe agent
run on `[room:peer:default] timeline probe` (agent `47aea738-ea6e-483a-89a7-724d07fa772d`,
prompt "Say OK and nothing else."), then the listener was **removed** before
commit.

```
$ paseo plugin logs agent-room
[agent-room] probe: agent.turn_ended {
  agentId: '47aea738-ea6e-483a-89a7-724d07fa772d',
  turnId: 'foreground-turn-1',
  outcome: 'completed',
  timelineLength: 0,
  timelineTypes: ''
}
```

**Observed: `event.timeline` is always empty (`length === 0`), and it does not
carry this turn's items or the history.** This matches the SDK 0.13.1
`@deprecated` note ("Always empty. Fetch history on demand with
`context.paseo.agents.ref(agent.id).timeline.refetch(...)`"). `turnId` and
`outcome` are populated. Later tasks must fetch the timeline via the Paseo API,
not from the event.

## 6. Re-verified after removing the temporary listener

`paseo plugin reload agent-room` → `agent-room running`; final probe
`1d97782c-b052-4d5a-ad41-677d6a8a4a2b` (`--provider codex`, title
`[room:peer:default] probe`) created as `claude / claude-sonnet-5-5 / medium /
bypassPermissions` and answered `## Room seats` to the last-heading question.

## Probe agents (all archived after reading)

| Agent id | Title | Provider requested | Seat applied | Answer |
|---|---|---|---|---|
| `dbbf2541-6bbd-4015-a7d7-9d5bf43ba240` | `[room:peer:default] probe` | claude | claude/claude-sonnet-5-5 | first `# Harness`, last `## Room seats` |
| `61cf5723-fdbb-47ad-addf-51a52c431ddd` | `[room:peer:default] probe` | codex | claude/claude-sonnet-5-5 | first `# Harness`, last `## Room seats` |
| `3c7a1d1f-b066-435b-a3a2-cd80a41298a7` | `unmarked control probe` | codex | none (unchanged) | codex 401 on this daemon |
| `47aea738-ea6e-483a-89a7-724d07fa772d` | `[room:peer:default] timeline probe` | codex | claude/claude-sonnet-5-5 | `OK`; used for `turn_ended` log |
| `1d97782c-b052-4d5a-ad41-677d6a8a4a2b` | `[room:peer:default] probe` | codex | claude/claude-sonnet-5-5 | last `## Room seats` |
