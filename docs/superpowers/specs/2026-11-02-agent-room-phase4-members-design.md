# Phase 4 — Persistent members and scoped memory

Status: **design, not implemented.** Applies to the `agent-room` plugin on
`@getpaseo/plugin` 0.13.1. Nothing in this document changes the Agent Room
topology of Supervisor → Lead → Worker. The title grammar is owned separately by
`2026-11-02-agent-room-role-titles-design.md`, which replaces `[room:…]` markers with role names;
that change is a prerequisite for the role references below, not part of memory.

Decisions this design is built on:

1. **Memory scope: split.** A lesson is `global`, `repo:<id>`, or `workspace:<path>`.
   The prompt loads `global` plus the scopes that match the room.
2. **Promotion: configurable per member.** `promotion: "human" | "auto"`, with
   `autoScopes` narrowing what `auto` may promote without review.
3. **Worker members: deferred.** v1 ships supervisor and lead members only.
   Worker roles resolve through the role catalog (`2026-11-02-agent-room-role-titles-design.md`).

## 1. Why members exist

A room is disposable and ends when its Supervisor is archived (`events.ts`,
`handleArchived`). Every room therefore starts from the same host settings and
remembers nothing. The seat table is global; the room id is the Supervisor agent
id; nothing in `rooms.json` survives the org.

A member is the durable half:

| Object | Lifetime | Owns |
| --- | --- | --- |
| Member | Forever | Name, role, seat defaults, memory policy, memory |
| Room | One task | Seats, feed, task scope, bound member ids |
| Seat | One agent | The provider/model/mode forced at create |
| Agent | One session | Its transcript |

The success test for this phase: **after three rooms on the same member, does
the fourth room start better than a fresh one?** If it does not, the phase
failed, regardless of how much memory is stored.

## 2. Non-goals

- No worker-role members. Workers are task-scoped and their value is bounded work.
- No LLM summarizer agent. Memory capture is deterministic.
- No cross-member or team memory. Memory is per member.
- No memory editing by agents mid-room. Room memory is read-only while running.
- No change to spawn rights. Members do not affect the guard; role kinds do
  (`2026-11-02-agent-room-role-titles-design.md`).
- No routines or event triggers. Those are a later phase.

## 3. Member record

New module `shared/member.ts`:

```ts
export const memoryScopeTypeSchema = z.enum(["global", "repo", "workspace"]);

export const memoryPolicySchema = z.object({
  // human: promotion candidates land in pending.jsonl and wait for a person.
  // auto: candidates whose scope type is listed in autoScopes are promoted.
  promotion: z.enum(["human", "auto"]),
  // Narrower than `promotion` on purpose: global lessons default to review.
  autoScopes: z.array(memoryScopeTypeSchema).default(["repo", "workspace"]),
});

export const memberRecordSchema = z.object({
  id: nonEmptyText,
  name: z.string().min(1).max(60),
  role: z.enum(["supervisor", "lead"]),
  // Same shape as a seat: bare provider and model ids, no account prefixes.
  provider: nonEmptyText,
  model: nonEmptyText,
  modeId: nonEmptyText.optional(),
  thinkingOptionId: nonEmptyText.optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  memory: memoryPolicySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type MemberRecord = z.infer<typeof memberRecordSchema>;
```

Deliberate omissions:

- No `systemPrompt` field. A member's standing instructions live in `charter.md`,
  so the prompt is editable without rewriting JSON.
- No `role` per room. The role is a property of the member, and the member is
  bound to a role by the room, not by a title token.

### Room binding

`shared/room.ts` gains two nullable fields on `RoomRecord`:

```ts
supervisorMemberId: z.string().nullable(),
leadMemberId: z.string().nullable(),
```

`leadMemberId` is room-scoped because the protocol gives the Supervisor no way
to name a member per Lead without changing the title grammar. Every Lead in one
room shares the room's Lead member. That is a documented v1 limitation; lifting
it later means binding a member to each Lead role in the seat table (the role name
is the routing token) or adding a member token to the title. Neither is in scope
here.

Worker roles are untouched by members: the role catalog remains their only source.

## 4. Memory model

Three tiers, separated by cost and mutation rate.

| Tier | Contents | Written by | Loaded |
| --- | --- | --- | --- |
| Charter | Stable conventions, standing instructions, hard constraints | Human (preferred) or promotion | `systemPrompt` at create |
| Lessons | Short, dated, scoped, falsifiable statements | Promotion from episodes | `systemPrompt` at create, matching scopes only |
| Episodes | What happened in one room: task, decisions, rejections, outcome | Plugin, deterministic, from the feed | On demand; not in the prompt |

Why the split: charter and lessons are paid for on every turn, so they must stay
small and stable. Episodes are append-only and unbounded; putting them in a system
prompt is how memory turns into cost and stale claims.

### Lesson shape

One JSON object per line in `lessons.jsonl`:

```ts
{
  at: "2026-11-02T10:00:00.000Z",
  scope: "repo:8f3c1a2b" | "workspace:/Users/me/Workspace/app" | "global",
  text: "Tests run with `pnpm test`, not `npm test`; the lockfile is pnpm-only.",
  sourceRoomId: "<supervisor agent id>",
  promotedBy: "human" | "auto"
}
```

Rules:

- Append-only. A correction is a new lesson; nothing is rewritten.
- Dated, so "newer wins" is decidable when a lesson goes stale.
- Deduplicated by a stable hash of `scope + normalized text` at promotion time.
- Hard cap per lesson: 240 characters. A lesson that needs more is a charter edit.
- A lesson is a hint, not authority. The room protocol gains one line: *member
  memory may be stale; verify against the repository before relying on it.*

### Episode shape

One file per room: `members/<id>/episodes/<roomId>.jsonl`. Written from typed
facts, never from arbitrary tool output:

```ts
{
  at: "...",
  kind: "task" | "decision" | "rejected" | "outcome" | "blocked",
  signal: "DONE" | "DECISION_NEEDED" | "REJECT" | "BLOCKED" | undefined,
  text: "..."
}
```

Source of facts is the feed the plugin already derives in `server/feed.ts`. The
signals `DECISION_NEEDED`, `REJECT`, `BLOCKED`, `DONE`, and `ACCEPT` are parsed
today by `labelFor`; episode extraction reads those rows plus the room record. No
model call, no transcript scrape.

### Episodes are not the prompt

An episode file is for a human or a future tool to read. v1 does not retrieve it
into a prompt. A later pass may surface a short "last room on this member"
timeline row, reusing the `room-context` mechanism.

## 5. Scopes

Scope is derived at promotion time from the room, not supplied by an agent.

```ts
type Scope =
  | { type: "global" }
  | { type: "repo"; id: string }
  | { type: "workspace"; path: string };
```

- `repo:<id>`: stable hash (first 8 hex of sha256) of the normalized git remote
  URL from `git -C <cwd> remote get-url origin`. When there is no remote, hash the
  repository root path instead. Both are repository identity, not workspace
  identity, so a clone in a second directory still matches.
- `workspace:<path>`: normalized absolute `cwd`, trailing slash removed. Exact
  match only. Prefix matching would leak one nested project's lessons into
  another.
- `global`: matches every room.

Loading a member for a room selects: all `global` lessons, plus `repo:<derived>`,
plus `workspace:<room.cwd>`, newest first, capped.

Why split: environment facts ("this repo's tests need a database container") belong
to the repo. Judgment ("prefer small diffs over rewrites") belongs to the
identity. Mixing them means the reviewer member carries one repo's quirks into
another.

## 6. Storage layout

```
$PASEO_HOME/plugin-data/agent-room/
  rooms.json                      # version 2
  members.json                   # version 1, MemberRecord[]
  members/<memberId>/charter.md
  members/<memberId>/lessons.jsonl
  members/<memberId>/pending.jsonl
  members/<memberId>/episodes/<roomId>.jsonl
```

`members.json` holds records only. Memory lives in files because:

- lessons and episodes are append-only line logs, not whole-document rewrites;
- a corrupt memory file degrades one member instead of the whole store;
- the existing `rooms.json` writer (`server/store.ts`) rewrites the full document
  on every mutation, which must not grow with memory.

Write mechanics:

- One in-process write queue per member, same promise-chain pattern as
  `createRoomStore.scheduleWrite`.
- Lessons and episodes use `appendFile`; charter uses atomic temp+rename.
- Files are created `0600`. The directory is `0700`.
- A failed append logs and leaves the queue alive, matching the store's rule that
  a failed write must not poison later writes.

### Concurrency

Two rooms on the same member may run at once. Append-only files make that safe:
each room writes its own `<roomId>.jsonl`; lessons are only appended at promotion,
which is serialized through the member queue. There is no merge and no
last-write-wins on an existing lesson.

If the daemon is restarted mid-room, episodes already appended survive. Promotion
does not run, so nothing half-reviewed reaches the prompt.

## 7. Prompt assembly

`server/render.ts` gains a member section. Current order is kept and extended:

1. caller's existing system prompt (unchanged)
2. room protocol (`PROMPTS.protocol`)
3. that seat's role prompt
4. **`## Member` — name, charter, selected lessons** (new)
5. seat table

Putting the member after the role keeps the role authoritative: a charter cannot
turn a Lead into a Supervisor.

Budgets, enforced deterministically:

| Part | Cap |
| --- | --- |
| Charter | first 4,096 characters, truncated with a marker line |
| Lessons | newest 12 matching scopes, 240 chars each |
| Whole member section | 6,144 characters |

Truncation is by count and order, never by model judgment, so the same member and
room always render the same prompt. A truncation is logged once per create and
recorded as a `note` feed row (`member section truncated`).

Idempotency: `carriesRoomPrompt` in `server/inject.ts` keeps working because the
protocol string is still the sentinel. A launched Supervisor that already carries
the prompt keeps it; `applySeat` must not append a second member section.

## 8. Seat resolution seam

Today `applySeat(request, settings)` is pure and reads only host settings. Members
add one input, still pure:

```ts
applySeat(request: AgentCreateRequest, settings: RoomSettings, members: MemberIndex): SeatApplication | null
```

Where `MemberIndex` is a lookup built once per hook call from the member store.

Resolution for a Supervisor or Lead role (the title names the role):

1. If the room is bound to a member of that role, the member's
   provider/model/mode/thinking/features are the seat.
2. Else fall back to the supervisor / lead role's seat from the role catalog.
3. Unset member controls are dropped from the request, exactly as the current
   seat rule drops them. No caller value is inherited.
4. `providerOptions`, `mcpServers`, `toolPolicy`, and env keep their current rules.

For a worker role: no member lookup, unchanged path through the role catalog.

The Supervisor's launch path needs the same values. `server/handlers.ts` `launch`
builds the config from the selected member rather than the Supervisor role's seat, and
writes `supervisorMemberId` on the room when `agent.created` records it.

Hook plumbing: `applySeat` is called from the `agent.create` before-request hook.
The index loader is async; the hook already awaits settings in the same path, so it
awaits the member index too. No new background work per turn.

### Binding a member to a room

`launchRoomRpc` (`shared/rpc.ts`) gains `supervisorMemberId` and `leadMemberId`,
both optional. Omitted means "use the host seat", so existing callers keep working.
The launch form selects a Supervisor member and a Lead member; the Room screen
shows both and links to the member editor.

## 9. Episode capture and promotion

### Capture

On `agent.turn_ended` for a seat whose room has a bound member, the plugin may
append episode facts. To keep the write small and deterministic, only rows whose
signal is `DECISION_NEEDED`, `REJECT`, `BLOCKED`, `ACCEPT`, or `DONE` are
recorded, and only from the Supervisor and Lead. Worker turns contribute nothing
directly; their signals reach the Lead and surface there.

On `agent.archived` for the room's Supervisor:

1. write a final `outcome` fact (room task, ended, guard rows present or not);
2. build promotion candidates from the episode: distinct `decision` and
   `rejected` facts, deduplicated against existing lessons by scope + text hash;
3. route each candidate by policy (below);
4. mark the episode complete in `members/<id>/episodes/<roomId>.jsonl` with a
   trailing `{ kind: "outcome", ... }` line.

Nothing is captured from a room with no bound member.

### Promotion policy

```ts
promotion: "human" | "auto"
autoScopes: Array<"global" | "repo" | "workspace">
```

Matching uses the scope **type**, not the full scope value:

| Config | Candidate scope | Result |
| --- | --- | --- |
| `human` | any | appended to `pending.jsonl` |
| `auto`, autoScopes `[repo, workspace]` | repo | appended to `lessons.jsonl`, `promotedBy: "auto"` |
| `auto`, autoScopes `[repo, workspace]` | workspace | appended to `lessons.jsonl` |
| `auto`, autoScopes `[repo, workspace]` | global | appended to `pending.jsonl` |
| `auto`, autoScopes `[global, repo, workspace]` | global | appended to `lessons.jsonl` |

The default `autoScopes` excludes `global` even when `promotion` is `auto`. A
global lesson outlives every repo and deserves review by default; a member that
wants otherwise can say so.

The UI's memory view lists `pending.jsonl` with accept/reject. Accept appends to
`lessons.jsonl` with `promotedBy: "human"`; reject appends a tombstone line to
`pending.jsonl` (`{ at, scope, text, rejected: true }`) so the same candidate is
not proposed again.

### What is never captured

- Tool output, file contents, command output, or web content.
- Anything from a worker's turn.
- Secrets. Memory files are plaintext under the Paseo home; a redaction pass
  removes obvious token shapes (`sk-`, `ghp_`, `AKIA`, `-----BEGIN`) before a
  line is written, and logs a redaction count.

## 10. Migration

`ROOMS_FILE_VERSION` moves to `2`. `server/store.ts` currently treats any version
other than `1` as corrupt and resets. That must change to a migration, not a wipe.

Migration is in-memory on load, then written back:

1. Parse `rooms.json` as either v1 or v2 (`z.discriminatedUnion` on `version`).
2. If v1: add `supervisorMemberId: null`, `leadMemberId: null` to every room.
3. If `members.json` is absent and v1 rooms were found, seed:
   - `default-supervisor` from the supervisor role's seat, role kind `supervisor`,
     name `Supervisor`, `promotion: "human"`, `autoScopes: ["repo", "workspace"]`.
   - `default-lead` from the lead role's seat, role kind `lead`, same policy.
   - Do **not** create worker members. Worker roles stay in the role catalog.
4. Write `rooms.json` v2 and `members.json` v1 through the existing atomic write.
5. Log once: `members migrated { members: 2, rooms: N }`.

A corrupt `members.json` is a member store empty plus one warn; it must not reset
rooms. The reverse also holds. The two stores fail independently.

Rollback: leaving `members.json` in place is harmless to an older build, but
`rooms.json` v2 is not readable by the current build. The version bump is
forward-only; a downgrade needs the v1 shape restored from the v2 fields.

## 11. Client surface

Minimal v1:

- **Room screen**: two selectors in the launch form (Supervisor member, Lead
  member), defaulting to the host seats. A member chip on the room list row.
- **Member screen**: list, rename, seat defaults editor, `promotion` and
  `autoScopes` toggles, charter editor, lessons list (scope, date, source room),
  pending queue with accept/reject, episode list read-only.
- **Seat tree / status card**: show the member name beside the Supervisor and Lead
  rows. No new status states.

Out of scope for v1: editing memory files by hand outside the plugin, member
duplication, import/export.

## 12. Failure modes

| Failure | Behavior |
| --- | --- |
| `members.json` corrupt | member store empty + warn; rooms unaffected; rooms bound to missing members fall back to host seats with a `note` feed row |
| `lessons.jsonl` corrupt line | skip the line + warn; the rest load |
| charter over cap | truncate deterministically + one log line + one feed note |
| room ends by crash | episodes already written survive; no promotion |
| two rooms, one member | append-only per-room episodes; lessons appended at promotion only |
| member deleted while a room runs | seat keeps its resolved config; room reports `member missing`; no write-back |
| promotion candidate duplicated | deduplicated by scope + text hash |
| secret shape in a candidate | redacted before write, count logged |
| guard violation in the room | room's decisions may still promote; no process lessons are generated from guard rows |

## 13. Tests

Unit:

- `shared/member.test.ts` — schema, role enum, policy defaults, `autoScopes`
  validation.
- `shared/room.test.ts` — v1 and v2 parse; v1 rows normalize with null member ids.
- `server/member-store.test.ts` — atomic charter write, append queue ordering,
  corrupt-line tolerance, 0600 creation, independent failure from the room store.
- `server/scope.test.ts` — remote hash stable across clones, root-path fallback,
  workspace normalization, exact-match rule.
- `server/promotion.test.ts` — the five-row policy table above, dedupe, tombstone,
  redaction.
- `server/episode.test.ts` — only the five signals and only Supervisor/Lead rows;
  Worker rows contribute nothing.
- `server/render.test.ts` — member section order after role, budgets, truncation
  stability, no second section on an already-prompted create.
- `server/inject.test.ts` — member wins over host settings, worker path unchanged,
  missing member falls back, unset control dropped.
- `server/migrate-members.test.ts` — v1→v2 room fields, seed members, idempotent
  second load, corrupt members file does not reset rooms.

Integration:

- launch a room bound to a member and assert the created Supervisor carries the
  member's provider/model and a prompt containing `## Member`;
- archive the Supervisor and assert an episode file plus the expected pending or
  promoted lessons;
- run the same test with `promotion: "auto"` and a global candidate, and assert it
  stays pending.

## 14. Rollout

| Slice | Contents | Risk |
| --- | --- | --- |
| 4a | `member.ts`, member store, migration, launch binding, seat resolution, prompt section | Medium: migration is forward-only |
| 4b | episode capture, promotion (human + auto), pending UI | Low: additive files |
| 4c | member screen, charter editor, lessons view, member chips in room UI | Low: client only |

4a alone delivers value: named, durable seat definitions replace the global seat
table. 4b is what makes them accumulate. Ship 4a and 4b together; 4c can follow.

## 15. Acceptance

1. Two rooms launched from the same member with different tasks create
   Supervisors with identical seat config and different prompts (different
   members, different tasks).
2. A room's Supervisor prompt contains the charter and only matching-scope
   lessons; no lesson from another repo appears.
3. After a room ends with `promotion: "human"`, its decisions appear in
   `pending.jsonl` and **not** in `lessons.jsonl`; accepting one appends it, and the
   next room's prompt contains it.
4. With `promotion: "auto"` and default `autoScopes`, a repo-scoped candidate is
   promoted and a global-scoped one is not.
5. A v1 `rooms.json` loads, gains null member ids, seeds two members, and
   serves a room without data loss; a second load is a no-op.
6. `npm test` and `npm run typecheck` pass in `agent-room`, and the guard tests are
   unchanged.

## 16. Open items (deliberately deferred)

- Worker members, and warm worker reuse bound to a member.
- Per-Lead member selection within one room (needs a grammar or seat-table
  change).
- Room-level seat overrides layered over member defaults.
- Live memory refresh via timeline rows for lessons promoted mid-room.
- Member routines and scheduled rooms.
- Cross-member or team memory.
- LLM-assisted episode summarization.
