# Workspace Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Paseo plugin screen that groups every un-archived workspace into Needs you / Running / Review / Idle / Parked columns, plus a sidebar row showing how many workspaces need the user.

**Architecture:** Client-only plugin. A pure model (`client/board-model.ts`) supplies the `where` and `groupBy` functions that the SDK's `useWorkspaces` query applies to workspace snapshots; the screen renders the resulting groups of refs and each card reads its own snapshot with `useWorkspace`. No server entry, no RPC, no polling.

**Tech Stack:** TypeScript, React Native primitives, `@getpaseo/plugin@0.16.0-beta.2` client hooks, vitest for the pure model.

**Spec:** `docs/superpowers/specs/2026-11-14-workspace-board-design.md`

## Global Constraints

- Work only inside `/Users/ultima/Workspace/paseo-plugins/workspace-board/`. Do not read-modify anything in `agent-room/`; it has the user's uncommitted work.
- `paseo-plugin.json` requirement stays `"paseo": ">=0.16.0-beta.2"`; plugin id `workspace-board`.
- Client-only: no `index.server.ts`, no `server/`, no RPC, no settings.
- React Native primitives only (`View`, `Text`, `Pressable`, `ScrollView`); no DOM, no `className`, no `onClick`. Every `Text` color comes from `theme.colors`; padding and stacking use `layout.compact`.
- Screen id `board`; sidebar item id `board`; ids are lowercase with hyphens.
- Parked label is exactly `Parked`.
- Vitest: always `--maxWorkers=2`, `vitest run` (never watch), check `pgrep -f vitest` first, one run at a time, never detach, `pgrep -fl vitest` afterwards and kill leftovers.
- Do not commit. The user commits when they ask.
- Prose in OVERVIEW.md: sentence case, plain facts, no em dashes, no install commands.

## Review Focus

1. A workspace whose `labels` contain `parked` in another case: still Parked (compare case-insensitively). Pinned in Task 1.
2. A parked workspace that goes `needs_input`, `failed` or `attention`: leaves Parked so it cannot hide; a parked `running` or `done` one stays. Pinned in Task 1.
3. Background workspaces and ones being archived (`archivingAt` set): never on the board and never counted. Pinned in Task 1.
4. `statusEnteredAt` null or unparsable: no age text, no crash. Pinned in Task 1.
5. Two hosts with the same workspace id: React keys use `ref.key`, never `id`. Pinned in Task 2 by a code check.
6. Host without `navigation` (undefined): cards render but are not pressable. Pinned in Task 2 by a code check.
7. Park/unpark call rejects: a toast shows the error and the card does not move. Verified in Task 3.

---

## Task 0 (leader): shared interface stub

Leader writes `client/board-model.ts` with the exports below, bodies `throw new Error("not implemented")`, so Task 1 and Task 2 code against fixed names. Deletes `client/greeting.tsx`, `server/greeting.ts`, `shared/greeting.ts`, `index.server.ts` and the empty `server/` and `shared/` dirs from the scaffold.

**Produces (`client/board-model.ts`):**

```ts
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";

export const PARKED_LABEL = "Parked";
export type ColumnId = "needs-you" | "running" | "review" | "idle" | "parked";
export const COLUMNS: readonly { readonly id: ColumnId; readonly title: string }[];
export type BoardWorkspace = Pick<
  PluginWorkspaceSnapshot,
  "indicator" | "labels" | "background" | "archivingAt"
>;
export function isOnBoard(ws: BoardWorkspace): boolean;
export function classify(ws: Pick<BoardWorkspace, "indicator" | "labels">): ColumnId;
export function needsYou(ws: BoardWorkspace): boolean;
export function formatAge(enteredAt: string | null, now: number): string | null;
```

## Task 1: Board model (agent A)

**Files:**
- Modify: `client/board-model.ts` (replace stub bodies)
- Create: `client/board-model.test.ts`
- Modify: `package.json` (add `"test": "vitest run"` script and `"vitest": "^4.1.11"` devDependency; run `npm install` here, the only agent allowed to)

**Interfaces:**
- Consumes: nothing.
- Produces: the Task 0 signatures, implemented. `COLUMNS` is exactly, in order: `needs-you` "Needs you", `running` "Running", `review` "Review", `idle` "Idle", `parked` "Parked". `needsYou(ws)` is true when `isOnBoard(ws)` and `classify(ws)` is `needs-you` or `review`.

- [ ] **Step 1: Write failing tests** in `client/board-model.test.ts` using a fixture helper `ws(overrides): BoardWorkspace` (defaults `indicator: "done"`, `labels: []`, `background: false`, `archivingAt: null`):
  - `classify` maps `needs_input` and `failed` to `"needs-you"`, `running` to `"running"`, `attention` to `"review"`, `done` to `"idle"`.
  - labels `["Parked"]` with `done` and with `running` give `"parked"`.
  - labels `["parked"]` (lowercase) with `done` gives `"parked"`; labels `["Other"]` with `done` gives `"idle"`.
  - labels `["Parked"]` with `needs_input` gives `"needs-you"`, with `failed` gives `"needs-you"`, with `attention` gives `"review"`.
  - `isOnBoard` is false for `background: true` and for `archivingAt: "2026-11-14T00:00:00Z"`, true otherwise.
  - `needsYou` is true for `needs_input`, `failed`, `attention`, including parked ones; false for `running`, `done`, parked `done`; false when `background: true`.
  - `formatAge(null, now)` is `null`; `formatAge("garbage", now)` is `null`; 30 s ago is `"now"`; 5 min is `"5m"`; 59 min is `"59m"`; 2 h is `"2h"`; 48 h is `"2d"`; a timestamp in the future is `"now"`.
  - `COLUMNS.map((c) => c.id)` equals `["needs-you", "running", "review", "idle", "parked"]`.
- [ ] **Step 2: Run to verify failure:** `cd /Users/ultima/Workspace/paseo-plugins/workspace-board && pgrep -f vitest; nice -n 10 npx vitest run client/board-model.test.ts --maxWorkers=2`. Expected: FAIL with "not implemented".
- [ ] **Step 3: Implement** the four functions and `COLUMNS` in `client/board-model.ts`. `classify` checks urgent indicators first, then the Parked label, then running/idle. Age thresholds: under 60 s `"now"`, under 60 min `"{m}m"`, under 24 h `"{h}h"`, otherwise `"{d}d"` (floor each); hence 23 h is `"23h"` and 48 h is `"2d"`.
- [ ] **Step 4: Run to verify pass.** Same command. Expected: all tests PASS, then `pgrep -fl vitest` shows nothing left over. Also run `npm run typecheck` (expected: only errors, if any, from Task 2 files that don't exist yet are acceptable; the model and test must be clean).

## Task 2: Board screen, card, sidebar item (agent B)

**Files:**
- Create: `client/board-screen.tsx`, `client/workspace-card.tsx`, `client/board-item.tsx`
- Modify: `index.client.tsx` (register screen `board` titled "Workspace board"; sidebar header item `board`, title "Workspace board"; return cleanup)

**Interfaces:**
- Consumes: `COLUMNS`, `ColumnId`, `PARKED_LABEL`, `classify`, `isOnBoard`, `needsYou`, `formatAge` from `./board-model` (Task 0 signatures; do not edit that file).
- Produces: `BoardScreen(props: PluginScreenProps)`, `WorkspaceCard(props: { workspace: WorkspaceRef; column: ColumnId; theme: PluginTheme; layout: PluginHostProps["layout"]; navigation?: PluginSurfaceProps["navigation"] })`, `BoardItem(props: PluginSidebarItemProps)`.

- [ ] **Step 1: `BoardScreen`**: call `useWorkspaces({ where: isOnBoard, orderBy: ["statusEnteredAt", "desc"], groupBy: (ws) => classify(ws) })` once. Render one column per entry of `COLUMNS` (always all five, in order), taking that column's `items` from the group whose `key` equals the column id, or empty. Column header shows title and count; an empty column shows "Nothing here" in `foregroundMuted`. Wide layout: columns side by side in a horizontal `ScrollView`; `layout.compact`: stacked vertically in a vertical `ScrollView`. Whole-board empty state when no column has items: "No open workspaces". Needs you header uses `statusDanger` accent, Review `statusWarning`, Running `accent`, Idle and Parked `foregroundMuted`.
- [ ] **Step 2: `WorkspaceCard`**: read one snapshot with `useWorkspace(workspace, selector)` using a selector returning `{ key: workspace.key, title, name, projectDisplayName, branch, statusEnteredAt, indicatorLabel, labels }` (shallow equality); return `null` when the snapshot is `null`. Show title (fallback `name`), project display name, branch if present, `indicatorLabel`, and `formatAge(statusEnteredAt, Date.now())`. Pressing the card calls `navigation?.openWorkspace({ workspaceId: workspace.id, serverId: workspace.hostId })`; when `navigation` is undefined the card renders without `Pressable` behavior. A trailing button parks or unparks: `paseo.workspaces.ref(workspace).setLabel(PARKED_LABEL, { assigned: <true to park, false to unpark> })` where `paseo = usePaseo()`; the label shows "Park" or "Unpark" depending on whether `labels` already holds a case-insensitive `Parked`. On rejection show a toast with the error message (Host UI toast API in the plugin reference); do not update local state optimistically. Buttons have `accessibilityRole="button"` and an `accessibilityLabel` naming the workspace. Use `Pressable` for both, and make the park button's press independent of the card press.
- [ ] **Step 3: `BoardItem`**: `const count = useWorkspaces({ where: needsYou }).length`; render `<SidebarRow icon="LayoutDashboard" active={currentScreen?.screenId === "board"} onPress={() => openScreen({ screenId: "board" })} trailing={count > 0 ? <Text style={{ color: theme.colors.statusDanger }}>{count}</Text> : undefined} />`.
- [ ] **Step 4: Keys and hygiene:** React keys use `ref.key`, never `id`. Run the mobile audit, expected no hits: `cd /Users/ultima/Workspace/paseo-plugins/workspace-board && rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/`.
- [ ] **Step 5: Typecheck:** `npm run typecheck`. Expected: exit 0. If `client/board-model.ts` still throws "not implemented", that is Task 1's job; typecheck is unaffected.

## Task 3 (leader): listing, install, verify

**Files:**
- Modify: `OVERVIEW.md` (replace scaffold comment with plain-language text: what the board is, the five columns, the Parked label, that it needs Paseo 0.16.0-beta.2 or later, that it only reads workspace state and writes only the `Parked` label), `paseo-plugin.json` (add `"description"`; leave `requirements`).

- [ ] **Step 1:** `npm run typecheck` and `nice -n 10 npx vitest run --maxWorkers=2`. Expected: clean, all tests pass.
- [ ] **Step 2:** `paseo plugin install /Users/ultima/Workspace/paseo-plugins/workspace-board`, then `paseo plugin ls`. Expected: `workspace-board` is `running`, no error. Never restart the daemon.
- [ ] **Step 3:** Hand the user a check list for the live app: open the board from the sidebar, confirm the five columns and card counts match the sidebar dots, park and unpark one workspace, compact-width view, and dark theme legibility. Check the real indicator values against the assumption in the spec (`attention` = finished not yet seen, `done` = seen) and report any mismatch.
- [ ] **Step 4:** Independent review by a fresh `code-validator` agent on the `workspace-board/` folder only; fix proven defects.

## Execution

Task 0 by the leader, then agents A (Task 1) and B (Task 2) in parallel, then Task 3 by the leader.
