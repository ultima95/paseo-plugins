Workspace Board adds one screen that shows every open workspace, from every connected host merged into a single board, grouped by what it needs from you right now, so a finished or blocked workspace stands out instead of hiding in a long sidebar list.

Each workspace appears as a card in one of five columns:

- Needs you: the workspace is waiting for a permission or an answer, or has failed.
- Running: an agent in the workspace is working.
- Review: an agent finished and you have not looked at it yet.
- Idle: nothing is happening and nothing is waiting for you.
- Parked: workspaces you marked to come back to later.

A card shows the workspace title, its project, and how long it has been in its current state. With more than one host, a card also names its host. Pressing a card opens the workspace on that host. A host that is offline is listed in a quiet note, and its workspaces come back when it reconnects. The Park button on a card moves it to Parked. A parked workspace stays out of the way unless it starts needing you, fails, or finishes; then it moves back to the matching column.

Child workspaces, the worktrees an agent creates from another workspace, are never shown as cards; the board keeps a quiet count of how many it left out. A sidebar row opens the board and carries one count per attention column, Needs you and Review, each hidden when it is zero.

The sidebar counts cover every host too. The board updates as workspace state changes. Background workspaces and workspaces being archived are not shown.

## Requirements

Paseo 0.15.0 or later on both the daemon and the app.

On an app too old to list its hosts to plugins, the board shows only the host it is opened on. On 0.15 hosts the daemon does not report which workspaces an agent created, so child workspaces cannot be detected, and the workspace handle has no label API, so the Park button is hidden. Everything else works the same.

## What it reads and writes

The plugin reads workspace state that Paseo already provides. Its only write is the `Parked` label on a workspace, added or removed when you press Park or Unpark. It has no backend, sends nothing off your machine, and does not send notifications.
