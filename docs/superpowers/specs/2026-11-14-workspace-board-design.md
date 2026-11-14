# Workspace Board plugin: design

Date: 2026-11-14
Location: `workspace-board/` (new folder, sibling of `agent-room/`; `agent-room/` is not touched)

## Intent and why

The user keeps many Paseo workspaces un-archived because they may come back to them. When a
workspace finishes or is blocked on a permission, nothing pulls their eye to it: the sidebar is a
long, project-grouped list of small status dots, and the one that needs them is easy to miss.

The plugin adds one screen, a board, that regroups every un-archived workspace by what it needs
from the user right now.

## Goals

- One screen listing all non-background workspaces across all projects (and all connected hosts)
  as cards, grouped into columns by state:

  | Column    | Contains                                                                 |
  | --------- | ------------------------------------------------------------------------ |
  | Needs you | `indicator` is `needs_input` or `failed`                                 |
  | Running   | `indicator` is `running`                                                 |
  | Review    | `indicator` is `attention` (finished, not yet seen)                      |
  | Idle      | `indicator` is `done`                                                    |
  | Parked    | workspace carries the label `Parked` (user-set "come back later")        |

- A parked workspace stays in Parked unless its indicator becomes `needs_input`, `failed` or
  `attention`; then it moves to the matching column so it cannot hide.
- Card shows workspace title (fallback `name`), project display name, branch, how long it has been in
  its current state (`statusEnteredAt`), and the indicator label. Pressing the card opens the
  workspace. A card action parks or unparks it (label `Parked`, via the workspace ref's `setLabel`).
- Sidebar header item that opens the board, with a trailing count of workspaces in Needs you plus
  Review. The count is hidden at zero.
- Live: updates come from the SDK's `useWorkspaces` subscription, never from polling.
- Works on desktop and compact/mobile: columns scroll horizontally on wide layouts and stack on
  `layout.compact`. All colors come from `theme.colors`.

## Non-goals (v1)

- No daemon-side alerts or push notifications. Paseo's own notifications are untouched. Revisit only
  if the user says missed alerts were the problem, not scan fatigue.
- No answering permissions or prompting agents from the board.
- No server entry (`index.server.ts`), RPC, settings, or persistence beyond the `Parked` label
  stored on the workspace itself.
- No per-row badges in the native sidebar list.
- No drag and drop between columns. Columns are derived from state, except Parked.

## Anti-goals

- A board that only reproduces the sidebar list in another shape without triage value.
- Any silent mutation of workspaces. The only write is the user pressing park/unpark.
- Polling, or one query per card.

## Constraints

- Plugin requires Paseo `>=0.16.0-beta.2` (`useWorkspaces`, refs, `indicator` come from that SDK).
- Client-only plugin: `index.client.tsx`, `client/`, and `shared/` only if something is truly shared.
  Remove the scaffold's `index.server.ts`, `server/` and greeting example.
- React Native primitives only; no DOM. Run the mobile audit grep from the paseo-plugin skill.
- Tests use vitest with `--maxWorkers=2`, one run at a time, no detached runs.
- Plugin ids and screen ids are lowercase with hyphens.

## Approaches considered

1. **Client-only board screen over `useWorkspaces` (chosen).** Smallest surface, no daemon code,
   live by construction, reuses `indicator` Paseo already computes.
2. Board plus a daemon hook (`agent.turn.after`, `agent.permission.before`) that pushes alerts.
   Adds a server runtime and a notification channel before we know alerts are the actual gap.
   Deferred.
3. Replace the sidebar with a plugin sidebar view (`addSidebarView`). Affects the whole sidebar and
   must be selected in Settings; too invasive for a first cut.

The user approved approach 1 ("okay good") and asked for a new folder.

## Structure

```
workspace-board/
  paseo-plugin.json        id workspace-board, paseo >=0.16.0-beta.2
  OVERVIEW.md              plain-language listing text (replace scaffold comment)
  index.client.tsx         registers screen "board" + sidebar header item
  client/board-model.ts    pure: classify(snapshot) -> column, buildBoard(snapshots) -> columns, needsAttentionCount
  client/board-model.test.ts
  client/board-screen.tsx  screen: useWorkspaces, columns, compact layout
  client/workspace-card.tsx
  client/board-item.tsx    sidebar row with count
```

`board-model.ts` has no React or SDK runtime imports (types only) so it is unit-testable.

## Left to the builder

- Exact visual styling, within the theme-color and compact-layout rules.
- Sort order inside a column (suggested: `statusEnteredAt` descending, nulls last).
- Whether `attention` vs `done` match the semantics assumed above: verify against real snapshots on
  this daemon before finalizing the model, and report if they differ.
- Icon choices (Lucide names).
- How to open a workspace from a card (`navigation` capability vs another SDK path); verify in the
  installed SDK types.
