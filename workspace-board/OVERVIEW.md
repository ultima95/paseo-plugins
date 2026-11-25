Workspace Board adds one screen that shows every open workspace, from every connected host merged into a single board, grouped by what it needs from you right now, so a finished or blocked workspace stands out instead of hiding in a long sidebar list.

Each workspace appears as a card in one of five columns:

- Needs you: the workspace is waiting for a permission or an answer, or has failed.
- Running: an agent in the workspace is working.
- Review: an agent finished and you have not looked at it yet.
- Idle: nothing is happening and nothing is waiting for you.
- Parked: workspaces you marked to come back to later.

A card shows the workspace title, its project, and how long it has been in its current state. With more than one host, a card also names its host. Pressing a card opens a quick preview beside the board: the conversation with the agent, live, with a reply box, where Enter sends and Shift+Enter starts a new line, and any pending question or permission sitting above that reply box, available to answer without leaving the board. The preview shows what was said, not the reasoning, tool calls, and task lists behind it, so a turn reads as a conversation. Replies stream into it as the agent writes them, messages from the same speaker group under one label, and a working line closes the conversation while the agent is still on its turn. Subagents the agent delegates to fold into one line above the reply box that says how many there are and how many still work; pressing it lists each one and its state — working, done, failed, or stopped — with the working ones first. A workspace with more than one agent gets a chip per agent to switch between them. While the shown agent is still on a turn, the preview says Working beside its name, or Starting before its first reply, so a conversation that merely pauses between messages does not read as finished. The preview's Open button, and the small button on the card, jump to the workspace in its project. The preview's Archive button asks for confirmation before archiving the workspace and closing the preview. A host that is offline is listed in a quiet note, and its workspaces come back when it reconnects. The Park button on a card moves it to Parked. A parked workspace stays out of the way unless it starts needing you, fails, or finishes; then it moves back to the matching column.

On a narrow window the preview covers the board instead of sitting beside it; closing it or pressing the dimmed board returns to the board. Beside the board, the divider between them is a drag handle: drag it to make the conversation wider or narrower, and the board keeps enough room to stay usable.

Child workspaces, the worktrees an agent creates from another workspace, are never shown as cards; the board keeps a quiet count of how many it left out. A sidebar row opens the board and carries one count per attention column, Needs you and Review, each hidden when it is zero.

The sidebar counts cover every host too. The board updates as workspace state changes. Background workspaces and workspaces being archived are not shown.

## Requirements

Paseo 0.15.0 or later on both the daemon and the app.

On an app too old to list its hosts to plugins, the board shows only the host it is opened on. On 0.15 hosts the daemon does not report which workspaces an agent created, so child workspaces cannot be detected, and the workspace handle has no label API, so the Park button is hidden. Everything else works the same.

A host whose daemon cannot serve agent timelines still shows the card and its Park button, and its preview says the chat is unavailable.

## What it reads and writes

The plugin reads workspace state, agent timelines, and subagent session events that Paseo already provides. Its writes are the `Parked` label on a workspace, added or removed when you press Park or Unpark, an archived workspace when you press Archive in the preview, a reply sent to the agent the preview shows, and the answer to a pending permission or question. It has no backend, sends nothing off your machine, and does not send notifications.
