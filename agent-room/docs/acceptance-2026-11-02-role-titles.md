# Agent Room role titles — acceptance, 2026-11-02

Whole-branch verification for the role-title migration (`docs/superpowers/specs/2026-11-02-agent-room-role-titles-design.md`).
This record covers the full suite, the typecheck, the emitted-grammar grep, and the three
`index.server.test.ts` assertions Task 10 absorbed under ruling R19. It changes no production
code.

**The live daemon probe was not run.** `paseo plugin reload` and `paseo run` mutate the user's
running Paseo, so they are reserved for the user; the probe is recorded as **pending a user run**
in section 4, with the exact commands to run.

## 0. The tree this was verified on

```
$ git log --oneline -1
d38d5e0 fix(agent-room): keep role kinds valid and let briefs be cleared
$ git branch --show-current
worktree-feat+agent-room-role-titles
$ node --version
v24.3.0
```

Task 10's own commit is the one that follows `d38d5e0` on this branch; the three files it touches
are `agent-room/OVERVIEW.md`, `agent-room/index.server.test.ts`, and this record.

## 1. Full suite — 948 of 948 green

```
$ cd agent-room && npm test          # "test": "vitest run"
 Test Files  33 passed (33)
      Tests  948 passed (948)
   Duration  1.98s (transform 4.67s, setup 0ms, import 7.91s, tests 3.94s, environment 2ms)
```

That is the same 948 tests that were there before this task; what changed is that all of them pass.
The branch entered Task 10 with:

```
 Test Files  1 failed | 32 passed (33)
      Tests  3 failed | 945 passed (948)
```

All three failures were in `index.server.test.ts`, inherited from Tasks 3 and 5, and each was an
assertion written against the pre-migration grammar rather than a defect in the role code:

| Test (before → after) | Stale assertion | What the code does now | The fix |
|---|---|---|---|
| `does not read the seat settings for an agent with no marker` → `does not read the role settings for an agent whose title names no role` | `read` is never called for `Fix it`, `[Lead] old room`, `null` | The `agent.create` pre-check is `title.includes(":") \|\| title.trimStart().startsWith("[")`, so a bracket-led non-marker title does reach the settings read (and then passes through untouched, asserted by `passes an unmarked agent through untouched`) | The no-read case is now the three titles the pre-check actually rejects: `Fix it`, `Implementer audit the diff` (a role word with no separator — the grammar's own near-miss), `null` |
| `returns the seat's request for a marked agent` → `returns the role's request for a role title, and for a legacy marker` | `systemPrompt` contains `## Room seats` | `renderRoleTable` heads every role table `## Room roles` | Header updated **and** the test now proves both halves of read-old/write-new: `Implementer: probe` and `[room:peer:default] probe` each get the Implementer seat (`claude` / `claude-sonnet-5-5` / `bypassPermissions` / `medium`), their title is left as it is, and both carry `## Room roles` |
| `warns about an unknown peer tier` → `warns about an unknown legacy peer tier` | `warn("[agent-room]", "unknown peer tier", { tier: "zzz" })` | `index.server.ts` logs `unknown legacy peer tier` with `{ tier, role }` | Asserts the current call exactly: `("[agent-room]", "unknown legacy peer tier", { tier: "zzz", role: "implementer" })`, alongside the fallback model `claude-sonnet-5-5` |

No assertion was deleted or loosened: two of the three tests now assert more than they did (the
role-title + legacy-marker pair, and the fallback's role id), and the third keeps three inputs,
swapping the one title the pre-check never promised to skip for a case that tests the grammar's
rejection of a missing separator.

The role behaviour behind those tests is covered directly by:

- `shared/roles.test.ts` — `parseRoleTitle` (exact, case-insensitive, colon required, unknown
  role, padding, empty rest), `seatTitleForRole` (60-char cap, role name never truncated),
  `roleForLegacyMarker` (every tier map, unknown tier → first worker + `fallbackFrom`), the
  `roles` schema refinement (one supervisor, ≥1 lead, ≥1 worker, unique ids/names).
- `server/inject.test.ts` — 17 `applySeat` cases, including unmarked/unknown-role pass-through,
  legacy-mapped seats, dropped provider-specific controls, `providerOptions` on a provider flip,
  and prompt idempotency.
- `server/guard.test.ts` — every parent-kind × child-kind combination and the unmarked child.
- `server/render.test.ts` — protocol, kind prompt, brief and role table in that order.
- `server/events.test.ts`, `server/handlers.test.ts`, `client/view-model.test.ts`,
  `client/settings-draft.test.ts` — role records, the legacy fallback feed note, launch titles,
  and role names in the tree/feed/status card.

## 2. Typecheck — clean

```
$ cd agent-room && npm run typecheck
> agent-room@0.0.0 typecheck
> tsc --noEmit
```

No output, exit status 0.

## 3. The old grammar in emitted paths

```
$ cd agent-room && rg -n "\[room:" --glob '!**/*.test.ts' --glob '!**/node_modules/**'
shared/seats.ts:4      * The legacy `[room:…]` marker. Room agents are titled with role names now
shared/seats.ts:14     const MARKER_PATTERN = /^\[room:(supervisor|lead|peer(?::([a-z0-9-]+))?)\]\s*/i;
shared/seats.ts:45             return "[room:supervisor]";
shared/seats.ts:47             return "[room:lead]";
shared/seats.ts:49             return `[room:peer:${marker.tier}]`;
shared/room.ts:31      * The legacy `[room:…]` marker as stored: how to start one agent, exactly as
shared/room.ts:68        role). A seat recorded from a legacy `[room:…]` title keeps the marker; new
server/inject.ts:13      /** Set when a legacy `[room:peer:<tier>]` title named a tier the catalog lacks. */
server/inject.ts:29    * Role titles (`Reviewer: audit`) are the grammar; a legacy `[room:…]` marker is
server/events.ts:75    * `[room:…]` marker an in-flight room was created with. `null` for a title that
index.server.ts:133    * `[room:…]` marker); everything else is returned unchanged by returning
OVERVIEW.md:29         Legacy titles are read, never written. A room created before this grammar …
client/room-pill.tsx:157             {" "}`[room:lead]`.
docs/acceptance-2026-10-28.md:29,34,35,36,85          (historical record, phase 1)
docs/acceptance-phase2-2026-10-29.md:137,233,241,242,243,279,288   (historical record, phase 2)
docs/probe-results.md:14,20,35,55,77,137,163,170,171,173,174       (historical record, probes)
```

Sorted by file with counts:

```
$ rg -c "\[room:" --glob '!**/*.test.ts' --glob '!**/node_modules/**' --sort path | sort
client/room-pill.tsx:1
docs/acceptance-2026-10-28.md:5
docs/acceptance-phase2-2026-10-29.md:7
docs/probe-results.md:11
index.server.ts:1
OVERVIEW.md:1
server/events.ts:1
server/inject.ts:2
shared/room.ts:2
shared/seats.ts:5
```

Against the brief's expectation:

- **`shared/seats.ts`** — the legacy reader, as expected. `parseSeatMarker` is the one place the
  bracket grammar is parsed. The file also still defines a writer pair, `formatMarker` and
  `seatTitle`; nothing outside tests calls either, so no path can emit a marker
  (`rg -n "seatTitle\b|formatMarker" --glob '!**/*.test.ts'` matches only their own definitions).
  Dead code to delete with the reader after one release.
- **`OVERVIEW.md`** — the legacy note this task wrote. Expected.
- **`OVERVIEW.md`'s migration fixtures** — the dated records under `agent-room/docs/`
  (`acceptance-2026-10-28.md`, `acceptance-phase2-2026-10-29.md`, `probe-results.md`). They are
  historical; every title in them was created under the old grammar and is left as recorded.
- **`index.server.ts`, `server/inject.ts`, `server/events.ts`, `shared/room.ts`** — prose comments
  only, explaining the legacy branch they guard. No string here reaches a title, a prompt, or a
  feed row.
- **No match** in `server/render.ts`, `server/handlers.ts`, or `server/prompts/*.md` — the emitted
  prompt text and the launch titles are role titles only.

### 3a. One unexpected match, reported not patched

`client/room-pill.tsx:157` is user-facing copy, not a comment:

> This chat is the room Supervisor now. Give it a task here; it will title Leads with `[room:lead]`.

The adopted Supervisor titles Leads `Lead: <workstream>` now, so this sentence tells the user to
expect a title the plugin never writes. It is client UI and therefore production code, which Task
10 is forbidden to change, so it is **reported here and left as a finding** for the follow-up that
sweeps the client copy. The same popover also says "Uses the saved Supervisor, Lead and peer seats"
(`:103`), which is stale vocabulary rather than a grammar match.

## 4. Live daemon probe — PENDING USER RUN

Not run by this task. Reloading the plugin and creating an agent mutate the user's running Paseo,
which is the user's call, not a subagent's. When run, it is:

```bash
cd agent-room
paseo plugin reload agent-room
paseo run --no-wait --title "Reviewer: probe" --provider codex --cwd /Users/ultima/Workspace/paseo-plugins \
  "Quote only the first line of the room roles table in your system instructions."
```

Then `paseo inspect <id>` and check two things:

1. The provider/model is the `Reviewer` role's seat — `claude` / `claude-sonnet-5-5`, not the
   `codex` the caller asked for. The role owns routing, and `--provider codex` is the caller value
   the role is supposed to override.
2. The answer contains `## Room roles`, and the section under it is a worker's two-line bullet
   list — ``- your role: `Reviewer` (`claude/claude-sonnet-5-5`)`` and `- you create no agents` —
   not the table a Lead gets.

A useful second probe for the legacy read, which needs no reload: title an agent
`[room:peer:cheap] probe` and confirm it lands on `claude` / `claude-haiku-4-5` (the `Mechanic`
role) and that the room feed records the mapping note.

## 5. Files changed by this task

| File | Change |
|---|---|
| `agent-room/OVERVIEW.md` | "Titles decide seats" replaced by **Titles decide roles** (grammar, catalog, kind hierarchy, read-old/write-new, unmanaged titles); "The three seats" → **Three kinds of role** with the stock catalog; prompt delivery, guard, screen, setup and known-limits wording brought in line |
| `agent-room/index.server.test.ts` | The three stale assertions in section 1 |
| `agent-room/docs/acceptance-2026-11-02-role-titles.md` | This record |

No production file changed: `git diff --stat` for the task commit touches only those three.
