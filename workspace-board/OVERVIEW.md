Workspace Board adds one screen that shows every open workspace grouped by what it needs from you right now, so a finished or blocked workspace stands out instead of hiding in a long sidebar list.

Each workspace appears as a card in one of five columns:

- Needs you: the workspace is waiting for a permission or an answer, or has failed.
- Running: an agent in the workspace is working.
- Review: an agent finished and you have not looked at it yet.
- Idle: nothing is happening and nothing is waiting for you.
- Parked: workspaces you marked to come back to later.

A card shows the workspace title, its project, and how long it has been in its current state. Pressing a card opens the workspace. The Park button on a card moves it to Parked. A parked workspace stays out of the way unless it starts needing you, fails, or finishes; then it moves back to the matching column.

Child workspaces, the worktrees an agent creates from another workspace, are never shown as cards; the board keeps a quiet count of how many it left out. A sidebar row opens the board and shows a count of workspaces in Needs you and Review. The count is hidden when it is zero.

The board updates as workspace state changes. Background workspaces and workspaces being archived are not shown.

## Requirements

Paseo 0.16.0-beta.2 or later on both the daemon and the app.

## What it reads and writes

The plugin reads workspace state that Paseo already provides. Its only write is the `Parked` label on a workspace, added or removed when you press Park or Unpark. It has no backend, sends nothing off your machine, and does not send notifications.
