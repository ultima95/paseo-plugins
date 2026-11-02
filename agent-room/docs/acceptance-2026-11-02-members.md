# Agent Room members — acceptance, 2026-11-02

Whole-branch verification for the members phase (`docs/superpowers/specs/2026-11-02-agent-room-phase4-members-design.md`).
This record covers the full suite, the typecheck, the prompt generator's no-diff check, the six spec
acceptance items mapped to the tests that pin them, and the v1 migration demonstration.

The branch changes one prompt line as well as documentation — the Task 9 review follow-up in
`server/prompts/lead.md`, whose worker `initialPrompt` template now names the member section — and
`server/prompts/generated.ts` is regenerated from it. No other production behaviour changes in this
task.

**The live daemon probe was not run.** `paseo plugin reload` and the room launches behind the probe
mutate the user's running Paseo, so they are reserved for the user; the probe is recorded as
**pending a user run** in section 6, with the exact commands and checks.

## 0. The tree this was verified on

```
$ git log --oneline -1
f563563 fix(agent-room): keep member selection and launch bindings fresh
$ git branch --show-current
worktree-feat-agent-room-phase4-members
$ node --version
v24.3.0
```

This record's own commit is the one that follows `f563563` on this branch. Through `f563563` the
branch is 22 commits and 43 files under `agent-room/` (`5734 insertions(+), 99 deletions(-)`),
including 9 new test files and additions to 8 existing ones.

## 1. Full suite — 1100 of 1100 green

```
$ cd agent-room && npm test          # "test": "vitest run"
 Test Files  42 passed (42)
      Tests  1100 passed (1100)
   Duration  906ms (transform 1.63s, setup 0ms, import 3.35s, tests 1.69s, environment 2ms)
```

The role-title phase closed at 948 tests; this phase adds 152 across 9 new files —
`server/member-store.test.ts`, `server/member-handlers.test.ts`, `server/member-index.test.ts`,
`server/migrate-members.test.ts`, `server/promotion.test.ts`, `server/episode.test.ts`,
`server/scope.test.ts`, `shared/member.test.ts`, `shared/room.test.ts` — plus additions to 8 existing
ones: `index.server.test.ts`, `server/store.test.ts`, `server/events.test.ts`, `server/handlers.test.ts`,
`server/inject.test.ts`, `server/render.test.ts`, `server/prompts/prompts.test.ts` and
`client/view-model.test.ts`.

That block quotes the 906 ms run. The same four commands were run three times across the edits, and
every run reported the same counts — `42 passed (42)`, `1100 passed (1100)` — while the durations came
in at 906 ms, 787 ms and 725 ms; the run on the committed tree itself was the 725 ms one. Durations
vary run to run; the counts do not, and sections 2–3 below are from the same sequence.

## 2. Typecheck — clean

```
$ cd agent-room && npm run typecheck
> agent-room@0.0.0 typecheck
> tsc --noEmit
```

No output, exit status 0.

## 3. The generator leaves `generated.ts` unchanged

```
$ cd agent-room && npm run gen:prompts
> agent-room@0.0.0 gen:prompts
> node server/prompts/gen.mts

gen:prompts wrote generated.ts (75802 bytes) from 4 sources
$ git diff --exit-code server/prompts/generated.ts
$ echo $?
0
```

`generated.ts` is never hand-edited: the four markdown files are embedded verbatim by
`server/prompts/gen.mts`, and this check proves the committed copy is byte-identical to what its
sources regenerate. The one prompt edit in this task is in `server/prompts/lead.md`: the worker
`initialPrompt` template now reads

```
Room role: worker. Your system prompt carries the room protocol, the worker
role, your role's brief, your member section when the member has one, and your
role table; follow them for this whole session.
```

matching the protocol's own prompt-composition paragraph, which already names "your member section when
the member has one" in that position. The edit aligns the worker template with the paragraph it
restates, rather than leaving the template a sentence behind it.

## 4. Spec acceptance mapping

Every item below is quoted from spec §15, followed by the tests that pin it.

| # | Spec acceptance item | Tests |
|---|---|---|
| 1 | Two rooms launched from the same member with different tasks create Supervisors with identical seat config and different prompts | `server/handlers.test.ts` › "launch with members" › `launches the Supervisor on the selected member's seat and renders its memory`, `shows the bound Lead member's seat in the Supervisor's role table`; `server/member-index.test.ts` › `looks members up by id and by seat`; `index.server.test.ts` › `keeps a member-seated Supervisor's seat truthful when agent.created lands first`, `renders the matching member's section on a create that names its seat` |
| 2 | A room's Supervisor prompt contains the charter and only matching-scope lessons; no lesson from another repo appears | `server/render.test.ts` › `renders name, charter and dated lessons`, `puts the member section after the role brief and before the role table`, `keeps the newest 12 lessons and flags the drop`, `truncates an oversized charter deterministically`; `server/handlers.test.ts` › `scopes the Supervisor's memory to the room's repository and workspace`, `reads the member scope from the workspace directory when only a workspace is given`, `notes a truncated member section in the room feed`; `server/inject.test.ts` › "applySeat with members" (4 tests); `server/scope.test.ts` › "repo identity", `lists global, then the repo, then the exact workspace`, `drops the repo scope when the directory is in no repository` |
| 3 | After a room ends with `promotion: "human"`, its decisions appear in `pending.jsonl` and not in `lessons.jsonl`; accepting one appends it and the next room's prompt contains it | `server/promotion.test.ts` › `queues a human-policy candidate without promoting it`, `skips a candidate already promoted or already pending`, `skips a candidate whose pending line is a reject tombstone`; `server/events.test.ts` › `leaves human-policy candidates pending at archive`, `records the room's task as the final outcome fact`, `redacts a credential in the room's outcome fact`; `server/member-store.test.ts` › `accepts and rejects pending candidates`, `persists records, charter, lessons and pending across instances`; `server/member-handlers.test.ts` › `accepts and rejects pending candidates`, `fails an accept for an unknown candidate` |
| 4 | With `promotion: "auto"` and default `autoScopes`, a repo-scoped candidate is promoted and a global-scoped one is not | `server/promotion.test.ts` › `promotes auto candidates in an allowed scope`, `keeps a global candidate pending under the default autoScopes`, `keeps the candidate timestamp on a queued line but stamps a promoted one`; `server/events.test.ts` › `writes the final outcome and promotes repo candidates at archive`, `stamps a promoted lesson with the injected clock` |
| 5 | A v1 `rooms.json` loads, gains null member ids, seeds two members, and serves a room without data loss; a second load is a no-op | `server/store.test.ts` › `migrates a v1 file to v2 and reports it once`, `binds members whether the room is recorded before or after the binding`, `keeps member ids across a reload`; `shared/room.test.ts` › `accepts v1 and normalizes member ids to null`; `server/migrate-members.test.ts` › `seeds a supervisor and a lead from the catalog`, `is a no-op when v2 rooms are already on disk`, `leaves an existing members file alone`, `does not seed from a catalog without a lead role`; `index.server.test.ts` › `seeds members when a v1 rooms file is migrated on load`, `loads without seeding members for a room store that is already v2` |
| 6 | `npm test` and `npm run typecheck` pass in `agent-room`, and the guard tests are unchanged | Sections 1–2 above, and the guard check below |

### 4a. Guard tests unchanged

```
$ git diff --stat main...HEAD -- agent-room/server/guard.test.ts agent-room/server/guard.ts
$ git diff --name-status main...HEAD -- "*.test.ts"
M	agent-room/client/view-model.test.ts
M	agent-room/index.server.test.ts
A	agent-room/server/episode.test.ts
M	agent-room/server/events.test.ts
M	agent-room/server/handlers.test.ts
M	agent-room/server/inject.test.ts
A	agent-room/server/member-handlers.test.ts
A	agent-room/server/member-index.test.ts
A	agent-room/server/member-store.test.ts
A	agent-room/server/migrate-members.test.ts
A	agent-room/server/promotion.test.ts
M	agent-room/server/prompts/prompts.test.ts
M	agent-room/server/render.test.ts
A	agent-room/server/scope.test.ts
M	agent-room/server/store.test.ts
A	agent-room/shared/member.test.ts
A	agent-room/shared/room.test.ts
```

The first command prints nothing, and `server/guard.test.ts` appears nowhere in the changed-test list:
the hierarchy rules were not relaxed to let members exist, and the member seats ride the existing role
grammar. `server/guard.ts` is untouched too.

### 4b. Three gaps, reported rather than papered over

Three halves of items 1, 2 and 3 are argued from composition rather than pinned by a single test. All
three are recorded here as they stand, not rounded up.

- **Item 1** — no test launches a *second* room on the same member and compares the two seat configs.
  What is pinned is the mechanism: the launch reads the member record and forces its seat
  (`handlers.test.ts`), the pre-create hook resolves a member by seat when it has no room
  (`member-index.test.ts`, `index.server.test.ts`), and the binding carries the seat so a late
  `agent.created` cannot make it a lie. Since a launch reads the member record and writes nothing to
  it, two launches can only produce the same seat, but that equality is not asserted directly.
- **Item 2** — the prompt tests assert the *exact* scope list a launch asks the store for
  (`["global", "repo:abcd1234", "workspace:/repo"]`) and that a lesson in one of those scopes renders,
  but `MemberStore.lessonsFor`'s own filter — the line that keeps a lesson from another repo out — is
  not exercised with a non-matching lesson. `handlers.test.ts` and `events.test.ts` both stub
  `lessonsFor`, so the exclusion is proven by code reading, not by a test. A one-line store test
  (two lessons, one scope each, expect one back) would close it.
- **Item 3** — the final clause, "accepting one appends it and the next room's prompt contains it", is
  composed from two tests and not chained by either. `member-store.test.ts` › `accepts and rejects
  pending candidates` pins the first half — an accept appends the lesson — and `render.test.ts` plus
  the `handlers.test.ts` member tests pin that a lesson in a loaded scope renders into the prompt. No
  test renders a prompt from a store that accepted a candidate: `acceptPending` appears only in
  `member-store.test.ts` and `member-handlers.test.ts` (plus a never-called stub in `events.test.ts`),
  and neither file renders a prompt. **Item 3's prompt-rendering clause is therefore not directly
  covered** — nothing asserts that the *next* room's prompt contains the lesson an accept just wrote,
  only that the accept stores it and that a stored lesson in scope renders. A test that accepts a
  candidate on a real store and then renders the next room's prompt from that store would close it.

None of the three is a behaviour defect as far as code reading shows; they are the places where this
record's evidence stops short of the spec's sentence, stated plainly so a later task can close them.

## 5. Migration demonstration

The seed test, run alone, and a real `members.json` it produces. The sample comes from a throwaway
`mkdtemp` sandbox that loaded the real `createMemberStore`, ran the real `migrateMembers` against a
store reporting `migratedFromV1()`, and printed the file the store wrote; the throwaway test file was
deleted after the run, so the suite counts in section 1 are unaffected. This sample is illustrative; it
was produced by a one-off run and is not reproducible from the suite.

```
$ cd agent-room && npx vitest run index.server.test.ts \
    -t "seeds members when a v1 rooms file is migrated on load" --reporter=verbose
 ✓ index.server.test.ts > agent-room server contribution > seeds members when a v1 rooms file is migrated on load 7ms
```

```json
{
  "version": 1,
  "members": [
    {
      "provider": "claude",
      "model": "claude-opus-5-5",
      "modeId": "bypassPermissions",
      "thinkingOptionId": "xhigh",
      "id": "default-supervisor",
      "name": "Supervisor",
      "role": "supervisor",
      "memory": {
        "promotion": "human",
        "autoScopes": [
          "repo",
          "workspace"
        ]
      },
      "createdAt": "2026-11-02T10:00:00.000Z",
      "updatedAt": "2026-11-02T10:00:00.000Z"
    },
    {
      "provider": "claude",
      "model": "claude-opus-5-5",
      "modeId": "bypassPermissions",
      "thinkingOptionId": "high",
      "id": "default-lead",
      "name": "Lead",
      "role": "lead",
      "memory": {
        "promotion": "human",
        "autoScopes": [
          "repo",
          "workspace"
        ]
      },
      "createdAt": "2026-11-02T10:00:00.000Z",
      "updatedAt": "2026-11-02T10:00:00.000Z"
    }
  ]
}
```

The two members carry the stock catalog's seats — `xhigh` for the Supervisor, `high` for the Lead —
and the shipped memory policy: `human`, so nothing is promoted without review, with `repo` and
`workspace` pre-listed for when a member is switched to `auto`.

What the tests pin around it:

- The v1 document is rewritten as version 2 with `supervisorMemberId: null` / `leadMemberId: null`,
  and the room is still served (`store.test.ts` › `migrates a v1 file to v2 and reports it once`).
- The seed runs only when the rooms file migrated from v1 *and* `members.json` was absent: an
  existing file and a corrupt one are both left alone (`migrate-members.test.ts` › `leaves an
  existing members file alone`, `index.server.test.ts` › `loads without seeding members for a room
  store that is already v2`), so a second load is a no-op.
- A catalog with no lead role seeds nothing and says so (`migrate-members.test.ts` › `does not seed
  from a catalog without a lead role`).

## 6. Live daemon probe — PENDING USER RUN

Not run by this task. Reloading the plugin and launching rooms mutate the user's running Paseo, which
is the user's call. When run, it is:

```bash
cd agent-room
paseo plugin reload agent-room
```

Then, in the Paseo UI:

1. Open **Members** and confirm `default-supervisor` and `default-lead` exist with the catalog seats
   (`claude/claude-opus-5-5` at `xhigh` and at `high`, `bypassPermissions`, promotion `human`).
2. Launch a room with both members selected; open the Supervisor and confirm its system prompt
   contains `## Member` and its provider/model matches the member.
3. Archive the Supervisor; inspect:

```bash
ls ~/.paseo/plugin-data/agent-room/members
cat ~/.paseo/plugin-data/agent-room/members/default-lead/episodes/<roomId>.jsonl
cat ~/.paseo/plugin-data/agent-room/members/default-lead/pending.jsonl
cat ~/.paseo/plugin-data/agent-room/members/default-lead/lessons.jsonl
```

4. Confirm `pending.jsonl` has the room's decisions (one line per `DECISION_NEEDED` / `REJECT`
   signal) and `lessons.jsonl` is empty under `promotion: "human"`.

## 7. Files changed by this task

| File | Change |
|---|---|
| `agent-room/OVERVIEW.md` | New **Members**, **Memory scopes**, **Promotion** and **Episodes** sections; the prompt-delivery paragraph now names the member section in order and its budgets; the setup paragraph now describes `rooms.json` (version 2) plus `members.json` (version 1) and the `members/<memberId>/` layout; seven member limits added to **Known limits**, and the forward-only note tied to version 2 |
| `agent-room/server/prompts/lead.md` | The worker `initialPrompt` template names the member section (Task 9 review follow-up) |
| `agent-room/server/prompts/generated.ts` | Regenerated by `npm run gen:prompts`; not hand-edited |
| `agent-room/docs/acceptance-2026-11-02-members.md` | This record |

`agent-room/client/room-pill.tsx` needed no change: the two stale strings the plan named
("titles Leads with `[room:lead]`" and "saved Supervisor, Lead and peer seats") were already corrected
to `Lead: <workstream>` and "saved role seats" by an earlier commit on this branch, so the file is
untouched here.
