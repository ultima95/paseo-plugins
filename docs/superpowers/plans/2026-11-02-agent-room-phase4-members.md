# Agent Room Phase 4 — Persistent Members and Scoped Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `agent-room` durable, named Supervisor and Lead members with charter/lessons memory, deterministic episode capture, configurable promotion, and a minimal member UI.

**Architecture:** A `members.json` store beside the existing `rooms.json` holds member records; per-member directories hold append-only `lessons.jsonl`, `pending.jsonl`, `episodes/<roomId>.jsonl`, and an atomic `charter.md`. `rooms.json` moves to version 2 with nullable `supervisorMemberId` / `leadMemberId`. Seat resolution stays pure and gains a `MemberIndex`; prompt rendering gains a `## Member` section between the role brief and the role table. Episode capture is derived from feed rows the plugin already builds; promotion runs on Supervisor archive.

**Tech Stack:** TypeScript 5.9 (strict), zod 4, vitest 4, `@getpaseo/plugin` 0.13.1, React Native primitives for the client, Node `fs/promises` + `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-11-02-agent-room-phase4-members-design.md`
**Prerequisite (merged):** `docs/superpowers/specs/2026-11-02-agent-room-role-titles-design.md`

## Global Constraints

- Work in an isolated git worktree; never implement on `main`.
- No new dependencies. Use `node:fs/promises`, `node:crypto`, `node:child_process` only.
- `members.json` is version 1; `rooms.json` is version 2 and forward-only.
- Memory files are plaintext under `$PASEO_HOME/plugin-data/agent-room`; created `0600`, directories `0700`.
- Members are `supervisor` or `lead` only. Worker roles resolve through the role catalog unchanged.
- Do not change the role-title grammar, the guard hierarchy, or existing room/seat names.
- Seat resolution and prompt rendering stay pure; all I/O happens in the hook, handlers, events, or stores.
- A failed memory write must never poison later writes; the room store and member store fail independently.
- Prompt text changes are made in `server/prompts/*.md` and regenerated with `npm run gen:prompts`; never edit `generated.ts` by hand.
- Commits are allowed on the worktree branch. Nothing is pushed or merged.
- Baseline before Task 1: `cd agent-room && npm test` = 959 passing, `npm run typecheck` clean.
- The live Paseo probe is user-run. Never reload the plugin or create agents on the running daemon.

## Open implementation questions and rulings

These are the four seams the spec leaves open. Each is binding for this plan.

### R1 — How a Lead member's seat reaches a Lead agent

Verified in `@getpaseo/plugin/dist/server/lifecycle.d.ts`: `PluginBeforeRequests["agent.create"]` is `{ config: AgentSessionConfig; env?: Record<string, string> }`, and `AgentSessionConfig` has no parent id or labels. The pre-create hook therefore cannot map a `Lead:` create to a room. The Supervisor is different: `room.launch` renders its prompt and seat before the create, and the hook passes an already-prompted request through.

**Ruling:** the Supervisor's rendered role table shows the bound Lead member's provider/model. The Supervisor is instructed to pass that `provider` value. `applySeat` treats a request whose `provider`/`model` exactly match a configured member of the named role kind (supervisor or lead) as that member's launch, and applies the member's `modeId` / `thinkingOptionId` / `features`. Otherwise the role catalog's seat wins. `leadMemberId` is still recorded on the room for memory and UI. Two Lead members sharing the same provider/model are indistinguishable in the hook; the first catalog match wins — documented limit.

### R2 — Binding order between `room.launch` and `agent.created`

`agent.created` may run before or after the launch handler receives the new agent id. The room record is written by `agent.created`, so a handler-side write alone would race.

**Ruling:** `RoomStore.bindRoomMembers(roomId, binding)` is order-independent. If the room exists it updates the record and schedules a write; if it does not, it stores a pending binding that `addRoom` merges when the hook records the room. `agent.created` always writes `supervisorMemberId: null, leadMemberId: null` and relies on the merge.

### R3 — Which scope a promotion candidate gets

The spec shows a policy table with global candidates but does not say how a room produces one deterministically. Scope must not be guessed by a model.

**Ruling:** at archive, one scope is derived per room: `repo:<sha8>` when `git remote get-url origin` resolves (or the repository root fallback), else `workspace:<cwd>`. A fact is not duplicated across scopes. Global candidates are only produced by explicit input (tests/import/future routines); `autoScopes` still governs them and the default excludes global. The global row of the policy table is pinned by `server/promotion.test.ts`, not by a live-room integration test.

### R4 — Which client surfaces show members in v1

The Supervisor's `room-status` fence carries workstreams, not member ids, so the status card cannot identify a member without changing the fence grammar.

**Ruling:** all three slices ship. Member names appear in the seat tree and in the room list row chips; the member screen owns charter/lessons/pending/episodes. The `room-status` card is unchanged. A truncation feed note is written by `onCreated` / `room.launch` where a room id exists; the create hook logs the truncation once.

## Review Focus

These five input classes are implied by the spec but not covered by any single existing test. Each gets the pinning test named in its owning task.

1. A `rooms.json` v1 file with missing member fields loads, gains null member ids, and is rewritten once as v2 without losing rooms/seats/feed — Task 2.
2. A corrupt `members.json` or a corrupt line inside `lessons.jsonl` degrades only the member store and never resets rooms — Tasks 3 and 4.
3. A cwd that is not a git repository, has no `origin`, or has an origin with a trailing `.git` resolves to a stable repo id or a workspace scope without throwing — Task 5.
4. A member with an oversized charter, more than 12 matching lessons, or zero lessons renders deterministically and reports truncation once — Task 6.
5. A `Lead:` create whose requested seat matches no configured member still gets the role catalog's seat and no member section; a launched Supervisor that already carries the protocol is not re-seated or given a second section — Task 7.

---

## Task 0: Worktree, baseline, and plan copy

**Files:**
- Create: `docs/superpowers/plans/2026-11-02-agent-room-phase4-members.md` (copied from this plan)

**Interfaces:**
- Consumes: merged `main` at `7f9cdbf`.
- Produces: branch `worktree-feat+agent-room-phase4-members` with a clean baseline.

- [ ] **Step 1: Create the isolated worktree**

```bash
cd /Users/ultima/Workspace/paseo-plugins
git worktree add ../paseo-plugins-phase4 -b worktree-feat+agent-room-phase4-members main
cd ../paseo-plugins-phase4
```

- [ ] **Step 2: Install dev dependencies and record the baseline**

```bash
cd agent-room
npm ci --include=dev
npm test          # expect 959 passing
npm run typecheck # expect no output, exit 0
```

- [ ] **Step 3: Copy this plan into the repository and commit it**

```bash
mkdir -p docs/superpowers/plans
cp ~/.commandcode/plans/agent-room-phase4-members.md \
   docs/superpowers/plans/2026-11-02-agent-room-phase4-members.md
git add docs/superpowers/plans/2026-11-02-agent-room-phase4-members.md
git commit -m "docs: add agent room phase 4 implementation plan"
```

---

## Task 1: Member schema and scope helpers

**Files:**
- Create: `agent-room/shared/member.ts`
- Test: `agent-room/shared/member.test.ts`

**Interfaces:**
- Consumes: `seatConfigSchema` from `shared/roles.ts`, `timestampSchema` from `shared/room.ts`.
- Produces:
  - `MEMBERS_FILE_VERSION = 1`
  - `LESSON_TEXT_CAP = 240`, `CHARTER_PROMPT_CAP = 4096`, `MEMBER_SECTION_CAP = 6144`, `LESSON_PROMPT_CAP = 12`
  - `memoryScopeTypeSchema`, `memoryPolicySchema`, `memberRoleSchema`, `memberRecordSchema`, `membersFileSchema`
  - `lessonSchema`, `pendingCandidateSchema`, `episodeKindSchema`, `episodeFactSchema`
  - `GLOBAL_SCOPE`, `repoScope(id)`, `workspaceScope(path)`, `normalizeWorkspacePath(path)`, `scopeType(scope)`
  - Types `MemberRecord`, `MemoryPolicy`, `MemberRole`, `Lesson`, `PendingCandidate`, `EpisodeFact`, `EpisodeKind`

- [ ] **Step 1: Write the failing schema tests**

```ts
// agent-room/shared/member.test.ts
import { describe, expect, it } from "vitest";

import {
  GLOBAL_SCOPE,
  LESSON_TEXT_CAP,
  lessonSchema,
  memberRecordSchema,
  memoryPolicySchema,
  normalizeWorkspacePath,
  repoScope,
  scopeType,
  workspaceScope,
} from "./member";

const base = {
  id: "default-lead",
  name: "Lead",
  role: "lead" as const,
  provider: "claude",
  model: "claude-opus-5-5",
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  memory: { promotion: "human" as const },
};

describe("memoryPolicySchema", () => {
  it("defaults autoScopes to repo and workspace", () => {
    expect(memoryPolicySchema.parse({ promotion: "human" })).toEqual({
      promotion: "human",
      autoScopes: ["repo", "workspace"],
    });
  });

  it("rejects an unknown scope type", () => {
    expect(
      memoryPolicySchema.safeParse({ promotion: "auto", autoScopes: ["global", "team"] }).success,
    ).toBe(false);
  });
});

describe("memberRecordSchema", () => {
  it("accepts a supervisor and a lead", () => {
    expect(memberRecordSchema.safeParse(base).success).toBe(true);
    expect(memberRecordSchema.safeParse({ ...base, role: "supervisor" }).success).toBe(true);
  });

  it("rejects worker members and empty seats", () => {
    expect(memberRecordSchema.safeParse({ ...base, role: "worker" }).success).toBe(false);
    expect(memberRecordSchema.safeParse({ ...base, provider: "" }).success).toBe(false);
    expect(memberRecordSchema.safeParse({ ...base, name: "x".repeat(61) }).success).toBe(false);
  });
});

describe("scope helpers", () => {
  it("normalizes workspace paths exactly", () => {
    expect(normalizeWorkspacePath("/a/b/")).toBe("/a/b");
    expect(normalizeWorkspacePath("/a/b//")).toBe("/a/b");
    expect(normalizeWorkspacePath("/")).toBe("/");
    expect(normalizeWorkspacePath("C:\\a\\b\\")).toBe("C:/a/b");
  });

  it("classifies the three scope shapes", () => {
    expect(scopeType(GLOBAL_SCOPE)).toBe("global");
    expect(scopeType(repoScope("8f3c1a2b"))).toBe("repo");
    expect(scopeType(workspaceScope("/a/b"))).toBe("workspace");
  });
});

describe("lessonSchema", () => {
  it("accepts a dated scoped lesson", () => {
    expect(
      lessonSchema.safeParse({
        at: "2026-11-02T10:00:00.000Z",
        scope: repoScope("8f3c1a2b"),
        text: "use pnpm",
        sourceRoomId: "A1",
        promotedBy: "human",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown scope and an oversized lesson", () => {
    expect(
      lessonSchema.safeParse({
        at: "2026-11-02T10:00:00.000Z",
        scope: "team:core",
        text: "x",
        sourceRoomId: "A1",
        promotedBy: "auto",
      }).success,
    ).toBe(false);
    expect(
      lessonSchema.safeParse({
        at: "2026-11-02T10:00:00.000Z",
        scope: GLOBAL_SCOPE,
        text: "x".repeat(LESSON_TEXT_CAP + 1),
        sourceRoomId: "A1",
        promotedBy: "auto",
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run shared/member.test.ts
```

Expected: FAIL with `Failed to resolve import "./member"`.

- [ ] **Step 3: Implement `shared/member.ts`**

```ts
import { z } from "zod";

import { seatConfigSchema } from "./roles";
import { timestampSchema } from "./room";

export const MEMBERS_FILE_VERSION = 1;
export const LESSON_TEXT_CAP = 240;
export const CHARTER_PROMPT_CAP = 4096;
export const MEMBER_SECTION_CAP = 6144;
export const LESSON_PROMPT_CAP = 12;

export const memoryScopeTypeSchema = z.enum(["global", "repo", "workspace"]);
export type MemoryScopeType = z.infer<typeof memoryScopeTypeSchema>;

export const GLOBAL_SCOPE = "global" as const;

/** Normalize a workspace path for exact-match scope identity. */
export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return trimmed;
  const slashed = trimmed.replace(/\\/g, "/");
  const isRoot = slashed === "/" || /^[A-Za-z]:\/$/.test(slashed);
  if (isRoot) return slashed;
  return slashed.replace(/\/+$/, "");
}

export function repoScope(id: string): string {
  return `repo:${id}`;
}

export function workspaceScope(path: string): string {
  return `workspace:${normalizeWorkspacePath(path)}`;
}

/** The type of a scope string. Validity is enforced by `memoryScopeSchema`. */
export function scopeType(scope: string): MemoryScopeType {
  if (scope === GLOBAL_SCOPE) return "global";
  if (scope.startsWith("repo:")) return "repo";
  return "workspace";
}

export const memoryScopeSchema = z.string().refine((scope) => {
  if (scope === GLOBAL_SCOPE) return true;
  if (scope.startsWith("repo:")) return /^repo:[0-9a-f]{8}$/.test(scope);
  if (scope.startsWith("workspace:")) return scope.length > "workspace:".length;
  return false;
}, "invalid memory scope");

export const memoryPolicySchema = z.object({
  // human: candidates wait in pending.jsonl. auto: candidates whose scope type
  // is listed in autoScopes are promoted without review.
  promotion: z.enum(["human", "auto"]),
  // Narrower than promotion on purpose: global lessons default to review.
  autoScopes: z.array(memoryScopeTypeSchema).default(["repo", "workspace"]),
});
export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

export const memberRoleSchema = z.enum(["supervisor", "lead"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberRecordSchema = seatConfigSchema.extend({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  role: memberRoleSchema,
  memory: memoryPolicySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type MemberRecord = z.infer<typeof memberRecordSchema>;

export const membersFileSchema = z.object({
  version: z.literal(MEMBERS_FILE_VERSION),
  members: z.array(memberRecordSchema),
});
export type MembersFile = z.infer<typeof membersFileSchema>;

export const lessonSchema = z.object({
  at: timestampSchema,
  scope: memoryScopeSchema,
  text: z.string().min(1).max(LESSON_TEXT_CAP),
  sourceRoomId: z.string().min(1),
  promotedBy: z.enum(["human", "auto"]),
});
export type Lesson = z.infer<typeof lessonSchema>;

export const pendingCandidateSchema = z.object({
  id: z.string().min(1),
  at: timestampSchema,
  scope: memoryScopeSchema,
  text: z.string().min(1).max(LESSON_TEXT_CAP),
  sourceRoomId: z.string().min(1),
  // A tombstone the UI appends after a reject, so the candidate is not proposed again.
  rejected: z.literal(true).optional(),
});
export type PendingCandidate = z.infer<typeof pendingCandidateSchema>;

export const episodeKindSchema = z.enum(["task", "decision", "rejected", "outcome", "blocked"]);
export type EpisodeKind = z.infer<typeof episodeKindSchema>;

export const episodeFactSchema = z.object({
  at: timestampSchema,
  kind: episodeKindSchema,
  signal: z.string().optional(),
  text: z.string().min(1),
});
export type EpisodeFact = z.infer<typeof episodeFactSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run shared/member.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add agent-room/shared/member.ts agent-room/shared/member.test.ts
git commit -m "feat(agent-room): add member records and scoped-memory schemas"
```

---

## Task 2: `rooms.json` v2, migration, and member binding

**Files:**
- Modify: `agent-room/shared/room.ts`
- Modify: `agent-room/server/store.ts`
- Test: `agent-room/shared/room.test.ts` (new)
- Test: `agent-room/server/store.test.ts`

**Interfaces:**
- Consumes: Task 1 none.
- Produces:
  - `ROOMS_FILE_VERSION = 2`, `LEGACY_ROOMS_FILE_VERSION = 1`
  - `RoomRecord.supervisorMemberId: string | null`, `RoomRecord.leadMemberId: string | null`
  - `RoomStore.bindRoomMembers(roomId, { supervisorMemberId?: string | null; leadMemberId?: string | null }): void`
  - `RoomStore.migratedFromV1(): boolean`

- [ ] **Step 1: Write the failing room-schema tests**

```ts
// agent-room/shared/room.test.ts
import { describe, expect, it } from "vitest";

import { ROOMS_FILE_VERSION, roomsFileSchema } from "./room";

const roomV1 = {
  id: "R",
  task: "fix",
  cwd: "/repo",
  workspaceId: null,
  createdAt: "2026-11-02T00:00:00.000Z",
};

describe("roomsFileSchema", () => {
  it("accepts v1 and normalizes member ids to null", () => {
    const parsed = roomsFileSchema.parse({ version: 1, rooms: [roomV1], seats: [], feed: [] });
    expect(parsed.rooms[0]).toMatchObject({ supervisorMemberId: null, leadMemberId: null });
  });

  it("accepts v2 with member ids", () => {
    const parsed = roomsFileSchema.parse({
      version: 2,
      rooms: [{ ...roomV1, supervisorMemberId: "sup-1", leadMemberId: "lead-1" }],
      seats: [],
      feed: [],
    });
    expect(parsed.version).toBe(ROOMS_FILE_VERSION);
    expect(parsed.rooms[0]).toMatchObject({ supervisorMemberId: "sup-1", leadMemberId: "lead-1" });
  });

  it("rejects an unknown version", () => {
    expect(roomsFileSchema.safeParse({ version: 3, rooms: [], seats: [], feed: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing store-migration tests**

Add to `agent-room/server/store.test.ts`:

```ts
it("migrates a v1 file to v2 and reports it once", async () => {
  await writeFile(
    file,
    JSON.stringify({ version: 1, rooms: [room("R")], seats: [], feed: [] }),
    "utf8",
  );
  const s = make();
  await s.load();

  expect(s.migratedFromV1()).toBe(true);
  expect(s.room("R")!.room).toMatchObject({ supervisorMemberId: null, leadMemberId: null });

  await s.flush();
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  expect(onDisk.version).toBe(2);
  expect(onDisk.rooms[0]).toMatchObject({ supervisorMemberId: null, leadMemberId: null });

  // A second load reads v2 and no longer reports a migration.
  const again = make();
  await again.load();
  expect(again.migratedFromV1()).toBe(false);
});

it("binds members whether the room is recorded before or after the binding", () => {
  const s = make();

  // Binding first: the pending binding is merged by addRoom.
  s.bindRoomMembers("R", { supervisorMemberId: "sup-1", leadMemberId: "lead-1" });
  s.addRoom(room("R"));
  expect(s.room("R")!.room).toMatchObject({
    supervisorMemberId: "sup-1",
    leadMemberId: "lead-1",
  });

  // Room first: the binding updates it in place.
  s.addRoom(room("X"));
  s.bindRoomMembers("X", { supervisorMemberId: "sup-2" });
  expect(s.room("X")!.room).toMatchObject({
    supervisorMemberId: "sup-2",
    leadMemberId: null,
  });
});

it("keeps member ids across a reload", async () => {
  const a = make();
  a.addRoom(room("R"));
  a.bindRoomMembers("R", { supervisorMemberId: "sup-1", leadMemberId: "lead-1" });
  await a.flush();

  const b = make();
  await b.load();
  expect(b.room("R")!.room).toMatchObject({
    supervisorMemberId: "sup-1",
    leadMemberId: "lead-1",
  });
});
```

Update the existing test that expects `written.version` to be `2`. Update the `room()` helper to include the two nullable fields, or rely on the schema default; a typed `RoomRecord` return needs them, so write:

```ts
const room = (id: string, createdAt = "2026-10-28T10:00:00.000Z"): RoomRecord => ({
  id,
  task: `task ${id}`,
  cwd: "/repo",
  workspaceId: null,
  supervisorMemberId: null,
  leadMemberId: null,
  createdAt,
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run shared/room.test.ts server/store.test.ts
```

Expected: FAIL on the missing fields, the version union, and `migratedFromV1`.

- [ ] **Step 4: Implement the schema changes**

In `agent-room/shared/room.ts`:

```ts
/** Schema version of `rooms.json`; version 2 adds room member bindings. */
export const ROOMS_FILE_VERSION = 2;
/** Version 1 is read and migrated in memory, then rewritten as version 2. */
export const LEGACY_ROOMS_FILE_VERSION = 1;

export const roomRecordSchema = z.object({
  id: nonEmptyText,
  task: z.string(),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  // Bound at launch. `default(null)` is what lets a v1 row parse without them.
  supervisorMemberId: z.string().nullable().default(null),
  leadMemberId: z.string().nullable().default(null),
  createdAt: timestampSchema,
  endedAt: timestampSchema.optional(),
});

const roomsDocumentSchema = z.object({
  rooms: z.array(roomRecordSchema),
  seats: z.array(seatRecordSchema),
  feed: z.array(feedEventSchema),
});

export const roomsFileSchema = z.discriminatedUnion("version", [
  roomsDocumentSchema.extend({ version: z.literal(LEGACY_ROOMS_FILE_VERSION) }),
  roomsDocumentSchema.extend({ version: z.literal(ROOMS_FILE_VERSION) }),
]);

export type RoomsFile = z.infer<typeof roomsFileSchema>;
```

- [ ] **Step 5: Implement the store changes**

In `agent-room/server/store.ts`, add to `RoomStore`:

```ts
  /**
   * Bind the room's Supervisor and Lead members. Order-independent: a call
   * before the room exists is merged by `addRoom`, because `room.launch`
   * cannot know whether `agent.created` has run yet.
   */
  bindRoomMembers(
    roomId: string,
    binding: { supervisorMemberId?: string | null; leadMemberId?: string | null },
  ): void;
  /** True when the load migrated a v1 document; drives the one-time member seed. */
  migratedFromV1(): boolean;
```

Inside `createRoomStore`:

```ts
  let migratedFromV1 = false;
  const pendingBindings = new Map<
    string,
    { supervisorMemberId: string | null; leadMemberId: string | null }
  >();
```

`snapshot()` keeps writing `ROOMS_FILE_VERSION` (now 2). In `load`, after `roomsFileSchema.safeParse` succeeds:

```ts
    if (result.data.version === LEGACY_ROOMS_FILE_VERSION) {
      migratedFromV1 = true;
      // Write the normalized v2 document through the same atomic path.
      scheduleWrite();
    }
```

In `addRoom`:

```ts
    const pending = pendingBindings.get(record.id);
    if (pending !== undefined) {
      record.supervisorMemberId = pending.supervisorMemberId;
      record.leadMemberId = pending.leadMemberId;
      pendingBindings.delete(record.id);
    }
```

Add the methods:

```ts
  const bindRoomMembers = (
    roomId: string,
    binding: { supervisorMemberId?: string | null; leadMemberId?: string | null },
  ): void => {
    const current = pendingBindings.get(roomId) ?? {
      supervisorMemberId: null,
      leadMemberId: null,
    };
    const next = {
      supervisorMemberId:
        binding.supervisorMemberId !== undefined
          ? binding.supervisorMemberId
          : current.supervisorMemberId,
      leadMemberId:
        binding.leadMemberId !== undefined ? binding.leadMemberId : current.leadMemberId,
    };
    pendingBindings.set(roomId, next);

    const target = rooms.find((candidate) => candidate.id === roomId);
    if (target !== undefined) {
      target.supervisorMemberId = next.supervisorMemberId;
      target.leadMemberId = next.leadMemberId;
      scheduleWrite();
    }
  };

  const migrated = (): boolean => migratedFromV1;
```

Return both from the object. In `reset`, also `pendingBindings.clear()` and `migratedFromV1 = false`.

- [ ] **Step 6: Update typed fixtures**

Every `RoomRecord` literal now needs the two fields. Update:

- `agent-room/server/events.test.ts` `room()` helper and every inline room literal.
- `agent-room/server/handlers.test.ts` `roomRecord()` helper and the `addRoom` expectation in `adopt`.
- `agent-room/server/index.server.test.ts` where it constructs room records (if any).
- `agent-room/server/gc/render.test.ts` is unrelated to `RoomRecord`; leave it.
- `agent-room/server/store.test.ts` helper as shown above.

For the `adopt` expectation, assert with `expect.objectContaining` or add the two null fields:

```ts
expect(addRoom).toHaveBeenCalledWith({
  id: "S1",
  task: "New chat",
  cwd: "/repo",
  workspaceId: "W1",
  supervisorMemberId: null,
  leadMemberId: null,
  createdAt: "2026-10-28T10:00:00.000Z",
});
```

In `handlers.ts`, the `adopt` `store.addRoom(...)` call must include both `null` fields.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run shared/room.test.ts server/store.test.ts server/handlers.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add agent-room/shared/room.ts agent-room/shared/room.test.ts \
        agent-room/server/store.ts agent-room/server/store.test.ts \
        agent-room/server/handlers.ts agent-room/server/handlers.test.ts \
        agent-room/server/events.test.ts
git commit -m "feat(agent-room): migrate rooms to v2 and bind member ids"
```

---

## Task 3: File-backed member store

**Files:**
- Create: `agent-room/server/member-store.ts`
- Test: `agent-room/server/member-store.test.ts`

**Interfaces:**
- Consumes: `shared/member.ts` schemas; `Logger`.
- Produces:
  - `createMemberStore({ dir, now, newId, log }): MemberStore`
  - `lessonKey(scope, text): string`
  - `normalizeLessonText(text): string`
  - `MemberStore` methods: `load`, `missingFile`, `list`, `get`, `upsert`, `charter`, `writeCharter`, `lessons`, `lessonsFor`, `hasLesson`, `pending`, `hasPending`, `appendLesson`, `appendPending`, `acceptPending`, `rejectPending`, `appendEpisode`, `episodes`, `flush`

- [ ] **Step 1: Write the failing store tests**

```ts
// agent-room/server/member-store.test.ts
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memberRecordSchema, type Lesson } from "../shared/member";
import type { Logger } from "./logger";
import { createMemberStore, lessonKey } from "./member-store";

let dir: string;
let clock: number;
let seq: number;
let log: Logger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-room-members-"));
  clock = Date.parse("2026-11-02T10:00:00.000Z");
  seq = 0;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function make() {
  return createMemberStore({ dir, now: () => (clock += 1000), newId: () => `m${++seq}`, log });
}

const record = (id: string, role: "supervisor" | "lead" = "lead") =>
  memberRecordSchema.parse({
    id,
    name: role === "lead" ? "Lead" : "Supervisor",
    role,
    provider: "claude",
    model: "claude-opus-5-5",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
  });

const lesson = (scope: string, text: string): Lesson => ({
  at: "2026-11-02T10:00:00.000Z",
  scope,
  text,
  sourceRoomId: "R1",
  promotedBy: "human",
});

describe("createMemberStore", () => {
  it("persists records, charter, lessons and pending across instances", async () => {
    const a = make();
    await a.load();
    await a.upsert(record("lead-1"));
    await a.writeCharter("lead-1", "Use pnpm.");
    await a.appendLesson("lead-1", lesson("repo:8f3c1a2b", "use pnpm"));
    await a.appendPending("lead-1", {
      id: lessonKey("repo:8f3c1a2b", "prefer small diffs"),
      at: "2026-11-02T10:00:00.000Z",
      scope: "repo:8f3c1a2b",
      text: "prefer small diffs",
      sourceRoomId: "R1",
    });
    await a.flush();

    const b = make();
    await b.load();
    expect(b.list().map((member) => member.id)).toEqual(["lead-1"]);
    expect(b.charter("lead-1")).toBe("Use pnpm.");
    expect(b.lessons("lead-1")).toHaveLength(1);
    expect(b.pending("lead-1")).toHaveLength(1);
  });

  it("creates member files 0600 and directories 0700", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.writeCharter("lead-1", "x");
    await s.appendLesson("lead-1", lesson("global", "x"));
    await s.flush();

    expect((await stat(join(dir, "members"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "members", "lead-1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "members", "lead-1", "charter.md"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "members", "lead-1", "lessons.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("skips a corrupt lesson line and keeps the rest", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.writeCharter("lead-1", "");
    await s.appendLesson("lead-1", lesson("global", "good"));
    await s.flush();

    const file = join(dir, "members", "lead-1", "lessons.jsonl");
    await writeFile(file, `${await readFile(file, "utf8")}{not json}\n`, "utf8");

    const b = make();
    await b.load();
    expect(b.lessons("lead-1").map((entry) => entry.text)).toEqual(["good"]);
    expect(log.warn).toHaveBeenCalledWith(
      "skipping corrupt lesson line",
      expect.objectContaining({ memberId: "lead-1" }),
    );
  });

  it("keeps independent failures: a corrupt members.json does not throw", async () => {
    await writeFile(join(dir, "members.json"), "{not json", "utf8");
    const s = make();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.list()).toEqual([]);
    expect(s.missingFile()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "members store corrupt; starting empty",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("dedupes lessons by scope plus normalized text", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.appendLesson("lead-1", lesson("repo:8f3c1a2b", "Use  pnpm"));
    await s.appendLesson("lead-1", lesson("repo:8f3c1a2b", " use pnpm "));
    await s.flush();
    expect(s.lessons("lead-1")).toHaveLength(1);
  });

  it("accepts and rejects pending candidates", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    const candidate = {
      id: lessonKey("repo:8f3c1a2b", "use pnpm"),
      at: "2026-11-02T10:00:00.000Z",
      scope: "repo:8f3c1a2b",
      text: "use pnpm",
      sourceRoomId: "R1",
    };
    await s.appendPending("lead-1", candidate);

    const accepted = await s.acceptPending("lead-1", candidate.id);
    expect(accepted).toMatchObject({ text: "use pnpm", promotedBy: "human" });
    expect(s.pending("lead-1")).toHaveLength(0);
    expect(s.lessons("lead-1")).toHaveLength(1);

    const second = { ...candidate, id: lessonKey("global", "prefer small diffs"), scope: "global", text: "prefer small diffs" };
    await s.appendPending("lead-1", second);
    await s.rejectPending("lead-1", second.id);
    expect(s.pending("lead-1")).toHaveLength(0);
    expect(s.hasPending("lead-1", second.id)).toBe(true);
  });

  it("appends and reads episodes per room", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    await s.appendEpisode("lead-1", "R1", {
      at: "2026-11-02T10:00:00.000Z",
      kind: "decision",
      signal: "DECISION_NEEDED",
      text: "use pnpm",
    });
    await s.appendEpisode("lead-1", "R2", {
      at: "2026-11-02T11:00:00.000Z",
      kind: "outcome",
      text: "room ended",
    });
    await s.flush();

    const facts = await s.episodes("lead-1");
    expect(facts.map((fact) => fact.roomId)).toEqual(["R1", "R2"]);
  });

  it("serialises appends in order", async () => {
    const s = make();
    await s.load();
    await s.upsert(record("lead-1"));
    for (let i = 0; i < 20; i += 1) {
      await s.appendLesson("lead-1", lesson("global", `lesson ${i}`));
    }
    await s.flush();
    expect(s.lessons("lead-1").map((entry) => entry.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `lesson ${i}`),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/member-store.test.ts
```

Expected: FAIL with `Failed to resolve import "./member-store"`.

- [ ] **Step 3: Implement `server/member-store.ts`**

```ts
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  MEMBERS_FILE_VERSION,
  episodeFactSchema,
  lessonSchema,
  membersFileSchema,
  memberRecordSchema,
  pendingCandidateSchema,
  type EpisodeFact,
  type Lesson,
  type MemberRecord,
  type PendingCandidate,
} from "../shared/member";
import type { Logger } from "./logger";

export interface MemberStoreDeps {
  /** The plugin data dir; `members.json` and `members/` live directly under it. */
  dir: string;
  now: () => number;
  newId: () => string;
  log: Logger;
}

export interface MemberStore {
  load(): Promise<void>;
  /** True when `members.json` did not exist at load (an ENOENT, not corruption). */
  missingFile(): boolean;
  list(): MemberRecord[];
  get(id: string): MemberRecord | undefined;
  upsert(record: MemberRecord): Promise<void>;
  charter(id: string): string;
  writeCharter(id: string, text: string): Promise<void>;
  lessons(id: string): Lesson[];
  /** Matching scopes, newest first. */
  lessonsFor(id: string, scopes: readonly string[]): Lesson[];
  hasLesson(id: string, scope: string, text: string): boolean;
  /** Live candidates only: no tombstones, no candidates already promoted. */
  pending(id: string): PendingCandidate[];
  /** True for any candidate line for this id, including a reject tombstone. */
  hasPending(id: string, candidateId: string): boolean;
  appendLesson(id: string, lesson: Lesson): Promise<boolean>;
  appendPending(id: string, candidate: PendingCandidate): Promise<boolean>;
  acceptPending(id: string, candidateId: string): Promise<Lesson | null>;
  rejectPending(id: string, candidateId: string): Promise<boolean>;
  appendEpisode(id: string, roomId: string, fact: EpisodeFact): Promise<void>;
  episodes(id: string): Promise<Array<EpisodeFact & { roomId: string }>>;
  flush(): Promise<void>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collapse whitespace and lowercase, so duplicates differ only by those. */
export function normalizeLessonText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable candidate/lesson identity: scope plus normalized text. */
export function lessonKey(scope: string, text: string): string {
  return createHash("sha256")
    .update(`${scope}\n${normalizeLessonText(text)}`)
    .digest("hex")
    .slice(0, 16);
}

/** Agent ids are UUIDs, but a room id still must not escape its directory. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function createMemberStore(deps: MemberStoreDeps): MemberStore {
  const { dir, now, newId, log } = deps;

  let records: MemberRecord[] = [];
  let missing = false;
  const charters = new Map<string, string>();
  const lessonsById = new Map<string, Lesson[]>();
  const pendingById = new Map<string, PendingCandidate[]>();

  const queues = new Map<string, Promise<void>>();
  const RECORDS_QUEUE = "\u0000records";

  const enqueue = (key: string, task: () => Promise<void>): Promise<void> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await task();
      } catch (error) {
        // A failed write must not poison later writes.
        log.error("member store write failed", { key, error: reason(error) });
      }
    });
    queues.set(key, next);
    return next;
  };

  const recordsFile = (): string => join(dir, "members.json");
  const memberDir = (id: string): string => join(dir, "members", safeSegment(id));
  const charterFile = (id: string): string => join(memberDir(id), "charter.md");
  const lessonsFile = (id: string): string => join(memberDir(id), "lessons.jsonl");
  const pendingFile = (id: string): string => join(memberDir(id), "pending.jsonl");
  const episodesDir = (id: string): string => join(memberDir(id), "episodes");
  const episodeFile = (id: string, roomId: string): string =>
    join(episodesDir(id), `${safeSegment(roomId)}.jsonl`);

  const ensureDir = async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  };

  const writeAtomic = async (file: string, text: string): Promise<void> => {
    await ensureDir(dirname(file));
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  };

  const appendJsonLine = async (file: string, value: unknown): Promise<void> => {
    await ensureDir(dirname(file));
    await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  const readJsonLines = async <T>(
    file: string,
    parse: (value: unknown) => T | null,
    onBadLine: (line: string) => void,
  ): Promise<T[]> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const values: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        onBadLine(trimmed);
        continue;
      }
      const parsed = parse(value);
      if (parsed === null) onBadLine(trimmed);
      else values.push(parsed);
    }
    return values;
  };

  const parseLesson = (value: unknown): Lesson | null => {
    const parsed = lessonSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const parsePending = (value: unknown): PendingCandidate | null => {
    const parsed = pendingCandidateSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const parseEpisode = (value: unknown): EpisodeFact | null => {
    const parsed = episodeFactSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  const loadMemberFiles = async (id: string): Promise<void> => {
    try {
      charters.set(id, await readFile(charterFile(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      charters.set(id, "");
    }
    lessonsById.set(
      id,
      await readJsonLines(lessonsFile(id), parseLesson, () =>
        log.warn("skipping corrupt lesson line", { memberId: id }),
      ),
    );
    pendingById.set(
      id,
      await readJsonLines(pendingFile(id), parsePending, () =>
        log.warn("skipping corrupt pending line", { memberId: id }),
      ),
    );
  };

  const load = async (): Promise<void> => {
    records = [];
    missing = false;
    charters.clear();
    lessonsById.clear();
    pendingById.clear();

    let raw: string;
    try {
      raw = await readFile(recordsFile(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing = true;
        return;
      }
      log.warn("members store unreadable; starting empty", { error: reason(error) });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn("members store corrupt; starting empty", { error: reason(error) });
      return;
    }

    const result = membersFileSchema.safeParse(parsed);
    if (!result.success) {
      log.warn("members store corrupt; starting empty", {
        issues: result.error.issues.length,
        error: result.error.issues[0]?.message ?? "invalid members store",
      });
      return;
    }

    records = result.data.members;
    for (const member of records) await loadMemberFiles(member.id);
  };

  const upsert = async (record: MemberRecord): Promise<void> => {
    const parsed = memberRecordSchema.safeParse(record);
    if (!parsed.success) {
      log.error("rejected invalid member", { error: reason(parsed.error) });
      return;
    }
    const index = records.findIndex((candidate) => candidate.id === parsed.data.id);
    if (index === -1) records.push(parsed.data);
    else records[index] = parsed.data;
    await enqueue(RECORDS_QUEUE, () =>
      writeAtomic(
        recordsFile(),
        `${JSON.stringify({ version: MEMBERS_FILE_VERSION, members: records }, null, 2)}\n`,
      ),
    );
  };

  const list = (): MemberRecord[] =>
    [...records].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const get = (id: string): MemberRecord | undefined =>
    records.find((candidate) => candidate.id === id);

  const charter = (id: string): string => charters.get(id) ?? "";

  const writeCharter = async (id: string, text: string): Promise<void> => {
    charters.set(id, text);
    await enqueue(id, () => writeAtomic(charterFile(id), text));
  };

  const lessons = (id: string): Lesson[] => lessonsById.get(id) ?? [];

  const hasLesson = (id: string, scope: string, text: string): boolean => {
    const key = lessonKey(scope, text);
    return lessons(id).some((lesson) => lessonKey(lesson.scope, lesson.text) === key);
  };

  const lessKeys = (id: string): Set<string> =>
    new Set(lessons(id).map((lesson) => lessonKey(lesson.scope, lesson.text)));

  const lessonsFor = (id: string, scopes: readonly string[]): Lesson[] => {
    const wanted = new Set(scopes);
    return lessons(id)
      .filter((lesson) => wanted.has(lesson.scope))
      .sort((a, b) => b.at.localeCompare(a.at));
  };

  const hasPending = (id: string, candidateId: string): boolean =>
    (pendingById.get(id) ?? []).some((candidate) => candidate.id === candidateId);

  const pending = (id: string): PendingCandidate[] => {
    const promoted = lessKeys(id);
    const seen = new Set<string>();
    const live: PendingCandidate[] = [];
    for (const candidate of pendingById.get(id) ?? []) {
      if (candidate.rejected === true) continue;
      if (seen.has(candidate.id)) continue;
      if (promoted.has(lessonKey(candidate.scope, candidate.text))) continue;
      seen.add(candidate.id);
      live.push(candidate);
    }
    return live;
  };

  const appendLesson = async (id: string, lesson: Lesson): Promise<boolean> => {
    const parsed = lessonSchema.safeParse(lesson);
    if (!parsed.success) {
      log.error("rejected invalid lesson", { memberId: id, error: reason(parsed.error) });
      return false;
    }
    if (hasLesson(id, parsed.data.scope, parsed.data.text)) return false;
    lessonsById.set(id, [...lessons(id), parsed.data]);
    await enqueue(id, () => appendJsonLine(lessonsFile(id), parsed.data));
    return true;
  };

  const appendPending = async (id: string, candidate: PendingCandidate): Promise<boolean> => {
    const parsed = pendingCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      log.error("rejected invalid pending candidate", {
        memberId: id,
        error: reason(parsed.error),
      });
      return false;
    }
    if (hasPending(id, parsed.data.id)) return false;
    if (hasLesson(id, parsed.data.scope, parsed.data.text)) return false;
    pendingById.set(id, [...(pendingById.get(id) ?? []), parsed.data]);
    await enqueue(id, () => appendJsonLine(pendingFile(id), parsed.data));
    return true;
  };

  const acceptPending = async (id: string, candidateId: string): Promise<Lesson | null> => {
    const candidate = pending(id).find((entry) => entry.id === candidateId);
    if (candidate === undefined) return null;
    const lesson: Lesson = {
      at: new Date(now()).toISOString(),
      scope: candidate.scope,
      text: candidate.text,
      sourceRoomId: candidate.sourceRoomId,
      promotedBy: "human",
    };
    const added = await appendLesson(id, lesson);
    return added ? lesson : null;
  };

  const rejectPending = async (id: string, candidateId: string): Promise<boolean> => {
    const candidate = pending(id).find((entry) => entry.id === candidateId);
    if (candidate === undefined) return false;
    const tombstone: PendingCandidate = {
      ...candidate,
      at: new Date(now()).toISOString(),
      rejected: true,
    };
    pendingById.set(id, [...(pendingById.get(id) ?? []), tombstone]);
    await enqueue(id, () => appendJsonLine(pendingFile(id), tombstone));
    return true;
  };

  const appendEpisode = async (id: string, roomId: string, fact: EpisodeFact): Promise<void> => {
    const parsed = episodeFactSchema.safeParse(fact);
    if (!parsed.success) {
      log.error("rejected invalid episode fact", { memberId: id, error: reason(parsed.error) });
      return;
    }
    await enqueue(id, () => appendJsonLine(episodeFile(id, roomId), parsed.data));
  };

  const episodes = async (id: string): Promise<Array<EpisodeFact & { roomId: string }>> => {
    let names: string[];
    try {
      names = await readdir(episodesDir(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const facts: Array<EpisodeFact & { roomId: string }> = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const roomId = name.slice(0, -".jsonl".length);
      const lines = await readJsonLines(
        join(episodesDir(id), name),
        parseEpisode,
        () => log.warn("skipping corrupt episode line", { memberId: id, roomId }),
      );
      for (const fact of lines) facts.push({ ...fact, roomId });
    }
    return facts.sort((a, b) => a.at.localeCompare(b.at));
  };

  const flush = async (): Promise<void> => {
    await Promise.all([...queues.values()]);
  };

  return {
    load,
    missingFile: () => missing,
    list,
    get,
    upsert,
    charter,
    writeCharter,
    lessons,
    lessonsFor,
    hasLesson,
    pending,
    hasPending,
    appendLesson,
    appendPending,
    acceptPending,
    rejectPending,
    appendEpisode,
    episodes,
    flush,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/member-store.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/member-store.ts agent-room/server/member-store.test.ts
git commit -m "feat(agent-room): add file-backed member store"
```

---

## Task 4: One-time member migration and seed

**Files:**
- Create: `agent-room/server/migrate-members.ts`
- Test: `agent-room/server/migrate-members.test.ts`

**Interfaces:**
- Consumes: `RoomStore.migratedFromV1()` (Task 2), `MemberStore` (Task 3), `RoomSettings`.
- Produces: `migrateMembers({ store, members, readSettings, now, log }): Promise<{ seeded: boolean }>`.

- [ ] **Step 1: Write the failing migration tests**

```ts
// agent-room/server/migrate-members.test.ts
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../shared/roles";
import { migrateMembers } from "./migrate-members";
import type { MemberStore } from "./member-store";
import type { RoomStore } from "./store";

function fakeMembers(exists = false) {
  const records: unknown[] = [];
  const store = {
    missingFile: () => !exists,
    list: () => records,
    get: (id: string) => records.find((record) => (record as { id: string }).id === id),
    upsert: vi.fn(async (record: unknown) => {
      records.push(record);
    }),
    flush: vi.fn(async () => undefined),
  } as unknown as MemberStore;
  return { store, records };
}

function fakeRooms(migrated: boolean, count = 1) {
  const store = {
    migratedFromV1: () => migrated,
    listRooms: () => Array.from({ length: count }, (_, i) => ({ id: `R${i}` })),
    flush: vi.fn(async () => undefined),
  } as unknown as RoomStore;
  return store;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("migrateMembers", () => {
  it("seeds a supervisor and a lead from the catalog", async () => {
    const members = fakeMembers(false);
    const store = fakeRooms(true, 3);

    const out = await migrateMembers({
      store,
      members: members.store,
      readSettings: async () => DEFAULT_SETTINGS,
      now: () => Date.parse("2026-11-02T10:00:00.000Z"),
      log,
    });

    expect(out.seeded).toBe(true);
    expect(members.records).toHaveLength(2);
    expect(members.records[0]).toMatchObject({
      id: "default-supervisor",
      name: "Supervisor",
      role: "supervisor",
      provider: "claude",
      model: "claude-opus-5-5",
      memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
    });
    expect(members.records[1]).toMatchObject({ id: "default-lead", role: "lead" });
    expect(log.info).toHaveBeenCalledWith("members migrated", { members: 2, rooms: 3 });
  });

  it("is a no-op when v2 rooms are already on disk", async () => {
    const members = fakeMembers(false);
    const out = await migrateMembers({
      store: fakeRooms(false),
      members: members.store,
      readSettings: async () => DEFAULT_SETTINGS,
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
  });

  it("leaves an existing members file alone", async () => {
    const members = fakeMembers(true);
    const out = await migrateMembers({
      store: fakeRooms(true),
      members: members.store,
      readSettings: async () => DEFAULT_SETTINGS,
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
  });

  it("does not seed from a catalog without a lead role", async () => {
    const members = fakeMembers(false);
    const out = await migrateMembers({
      store: fakeRooms(true),
      members: members.store,
      readSettings: async () => ({
        roles: DEFAULT_SETTINGS.roles.filter((role) => role.kind !== "lead"),
      }),
      now: () => 0,
      log,
    });
    expect(out.seeded).toBe(false);
    expect(members.records).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith("member migration skipped: catalog is missing a required role", {
      error: expect.any(String),
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/migrate-members.test.ts
```

Expected: FAIL with `Failed to resolve import "./migrate-members"`.

- [ ] **Step 3: Implement `server/migrate-members.ts`**

```ts
import { memberRecordSchema, type MemberRecord } from "../shared/member";
import type { Role, RoomSettings } from "../shared/roles";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";
import type { RoomStore } from "./store";

export interface MigrateMembersDeps {
  store: RoomStore;
  members: MemberStore;
  readSettings: () => Promise<RoomSettings>;
  now: () => number;
  log: Logger;
}

function seed(id: string, name: string, role: Role, at: string): MemberRecord {
  return memberRecordSchema.parse({
    id,
    name,
    role: role.kind === "supervisor" ? "supervisor" : "lead",
    provider: role.provider,
    model: role.model,
    ...(role.modeId !== undefined ? { modeId: role.modeId } : {}),
    ...(role.thinkingOptionId !== undefined ? { thinkingOptionId: role.thinkingOptionId } : {}),
    ...(role.features !== undefined ? { features: role.features } : {}),
    memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * Seed two members the first time a v1 `rooms.json` is migrated. A corrupt or
 * existing `members.json` is never overwritten: `missingFile()` is true only for
 * ENOENT, so corruption degrades to an empty member store, not a re-seed.
 */
export async function migrateMembers(deps: MigrateMembersDeps): Promise<{ seeded: boolean }> {
  if (!deps.members.missingFile() || !deps.store.migratedFromV1()) {
    return { seeded: false };
  }

  const settings = await deps.readSettings();
  const supervisor = settings.roles.find((role) => role.kind === "supervisor");
  const lead = settings.roles.find((role) => role.kind === "lead");
  if (supervisor === undefined || lead === undefined) {
    deps.log.warn("member migration skipped: catalog is missing a required role", {
      error: supervisor === undefined ? "no supervisor role" : "no lead role",
    });
    return { seeded: false };
  }

  const at = new Date(deps.now()).toISOString();
  const records: MemberRecord[] = [
    seed("default-supervisor", supervisor.name, supervisor, at),
    seed("default-lead", lead.name, lead, at),
  ];
  for (const record of records) await deps.members.upsert(record);
  await deps.members.flush();
  await deps.store.flush();

  deps.log.info("members migrated", {
    members: records.length,
    rooms: deps.store.listRooms().length,
  });
  return { seeded: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/migrate-members.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/migrate-members.ts agent-room/server/migrate-members.test.ts
git commit -m "feat(agent-room): seed default members on v1 room migration"
```

---

## Task 5: Repo and workspace scope resolution

**Files:**
- Create: `agent-room/server/scope.ts`
- Test: `agent-room/server/scope.test.ts`

**Interfaces:**
- Consumes: `normalizeWorkspacePath` from `shared/member.ts`.
- Produces:
  - `normalizeRemoteUrl(remote): string | null`
  - `repoIdFromText(text): string`
  - `createRepoResolver({ run?, log, timeoutMs? }): (cwd: string) => Promise<string | null>`
  - `candidateScope(cwd, repoId): string`

- [ ] **Step 1: Write the failing scope tests**

```ts
// agent-room/server/scope.test.ts
import { describe, expect, it, vi } from "vitest";

import { repoScope, workspaceScope } from "../shared/member";
import {
  candidateScope,
  createRepoResolver,
  normalizeRemoteUrl,
  repoIdFromText,
} from "./scope";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("repo identity", () => {
  it("normalizes ssh and https remotes to the same identity", () => {
    expect(normalizeRemoteUrl("git@github.com:Acme/App.git")).toBe("github.com/Acme/App");
    expect(normalizeRemoteUrl("https://github.com/Acme/App.git")).toBe("github.com/Acme/App");
    expect(normalizeRemoteUrl("ssh://git@github.com/Acme/App.git")).toBe("github.com/Acme/App");
  });

  it("hashes stably across clones of one repo", () => {
    expect(repoIdFromText("github.com/Acme/App")).toBe(repoIdFromText("github.com/Acme/App"));
    expect(repoIdFromText("github.com/Acme/App")).not.toBe(repoIdFromText("github.com/Acme/Other"));
    expect(repoIdFromText("github.com/Acme/App")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("createRepoResolver", () => {
  it("prefers the origin remote and memoizes per cwd", async () => {
    const run = vi.fn(async (args: readonly string[], cwd: string) => {
      if (args[0] === "remote") {
        return {
          code: 0,
          stdout: cwd.startsWith("/clone") ? "git@github.com:Acme/App.git\n" : "https://github.com/Acme/App.git\n",
        };
      }
      return { code: 1, stdout: "" };
    });
    const resolve = createRepoResolver({ run, log });

    const a = await resolve("/clone/one/");
    const b = await resolve("/other/two");
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(2);
    await resolve("/clone/one/");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("falls back to the repository root when there is no remote", async () => {
    const run = async (args: readonly string[]) =>
      args[0] === "rev-parse"
        ? { code: 0, stdout: "/work/app\n" }
        : { code: 1, stdout: "" };
    const resolve = createRepoResolver({ run, log });
    expect(await resolve("/work/app/sub")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns null outside a git repository instead of throwing", async () => {
    const run = vi.fn(async () => ({ code: 128, stdout: "" }));
    const resolve = createRepoResolver({ run, log });
    await expect(resolve("/not/a/repo")).resolves.toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("candidateScope", () => {
  it("uses the repo when one resolved, else the workspace", () => {
    expect(candidateScope("/a/b", "8f3c1a2b")).toBe(repoScope("8f3c1a2b"));
    expect(candidateScope("/a/b/", null)).toBe(workspaceScope("/a/b"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/scope.test.ts
```

Expected: FAIL with `Failed to resolve import "./scope"`.

- [ ] **Step 3: Implement `server/scope.ts`**

```ts
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeWorkspacePath, repoScope, workspaceScope } from "../shared/member";
import type { Logger } from "./logger";

const execFileAsync = promisify(execFile);

export interface ScopeRun {
  (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

export interface ScopeDeps {
  /** Test seam; production runs `git`. */
  run?: ScopeRun;
  log: Logger;
  timeoutMs?: number;
}

/**
 * Reduce a remote URL to `host/path`, or a local path to itself. Both clone
 * directories of one repository must hash the same, so the transport, the user
 * and the `.git` suffix are not identity.
 */
export function normalizeRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return null;

  const scp = /^[^\s@]+@([^:\s]+):(.+)$/.exec(trimmed);
  if (scp !== null) {
    const path = scp[2]!.replace(/\/+$/, "").replace(/\.git$/, "");
    return `${scp[1]!.toLowerCase()}/${path}`;
  }

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return `${url.hostname.toLowerCase()}${path.startsWith("/") ? path : `/${path}`}`;
  } catch {
    const path = trimmed.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/, "");
    return path.length > 0 ? path : null;
  }
}

export function repoIdFromText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** One asynchronous `git` lookup per normalized cwd, memoized in-process. */
export function createRepoResolver(deps: ScopeDeps): (cwd: string) => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? 1500;
  const cache = new Map<string, Promise<string | null>>();

  const run: ScopeRun =
    deps.run ??
    (async (args, cwd) => {
      try {
        const result = await execFileAsync("git", [...args], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
        });
        return { code: 0, stdout: result.stdout };
      } catch (error) {
        const code =
          typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : 1;
        return { code, stdout: "" };
      }
    });

  return (cwd: string): Promise<string | null> => {
    const key = normalizeWorkspacePath(cwd);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<string | null> => {
      const remote = await run(["remote", "get-url", "origin"], key);
      if (remote.code === 0 && remote.stdout.trim().length > 0) {
        const normalized = normalizeRemoteUrl(remote.stdout);
        if (normalized !== null) return repoIdFromText(normalized);
      }

      const root = await run(["rev-parse", "--show-toplevel"], key);
      if (root.code === 0 && root.stdout.trim().length > 0) {
        return repoIdFromText(normalizeWorkspacePath(root.stdout.trim()));
      }
      return null;
    })();

    cache.set(key, pending);
    return pending;
  };
}

/** The room's one lesson scope: repository identity first, workspace second. */
export function candidateScope(cwd: string, repoId: string | null): string {
  return repoId !== null ? repoScope(repoId) : workspaceScope(cwd);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/scope.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/scope.ts agent-room/server/scope.test.ts
git commit -m "feat(agent-room): resolve repo and workspace memory scopes"
```

---

## Task 6: Member index and `## Member` prompt section

**Files:**
- Create: `agent-room/server/member-index.ts`
- Modify: `agent-room/server/render.ts`
- Test: `agent-room/server/member-index.test.ts` (new)
- Test: `agent-room/server/render.test.ts`

**Interfaces:**
- Consumes: `MemberRecord`, `Lesson`, `CHARTER_PROMPT_CAP`, `MEMBER_SECTION_CAP`, `LESSON_PROMPT_CAP`, `LESSON_TEXT_CAP` from `shared/member.ts`.
- Produces:
  - `indexMembers(members: readonly MemberRecord[]): MemberIndex` with `all()`, `byId(id)`, `forSeat(kind, provider, model)`
  - `renderMemberSection({ name, charter, lessons }): { text: string; truncated: boolean }`
  - `renderSystemPrompt(role, settings, existing?, context?: { member?: MemberRender; leadMember?: SeatConfig })`

- [ ] **Step 1: Write the failing member-index tests**

```ts
// agent-room/server/member-index.test.ts
import { describe, expect, it } from "vitest";

import { memberRecordSchema } from "../shared/member";
import { indexMembers } from "./member-index";

const member = (id: string, role: "supervisor" | "lead", provider = "claude", model = "claude-opus-5-5") =>
  memberRecordSchema.parse({
    id,
    name: id,
    role,
    provider,
    model,
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  });

describe("indexMembers", () => {
  it("looks members up by id and by seat", () => {
    const index = indexMembers([member("sup", "supervisor"), member("lead", "lead")]);
    expect(index.byId("lead")?.id).toBe("lead");
    expect(index.forSeat("lead", "claude", "claude-opus-5-5")?.id).toBe("lead");
    expect(index.forSeat("supervisor", "claude", "claude-opus-5-5")?.id).toBe("sup");
    expect(index.forSeat("worker", "claude", "claude-opus-5-5")).toBeUndefined();
  });

  it("returns undefined for a seat no member matches", () => {
    const index = indexMembers([member("lead", "lead")]);
    expect(index.forSeat("lead", "codex", "gpt-5.6-sol")).toBeUndefined();
    expect(index.byId("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the failing render tests**

Add to `agent-room/server/render.test.ts`:

```ts
import { renderMemberSection } from "./render";

describe("renderMemberSection", () => {
  it("renders name, charter and dated lessons", () => {
    const section = renderMemberSection({
      name: "Lead",
      charter: "Use pnpm.",
      lessons: [
        {
          at: "2026-11-02T10:00:00.000Z",
          scope: "repo:8f3c1a2b",
          text: "use pnpm",
          sourceRoomId: "R1",
          promotedBy: "human",
        },
      ],
    });
    expect(section.truncated).toBe(false);
    expect(section.text).toContain("## Member");
    expect(section.text).toContain("Name: Lead.");
    expect(section.text).toContain("Use pnpm.");
    expect(section.text).toContain("[repo:8f3c1a2b] use pnpm");
  });

  it("puts the member section after the role brief and before the role table", () => {
    const member = renderMemberSection({ name: "Lead", charter: "x", lessons: [] });
    const p = renderSystemPrompt(lead, DEFAULT_SETTINGS, "BASE", { member });
    expect(p.startsWith("BASE\n\n")).toBe(true);
    expect(p.indexOf(PROMPTS.lead)).toBeLessThan(p.indexOf("## Member"));
    expect(p.indexOf("## Member")).toBeLessThan(p.indexOf("## Room roles"));
  });

  it("keeps the newest 12 lessons and flags the drop", () => {
    const lessons = Array.from({ length: 15 }, (_, i) => ({
      at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      scope: "global",
      text: `lesson ${i}`,
      sourceRoomId: "R1",
      promotedBy: "auto" as const,
    }));
    const section = renderMemberSection({ name: "Lead", charter: "", lessons });
    expect(section.truncated).toBe(true);
    expect(section.text).toContain("lesson 14");
    expect(section.text).not.toContain("lesson 0");
    expect(section.text.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(12);
  });

  it("truncates an oversized charter deterministically", () => {
    const section = renderMemberSection({
      name: "Lead",
      charter: "x".repeat(CHARTER_PROMPT_CAP + 100),
      lessons: [],
    });
    expect(section.truncated).toBe(true);
    expect(section.text).toContain("[charter truncated]");
    expect(section.text.length).toBeLessThanOrEqual(MEMBER_SECTION_CAP + 32);
  });

  it("shows the bound lead member's seat in the supervisor table", () => {
    const table = renderRoleTable(supervisor, DEFAULT_SETTINGS, {
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    expect(table).toContain("codex/gpt-5.6-sol");
    expect(table).not.toContain("claude/claude-opus-5-5");
  });
});
```

Add imports for `CHARTER_PROMPT_CAP`/`MEMBER_SECTION_CAP` at the top of the test file.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/member-index.test.ts server/render.test.ts
```

Expected: FAIL with missing modules/functions.

- [ ] **Step 4: Implement `server/member-index.ts`**

```ts
import type { MemberRecord, MemberRole } from "../shared/member";

export interface MemberIndex {
  all(): MemberRecord[];
  byId(id: string | null | undefined): MemberRecord | undefined;
  /**
   * The member whose seat the request already names. The pre-create hook has no
   * room id, so this is how a Lead member's seat is recognized (ruling R1).
   */
  forSeat(role: MemberRole, provider: string, model: string): MemberRecord | undefined;
}

const EMPTY: MemberIndex = {
  all: () => [],
  byId: () => undefined,
  forSeat: () => undefined,
};

export function indexMembers(members: readonly MemberRecord[]): MemberIndex {
  const byId = new Map(members.map((member) => [member.id, member]));
  return {
    all: () => [...members],
    byId: (id) => (id === null || id === undefined ? undefined : byId.get(id)),
    forSeat: (role, provider, model) =>
      members.find(
        (member) =>
          member.role === role && member.provider === provider && member.model === model,
      ),
  };
}

/** A lookup that finds nothing, used where members are not available (tests, workers). */
export const EMPTY_MEMBER_INDEX: MemberIndex = EMPTY;
```

- [ ] **Step 5: Implement the member section and prompt ordering**

In `agent-room/server/render.ts`, add:

```ts
import {
  CHARTER_PROMPT_CAP,
  LESSON_PROMPT_CAP,
  LESSON_TEXT_CAP,
  MEMBER_SECTION_CAP,
  type Lesson,
} from "../shared/member";

export interface MemberPrompt {
  name: string;
  charter: string;
  lessons: readonly Lesson[];
}

export interface MemberRender {
  text: string;
  truncated: boolean;
}

export interface PromptContext {
  member?: MemberRender;
  /** The room's bound Lead member, shown in a Supervisor's role table. */
  leadMember?: { provider: string; model: string };
}

/**
 * Deterministic, count-and-order truncation only: the same member and room must
 * always render the same prompt. Never model-judged.
 */
export function renderMemberSection(member: MemberPrompt): MemberRender {
  let truncated = false;

  const charter = member.charter.trim();
  let charterText = charter;
  if (charterText.length > CHARTER_PROMPT_CAP) {
    charterText = `${charterText.slice(0, CHARTER_PROMPT_CAP).trimEnd()}\n[charter truncated]`;
    truncated = true;
  }

  const newest = [...member.lessons].sort((a, b) => b.at.localeCompare(a.at));
  const selected = newest.slice(0, LESSON_PROMPT_CAP);
  if (selected.length < newest.length) truncated = true;

  const lessonLines = selected.map(
    (lesson) =>
      `- [${lesson.at}] [${lesson.scope}] ${lesson.text.slice(0, LESSON_TEXT_CAP)}`,
  );

  const parts = ["## Member", `Name: ${member.name}.`];
  if (charterText.length > 0) parts.push("### Charter", charterText);
  if (lessonLines.length > 0) parts.push("### Lessons", ...lessonLines);

  let text = parts.join("\n");
  if (text.length > MEMBER_SECTION_CAP) {
    text = `${text.slice(0, MEMBER_SECTION_CAP).trimEnd()}\n[member section truncated]`;
    truncated = true;
  }
  return { text, truncated };
}
```

Change `providerModel` and `renderRoleTable`:

```ts
function providerModel(seat: { provider: string; model: string }): string {
  return code(`${seat.provider}/${seat.model}`);
}

export function renderRoleTable(
  role: Role,
  settings: RoomSettings,
  leadMember?: { provider: string; model: string },
): string {
  if (role.kind === "supervisor") {
    const leads = settings.roles.filter((candidate) => candidate.kind === "lead");
    return [
      ROLE_TABLE_HEADING,
      "",
      `You create Lead agents, and nothing else. A child is titled \`${leads[0]?.name ?? "Lead"}: <workstream>\`.`,
      ...(leadMember !== undefined
        ? [
            "",
            "The room's Lead member runs the first Lead row below. Pass its provider exactly as shown; the plugin applies its mode and thinking level.",
          ]
        : []),
      "",
      "| Role you create | Title | Provider / model |",
      "|---|---|---|",
      ...leads.map(
        (lead, index) =>
          `| ${lead.name} | ${code(`${lead.name}: <workstream>`)} | ${providerModel(
            index === 0 && leadMember !== undefined ? leadMember : lead,
          )} |`,
      ),
      "",
      "Never launch a worker role directly, and never launch an agent whose title carries no role: a child of a room seat with no role is archived by the room guard.",
    ].join("\n");
  }
  // ...lead and worker branches unchanged...
}
```

Change `renderSystemPrompt`:

```ts
export function renderSystemPrompt(
  role: Role,
  settings: RoomSettings,
  existing?: string,
  context: PromptContext = {},
): string {
  const parts = [
    existing ?? "",
    PROMPTS.protocol,
    KIND_PROMPTS[role.kind],
    role.brief ?? "",
    context.member?.text ?? "",
    renderRoleTable(role, settings, context.leadMember),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/member-index.test.ts server/render.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent-room/server/member-index.ts agent-room/server/member-index.test.ts \
        agent-room/server/render.ts agent-room/server/render.test.ts
git commit -m "feat(agent-room): render the member prompt section"
```

---

## Task 7: Member-aware seat resolution

**Files:**
- Modify: `agent-room/server/inject.ts`
- Test: `agent-room/server/inject.test.ts`

**Interfaces:**
- Consumes: `MemberIndex` (Task 6), `renderMemberSection` / `PromptContext` (Task 6).
- Produces:
  - `applySeat(request, settings, members?, memberPrompt?): SeatApplication | null`
  - `SeatApplication.member?: MemberRecord`, `SeatApplication.memberTruncated?: boolean`
  - `carriesRoomPrompt(systemPrompt): boolean` exported
  - `MemberPromptSource = (member: MemberRecord) => MemberRender | null`

- [ ] **Step 1: Write the failing inject tests**

Add to `agent-room/server/inject.test.ts`:

```ts
import { memberRecordSchema } from "../shared/member";
import { indexMembers } from "./member-index";
import { renderMemberSection } from "./render";

const member = (over: Partial<Parameters<typeof memberRecordSchema.parse>[0]> = {}) =>
  memberRecordSchema.parse({
    id: "lead-1",
    name: "Lead",
    role: "lead",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "bypassPermissions",
    thinkingOptionId: "medium",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  });

const promptFor = () => renderMemberSection({ name: "Lead", charter: "Use pnpm.", lessons: [] });

describe("applySeat with members", () => {
  it("lets a matching member override the role seat", () => {
    const members = indexMembers([member()]);
    const r = applySeat(
      base("Lead: x", { provider: "claude", model: "claude-opus-5-5" }),
      DEFAULT_SETTINGS,
      members,
      promptFor,
    )!;

    expect(r.member?.id).toBe("lead-1");
    expect(r.request.config).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
    });
    expect(r.request.config.systemPrompt).toContain("## Member");
    expect(r.request.config.systemPrompt).toContain("Use pnpm.");
    expect(r.memberTruncated).toBe(false);
  });

  it("falls back to the role seat when no member matches the request seat", () => {
    const members = indexMembers([member()]);
    const r = applySeat(base("Lead: x"), DEFAULT_SETTINGS, members, promptFor)!;
    // base() asks for opencode/m, which is not the member's seat.
    expect(r.member).toBeUndefined();
    expect(r.request.config.provider).toBe("claude");
    expect(r.request.config.model).toBe("claude-opus-5-5");
    expect(r.request.config.systemPrompt).not.toContain("## Member");
  });

  it("never looks up a worker member", () => {
    const members = indexMembers([member()]);
    const r = applySeat(
      base("Reviewer: audit", { provider: "claude", model: "claude-opus-5-5" }),
      DEFAULT_SETTINGS,
      members,
      promptFor,
    )!;
    expect(r.member).toBeUndefined();
    expect(r.role.kind).toBe("worker");
  });

  it("drops member controls the member leaves unset", () => {
    const bare = member({
      id: "lead-2",
      modeId: undefined,
      thinkingOptionId: undefined,
      features: undefined,
    });
    const r = applySeat(
      base("Lead: x", {
        provider: "claude",
        model: "claude-opus-5-5",
        modeId: "plan",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
      DEFAULT_SETTINGS,
      indexMembers([bare]),
      promptFor,
    )!;
    expect(r.request.config.modeId).toBeUndefined();
    expect(r.request.config.thinkingOptionId).toBeUndefined();
    expect(r.request.config.featureValues).toBeUndefined();
  });

  it("leaves an already-prompted launch request and its seat alone", () => {
    const supervisor = roleByName("Supervisor", DEFAULT_SETTINGS.roles)!;
    const launched = renderSystemPrompt(supervisor, DEFAULT_SETTINGS);
    const r = applySeat(
      base("Supervisor: plan", {
        provider: "codex",
        model: "gpt-5.6-sol",
        systemPrompt: launched,
      }),
      DEFAULT_SETTINGS,
    )!;

    // room.launch built this seat from the selected member; the hook must not
    // re-seat it from the role catalog.
    expect(r.request.config.provider).toBe("codex");
    expect(r.request.config.model).toBe("gpt-5.6-sol");
    expect(r.request.config.systemPrompt).toBe(launched);
  });
});
```

Update the existing test `does not append the room prompt twice when the protocol is already there` to the new behavior above (rename it), and keep the idempotency test.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/inject.test.ts
```

Expected: FAIL; `applySeat` accepts only two arguments and never renders a member section.

- [ ] **Step 3: Implement the changes in `server/inject.ts`**

```ts
import type { MemberRecord } from "../shared/member";
import { EMPTY_MEMBER_INDEX, type MemberIndex } from "./member-index";
import {
  renderMemberSection,
  renderSystemPrompt,
  type MemberRender,
} from "./render";

export type MemberPromptSource = (member: MemberRecord) => MemberRender | null;

export type SeatApplication = {
  request: AgentCreateRequest;
  role: Role;
  fallbackFrom?: string;
  /** The member whose seat was applied, when the request named one. */
  member?: MemberRecord;
  /** True when the member section had to drop charter or lesson content. */
  memberTruncated?: boolean;
};

export function carriesRoomPrompt(systemPrompt: string | undefined): boolean {
  return systemPrompt !== undefined && systemPrompt.includes(PROMPTS.protocol);
}

export function applySeat(
  request: AgentCreateRequest,
  settings: RoomSettings,
  members: MemberIndex = EMPTY_MEMBER_INDEX,
  memberPrompt: MemberPromptSource = () => null,
): SeatApplication | null {
  const resolved = resolveRole(request.config.title, settings);
  if (resolved === null) return null;
  const role = resolved.role;

  // `room.launch` and `room.adopt` already built the seat and the prompt,
  // including any member. Re-applying the role here would undo the member.
  if (carriesRoomPrompt(request.config.systemPrompt)) {
    const untouched: SeatApplication = { request, role };
    if (resolved.fallbackFrom !== undefined) untouched.fallbackFrom = resolved.fallbackFrom;
    return untouched;
  }

  const member =
    role.kind === "worker"
      ? undefined
      : members.forSeat(role.kind, request.config.provider, request.config.model);
  const seat = member ?? role;

  const config: AgentCreateRequest["config"] = { ...request.config };
  delete config.modeId;
  delete config.thinkingOptionId;
  delete config.featureValues;
  if (request.config.provider !== seat.provider) delete config.providerOptions;

  config.provider = seat.provider;
  config.model = seat.model;
  applyControls(config, seat);

  const rendered = member === undefined ? null : memberPrompt(member);
  const leadMember =
    role.kind === "supervisor"
      ? members.all().find((candidate) => candidate.role === "lead")
      : undefined;

  config.systemPrompt = renderSystemPrompt(role, settings, config.systemPrompt, {
    ...(rendered !== null ? { member: rendered } : {}),
    ...(leadMember !== undefined
      ? { leadMember: { provider: leadMember.provider, model: leadMember.model } }
      : {}),
  });

  const applied: SeatApplication = { request: { ...request, config }, role };
  if (resolved.fallbackFrom !== undefined) applied.fallbackFrom = resolved.fallbackFrom;
  if (member !== undefined) applied.member = member;
  if (rendered !== null) applied.memberTruncated = rendered.truncated;
  return applied;
}

function applyControls(
  config: AgentCreateRequest["config"],
  seat: { modeId?: string; thinkingOptionId?: string; features?: Record<string, unknown> },
): void {
  if (seat.modeId !== undefined) config.modeId = seat.modeId;
  if (seat.thinkingOptionId !== undefined) config.thinkingOptionId = seat.thinkingOptionId;
  if (seat.features !== undefined) config.featureValues = seat.features;
}
```

Replace `applyRoleControls` with `applyControls`; keep `resolveRole` as is. The `Role` type is assignable to the seat parameter because it has the same fields.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/inject.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/inject.ts agent-room/server/inject.test.ts
git commit -m "feat(agent-room): let a bound member supply the seat"
```

---

## Task 8: Launch binding and the launch RPC contract

**Files:**
- Modify: `agent-room/shared/rpc.ts`
- Modify: `agent-room/server/handlers.ts`
- Test: `agent-room/server/handlers.test.ts`

**Interfaces:**
- Consumes: `MemberStore` (Task 3), `MemberIndex` (Task 6), `renderMemberSection` (Task 6), repo resolver (Task 5).
- Produces:
  - `launchRoomRpc.input` gains optional `supervisorMemberId`, `leadMemberId`.
  - `HandlerDeps.members: MemberStore`, `HandlerDeps.repoIdFor: (cwd: string) => Promise<string | null>`.
  - `launch` applies the selected member's seat and prompt, then calls `store.bindRoomMembers`.

- [ ] **Step 1: Write the failing handler tests**

Add to `agent-room/server/handlers.test.ts`:

```ts
import { memberRecordSchema } from "../shared/member";
import type { MemberStore } from "./member-store";

const member = (over: Record<string, unknown> = {}) =>
  memberRecordSchema.parse({
    id: "sup-1",
    name: "Supervisor",
    role: "supervisor",
    provider: "codex",
    model: "gpt-5.6-sol",
    modeId: "full-access",
    thinkingOptionId: "medium",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    ...over,
  });

function fakeMembers(records = [member()]) {
  return {
    list: () => records,
    get: (id: string) => records.find((record) => record.id === id),
    charter: () => "Use pnpm.",
    lessonsFor: () => [],
    pending: () => [],
  } as unknown as MemberStore;
}

it("launches the Supervisor on the selected member's seat and renders its memory", async () => {
  const { paseo, created } = fakePaseo();
  const fake = fakeStore();
  const handlers = createHandlers({
    store: fake.store,
    readSettings: async () => DEFAULT_SETTINGS,
    members: fakeMembers(),
    repoIdFor: async () => null,
  });

  const out = await handlers.launch(
    { task: "Fix the room", cwd: "/repo", supervisorMemberId: "sup-1" },
    paseo,
  );

  expect(out).toEqual({ roomId: "A1" });
  expect(created[0]?.options.config).toMatchObject({
    provider: "codex/gpt-5.6-sol",
    modeId: "full-access",
    thinkingOptionId: "medium",
  });
  expect(created[0]?.options.config.systemPrompt).toContain("## Member");
  expect(created[0]?.options.config.systemPrompt).toContain("Use pnpm.");
  expect(fake.bindRoomMembers).toHaveBeenCalledWith("A1", {
    supervisorMemberId: "sup-1",
    leadMemberId: null,
  });
});

it("shows the bound Lead member's seat in the Supervisor's role table", async () => {
  const lead = member({ id: "lead-1", name: "Lead", role: "lead", model: "claude-opus-5-5", modeId: undefined, thinkingOptionId: undefined });
  const { paseo, created } = fakePaseo();
  const handlers = createHandlers({
    store: fakeStore().store,
    readSettings: async () => DEFAULT_SETTINGS,
    members: fakeMembers([member(), lead]),
    repoIdFor: async () => null,
  });

  await handlers.launch(
    { task: "Fix the room", cwd: "/repo", supervisorMemberId: "sup-1", leadMemberId: "lead-1" },
    paseo,
  );

  expect(created[0]?.options.config.systemPrompt).toContain("codex/gpt-5.6-sol");
  expect(created[0]?.options.config.systemPrompt).toContain("claude/claude-opus-5-5");
});

it("refuses a member whose role does not match the slot", async () => {
  const { paseo, created } = fakePaseo();
  const handlers = createHandlers({
    store: fakeStore().store,
    readSettings: async () => DEFAULT_SETTINGS,
    members: fakeMembers([member({ role: "lead" })]),
    repoIdFor: async () => null,
  });

  await expect(
    handlers.launch({ task: "Fix", cwd: "/repo", supervisorMemberId: "sup-1" }, paseo),
  ).rejects.toThrow(/not a supervisor member/);
  expect(created).toHaveLength(0);
});

it("refuses an unknown member id before creating anything", async () => {
  const { paseo, created } = fakePaseo();
  const handlers = createHandlers({
    store: fakeStore().store,
    readSettings: async () => DEFAULT_SETTINGS,
    members: fakeMembers(),
    repoIdFor: async () => null,
  });

  await expect(
    handlers.launch({ task: "Fix", cwd: "/repo", leadMemberId: "nope" }, paseo),
  ).rejects.toThrow(/member not found/);
  expect(created).toHaveLength(0);
});
```

Update `handlersFor` to pass default `members` and `repoIdFor`. Add `bindRoomMembers` to `fakeStore`:

```ts
const bindRoomMembers = vi.fn();
return {
  store: { listRooms, room, seat, addRoom, addSeat, appendFeed, flush, bindRoomMembers } as unknown as RoomStore,
  ...
  bindRoomMembers,
};
```

Add a contract test:

```ts
it("accepts optional member ids on launch", () => {
  expect(
    launchRoomRpc.input.safeParse({
      task: "Fix",
      cwd: "/repo",
      supervisorMemberId: "sup-1",
      leadMemberId: "lead-1",
    }).success,
  ).toBe(true);
  expect(launchRoomRpc.input.safeParse({ task: "Fix", cwd: "/repo", supervisorMemberId: "" }).success).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/handlers.test.ts
```

Expected: FAIL; the handler has no `members` dep and the RPC rejects the new fields.

- [ ] **Step 3: Extend the RPC contract**

In `agent-room/shared/rpc.ts`:

```ts
export const launchRoomRpc = defineRpc({
  name: "room.launch",
  input: z
    .object({
      task: z.string().min(1),
      workspaceId: nonEmptyText.optional(),
      cwd: nonEmptyText.optional(),
      // Omitted means "use the host seat", so existing callers keep working.
      supervisorMemberId: nonEmptyText.optional(),
      leadMemberId: nonEmptyText.optional(),
    })
    .refine((input) => input.workspaceId !== undefined || input.cwd !== undefined, {
      message: "one of workspaceId or cwd is required",
      path: ["workspaceId"],
    }),
  output: z.object({ roomId: nonEmptyText }),
});
```

- [ ] **Step 4: Implement the handler changes**

In `agent-room/server/handlers.ts`:

```ts
import { type MemberRecord, type MemberRole } from "../shared/member";
import type { MemberStore } from "./member-store";
import { renderMemberSection, renderSystemPrompt } from "./render";

export interface HandlerDeps {
  store: RoomStore;
  readSettings: () => Promise<RoomSettings>;
  members: MemberStore;
  repoIdFor: (cwd: string) => Promise<string | null>;
}

function seatConfig(source: { provider: string; model: string; modeId?: string; thinkingOptionId?: string; features?: Record<string, unknown> }): PaseoAgentConfig {
  const config: PaseoAgentConfig = { provider: `${source.provider}/${source.model}` };
  if (source.modeId !== undefined) config.modeId = source.modeId;
  if (source.thinkingOptionId !== undefined) config.thinkingOptionId = source.thinkingOptionId;
  if (source.features !== undefined) config.featureValues = source.features;
  return config;
}

function memberFor(deps: HandlerDeps, id: string | undefined, role: MemberRole): MemberRecord | null {
  if (id === undefined) return null;
  const member = deps.members.get(id);
  if (member === undefined) throw new Error(`room.launch: member not found: ${id}`);
  if (member.role !== role) throw new Error(`room.launch: ${id} is not a ${role} member`);
  return member;
}

async function directoryFor(
  input: RpcInput<typeof launchRoomRpc>,
  paseo: PaseoApi,
): Promise<string | null> {
  if (input.cwd !== undefined) return input.cwd;
  if (input.workspaceId === undefined) return null;
  const result = await paseo.workspaces.list({});
  const entry = result.entries.find((workspace) => workspace.id === input.workspaceId);
  return entry?.workspaceDirectory ?? entry?.projectRootPath ?? null;
}
```

Inside `launch`:

```ts
    async launch(input, paseo) {
      const settings = await deps.readSettings();
      const role = supervisorRole(settings);
      const supervisorMember = memberFor(deps, input.supervisorMemberId, "supervisor");
      const leadMember = memberFor(deps, input.leadMemberId, "lead");

      const cwd = await directoryFor(input, paseo);
      const repoId = cwd === null ? null : await deps.repoIdFor(cwd);
      const memberSection =
        supervisorMember === null || cwd === null
          ? null
          : renderMemberSection({
              name: supervisorMember.name,
              charter: deps.members.charter(supervisorMember.id),
              lessons: deps.members.lessonsFor(supervisorMember.id, [
                "global",
                ...(repoId !== null ? [`repo:${repoId}`] : []),
                `workspace:${cwd.replace(/\/+$/, "")}`,
              ]),
            });

      const config = seatConfig(supervisorMember ?? role);
      config.systemPrompt = renderSystemPrompt(role, settings, undefined, {
        ...(memberSection !== null ? { member: memberSection } : {}),
        ...(leadMember !== null
          ? { leadMember: { provider: leadMember.provider, model: leadMember.model } }
          : {}),
      });
      // ...existing options and create branches...
      const options: PaseoWorkspaceAgentCreateOptions = {
        config,
        title: seatTitleForRole(role, input.task),
        prompt: input.task,
      };
      // ...create...
      const roomId = handle.id;
      store.bindRoomMembers(roomId, {
        supervisorMemberId: supervisorMember?.id ?? null,
        leadMemberId: leadMember?.id ?? null,
      });
      if (memberSection?.truncated === true) {
        store.appendFeed({
          roomId,
          kind: "note",
          from: null,
          to: roomId,
          label: "member note",
          text: "member section truncated",
        });
      }
      return { roomId };
```

Use `workspaceScope(cwd)` from `shared/member.ts` instead of the inline string; import it. Also replace `roleConfig(role)` with `seatConfig`.

The `adopt` path keeps `renderSystemPrompt(role, settings)` and its `store.addRoom` gains the two null fields (Task 2).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/handlers.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-room/shared/rpc.ts agent-room/server/handlers.ts agent-room/server/handlers.test.ts
git commit -m "feat(agent-room): bind members at room launch"
```

---

## Task 9: The stale-memory rule in the room protocol

**Files:**
- Modify: `agent-room/server/prompts/protocol.md`
- Regenerate: `agent-room/server/prompts/generated.ts`
- Test: `agent-room/server/prompts/prompts.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: the protocol line every seat reads: member memory is a hint, not authority.

- [ ] **Step 1: Write the failing prompt test**

Add to `agent-room/server/prompts/prompts.test.ts`:

```ts
it("tells every seat that member memory may be stale", () => {
  expect(PROMPTS.protocol).toMatch(/member memory may be stale/i);
  expect(PROMPTS.protocol).toMatch(/verify .*repository/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd agent-room && npx vitest run server/prompts/prompts.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Edit the protocol source**

In `agent-room/server/prompts/protocol.md`, after the "## Channels in Paseo" section, add:

```md
## Member memory

A member's charter and lessons come from earlier rooms. They are hints, not
authority. Member memory may be stale: verify it against the repository and
the current state before relying on it, and say so when it was wrong.
```

Also update the paragraph in "## Channels in Paseo" that lists prompt
delivery, so it names the member section in order:

```md
- Every seat gets this protocol, its kind prompt, its role brief, its member
  section when the member has one, and a role table as a system prompt from
  the room plugin. Briefs restate the outcome and its boundaries; they do not
  restate this protocol.
```

- [ ] **Step 4: Regenerate the prompts**

```bash
cd agent-room && npm run gen:prompts
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/prompts/prompts.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-room/server/prompts/protocol.md agent-room/server/prompts/generated.ts \
        agent-room/server/prompts/prompts.test.ts
git commit -m "docs(agent-room): tell seats that member memory may be stale"
```

---

## Task 10: Wire the member store into the plugin and record member notes on create

**Files:**
- Modify: `agent-room/index.server.ts`
- Modify: `agent-room/server/events.ts`
- Test: `agent-room/server/events.test.ts`
- Test: `agent-room/index.server.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:
  - `index.server.ts` loads rooms, members, then runs `migrateMembers`.
  - The `agent.create` hook builds a `MemberIndex` and a repo id per create.
  - `createRoomEvents` receives `members` and `repoIdFor`; `onCreated` appends a `member note` feed row when the member section truncated.

- [ ] **Step 1: Write the failing events test**

Add to `agent-room/server/events.test.ts`:

```ts
it("records the launch's member bindings on the room", async () => {
  const { store, addRoom } = fakeStore();
  const { paseo } = fakePaseo();
  const { created, ctx } = eventsWith(paseo, store);

  await created.onCreated({ agent: agent({ id: "S1", title: "Supervisor: fix auth" }) }, ctx);

  // agent.created cannot know the launch input; it writes nulls and relies on
  // RoomStore.bindRoomMembers merging the launch's pending binding.
  expect(addRoom).toHaveBeenCalledWith(
    expect.objectContaining({ id: "S1", supervisorMemberId: null, leadMemberId: null }),
  );
});

it("appends a member note when the supervisor section truncated", async () => {
  const { store, addRoom, appendFeed } = fakeStore();
  addRoom.mockImplementation((room: RoomRecord) => {
    room.supervisorMemberId = "sup-1";
  });
  const { paseo } = fakePaseo();
  const { created, ctx } = eventsWith(paseo, store, undefined, {
    members: fakeMembers({ "sup-1": member() }),
    repoIdFor: async () => null,
  });

  await created.onCreated({ agent: agent({ id: "S1", title: "Supervisor: fix auth" }) }, ctx);

  expect(appendFeed).toHaveBeenCalledWith(
    expect.objectContaining({ label: "member note", text: "member section truncated" }),
  );
});
```

`eventsWith` gains optional deps overrides. `fakeStore.addRoom` must be a `vi.fn` whose mock implementation can mutate. `fakeMembers` helper in the events test implements `get`, `charter`, `lessonsFor`, `appendEpisode`, `episodes`, `pending`, `hasLesson`, `hasPending`, `appendLesson`, `appendPending`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/events.test.ts
```

Expected: FAIL; `createRoomEvents` does not accept `members` / `repoIdFor` and does not append the note.

- [ ] **Step 3: Implement the events changes**

In `agent-room/server/events.ts`:

```ts
import { renderMemberSection } from "./render";
import type { MemberStore } from "./member-store";

export interface RoomEventsDeps {
  store: RoomStore;
  readSettings: () => Promise<RoomSettings>;
  lookupTitle: TitleLookup;
  log: Logger;
  members: MemberStore;
  repoIdFor: (cwd: string) => Promise<string | null>;
}
```

`handleCreated` (Supervisor branch):

```ts
      store.addRoom({
        id: roomId,
        task,
        cwd: agent.cwd,
        workspaceId: agent.workspaceId,
        supervisorMemberId: null,
        leadMemberId: null,
        createdAt: new Date().toISOString(),
      });
      store.addSeat(seatRecord(agent, roomId, role, legacy));
      await noteMemberTruncation(roomId, role, agent.cwd);
      return;
```

After a Lead seat is added, also call `await noteMemberTruncation(roomId, role, agent.cwd);`.

Helper inside `createRoomEvents`:

```ts
  const noteMemberTruncation = async (
    roomId: string,
    role: Role,
    cwd: string,
  ): Promise<void> => {
    if (role.kind !== "supervisor" && role.kind !== "lead") return;
    const found = store.room(roomId);
    if (found === undefined) return;
    const memberId =
      role.kind === "supervisor" ? found.room.supervisorMemberId : found.room.leadMemberId;
    if (memberId === null) return;
    const member = deps.members.get(memberId);
    if (member === undefined) return;

    const repoId = await deps.repoIdFor(cwd);
    const section = renderMemberSection({
      name: member.name,
      charter: deps.members.charter(member.id),
      lessons: deps.members.lessonsFor(member.id, scopesFor(cwd, repoId)),
    });
    if (!section.truncated) return;
    store.appendFeed({
      roomId,
      kind: "note",
      from: null,
      to: memberId,
      label: "member note",
      text: "member section truncated",
    });
  };
```

Add a shared helper in `server/scope.ts`:

```ts
/** The scopes a room loads: global, its repo, and its exact workspace. */
export function scopesFor(cwd: string, repoId: string | null): string[] {
  return [
    "global",
    ...(repoId !== null ? [repoScope(repoId)] : []),
    workspaceScope(cwd),
  ];
}
```

Use it in `handlers.ts` and `index.server.ts` too.

- [ ] **Step 4: Wire `index.server.ts`**

```ts
import { createMemberStore } from "./server/member-store";
import { migrateMembers } from "./server/migrate-members";
import { indexMembers } from "./server/member-index";
import { createRepoResolver, scopesFor } from "./server/scope";
import { renderMemberSection } from "./server/render";
```

After the room store:

```ts
  const members = createMemberStore({
    dir: dataDir,
    now: () => Date.now(),
    newId: () => randomUUID(),
    log,
  });
  const repoIdFor = createRepoResolver({ log });
```

Replace the load promise:

```ts
  const loaded = (async () => {
    await store.load();
    await members.load();
    await migrateMembers({ store, members, readSettings, now: () => Date.now(), log });
  })().catch((error: unknown) => {
    log.error("room and member stores load failed", { error: reason(error) });
  });
```

Note: `readSettings` is defined above `loaded` and is the lenient reader.

Events and handlers:

```ts
  const events = createRoomEvents({
    store,
    readSettings,
    lookupTitle,
    log,
    members,
    repoIdFor,
  });
  const handlers = createHandlers({
    store,
    readSettings: launchSettings,
    members,
    repoIdFor,
  });
```

The create hook:

```ts
  server.before("agent.create", async ({ request }) => {
    const title = request.config.title;
    if (title === null || title === undefined) return;
    if (!title.includes(":") && !title.trimStart().startsWith("[")) return;
    try {
      const settings = await readSettings();
      const known =
        parseRoleTitle(title, settings.roles) !== null || parseSeatMarker(title) !== null;
      if (!known) return;
      if (carriesRoomPrompt(request.config.systemPrompt)) return;

      const index = indexMembers(members.list());
      const repoId = await repoIdFor(request.config.cwd);
      const scopes = scopesFor(request.config.cwd, repoId);
      const applied = applySeat(request, settings, index, (member) =>
        renderMemberSection({
          name: member.name,
          charter: members.charter(member.id),
          lessons: members.lessonsFor(member.id, scopes),
        }),
      );
      if (!applied) return;
      if (applied.memberTruncated === true) {
        log.warn("member section truncated", {
          memberId: applied.member?.id,
          role: applied.role.id,
        });
      }
      if (applied.fallbackFrom !== undefined) {
        log.warn("unknown legacy peer tier", {
          tier: applied.fallbackFrom,
          role: applied.role.id,
        });
      }
      return applied.request;
    } catch (error) {
      log.error("agent.create hook failed; request passed through", { error });
      return;
    }
  });
```

Cleanup:

```ts
  return async () => {
    stopGc();
    await loaded;
    await members.flush();
    await store.flush();
  };
```

- [ ] **Step 5: Update the index tests**

- `registers the room lifecycle hooks and flushes the store on cleanup` still passes; additionally assert `members.json` exists after a launch? Add a new test:

```ts
it("seeds members when a v1 rooms file is migrated on load", async () => {
  const dataDir = join(home, "plugin-data", "agent-room");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "rooms.json"),
    JSON.stringify({ version: 1, rooms: [], seats: [], feed: [] }),
    "utf8",
  );

  const { invoke } = contributeWith(
    readState({ status: "ready", revision: "1", values: DEFAULT_SETTINGS }),
  );
  await invoke("room.list")({}, {});

  const written = JSON.parse(await readFile(join(dataDir, "members.json"), "utf8"));
  expect(written.version).toBe(1);
  expect(written.members.map((member: { id: string }) => member.id).sort()).toEqual([
    "default-lead",
    "default-supervisor",
  ]);
});
```

Add imports `mkdir`, `readFile` to the index test. The test's `home` is the sandboxed `PASEO_HOME`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/events.test.ts index.server.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent-room/index.server.ts agent-room/index.server.test.ts \
        agent-room/server/events.ts agent-room/server/events.test.ts \
        agent-room/server/scope.ts
git commit -m "feat(agent-room): load members and render them on create"
```

---

## Task 11: Episode facts and candidate extraction

**Files:**
- Create: `agent-room/server/episode.ts`
- Test: `agent-room/server/episode.test.ts`

**Interfaces:**
- Consumes: `FeedEvent` (`shared/room.ts`), `EpisodeFact`, `Lesson`, `LESSON_TEXT_CAP`.
- Produces:
  - `EPISODE_SIGNAL_KINDS: Record<string, EpisodeKind>`
  - `redactSecrets(text): { text: string; redactions: number }`
  - `episodeFactFor(event, roleKind): { fact: EpisodeFact; redactions: number } | null`
  - `candidatesFromFacts(facts, { scope, sourceRoomId }): PromotionCandidate[]`
  - `type PromotionCandidate = { id: string; at: string; scope: string; text: string; sourceRoomId: string }`

- [ ] **Step 1: Write the failing episode tests**

```ts
// agent-room/server/episode.test.ts
import { describe, expect, it } from "vitest";

import { candidatesFromFacts, episodeFactFor, redactSecrets } from "./episode";

const event = (label: string, text = "x") => ({
  at: "2026-11-02T10:00:00.000Z",
  label,
  text,
});

describe("episodeFactFor", () => {
  it("maps only the five signals", () => {
    expect(episodeFactFor(event("DECISION_NEEDED"), "lead")?.fact.kind).toBe("decision");
    expect(episodeFactFor(event("REJECT"), "lead")?.fact.kind).toBe("rejected");
    expect(episodeFactFor(event("BLOCKED"), "lead")?.fact.kind).toBe("blocked");
    expect(episodeFactFor(event("ACCEPT"), "lead")?.fact.kind).toBe("outcome");
    expect(episodeFactFor(event("DONE"), "lead")?.fact.kind).toBe("outcome");
  });

  it("ignores every other label", () => {
    for (const label of ["CANDIDATE", "REVIEW", "STATUS", "task", "instruction"]) {
      expect(episodeFactFor(event(label), "lead")).toBeNull();
    }
  });

  it("ignores worker turns even when the signal matches", () => {
    expect(episodeFactFor(event("DONE"), "worker")).toBeNull();
    expect(episodeFactFor(event("DONE"), undefined)).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("redacts obvious token shapes and counts them", () => {
    const result = redactSecrets(
      "key sk-abcdefgh1234 and ghp_abcdefghijklmnopqrst and AKIAABCDEFGHIJKLMNOP",
    );
    expect(result.text).not.toContain("sk-");
    expect(result.text).not.toContain("ghp_");
    expect(result.text).not.toContain("AKIA");
    expect(result.redactions).toBe(3);
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("use pnpm for tests")).toEqual({
      text: "use pnpm for tests",
      redactions: 0,
    });
  });
});

describe("candidatesFromFacts", () => {
  const fact = (kind: "decision" | "rejected" | "outcome", text: string) => ({
    at: "2026-11-02T10:00:00.000Z",
    kind,
    text,
  });

  it("uses only decision and rejected facts", () => {
    expect(
      candidatesFromFacts(
        [fact("decision", "a"), fact("rejected", "b"), fact("outcome", "c")],
        { scope: "repo:8f3c1a2b", sourceRoomId: "R1" },
      ).map((candidate) => candidate.text),
    ).toEqual(["a", "b"]);
  });

  it("dedupes by normalized text and caps the lesson length", () => {
    const long = `  ${"x".repeat(300)}  `;
    const candidates = candidatesFromFacts(
      [fact("decision", "Use  pnpm"), fact("rejected", "use pnpm"), fact("decision", long)],
      { scope: "repo:8f3c1a2b", sourceRoomId: "R1" },
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[1]!.text).toHaveLength(240);
    expect(candidates[0]!.id).toBe(candidates[0]!.id.toLowerCase());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/episode.test.ts
```

Expected: FAIL with `Failed to resolve import "./episode"`.

- [ ] **Step 3: Implement `server/episode.ts`**

```ts
import { createHash } from "node:crypto";

import {
  LESSON_TEXT_CAP,
  type EpisodeFact,
  type EpisodeKind,
} from "../shared/member";
import type { RoleKind } from "../shared/roles";

/** Only these five signals become episode facts. */
export const EPISODE_SIGNAL_KINDS: Readonly<Record<string, EpisodeKind>> = {
  DECISION_NEEDED: "decision",
  REJECT: "rejected",
  BLOCKED: "blocked",
  ACCEPT: "outcome",
  DONE: "outcome",
};

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]+-----/g,
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let result = text;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions += 1;
      return "[redacted]";
    });
  }
  return { text: result, redactions };
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function episodeFactFor(
  event: { at: string; label: string; text: string },
  roleKind: RoleKind | undefined,
): { fact: EpisodeFact; redactions: number } | null {
  // A worker's signals reach the Lead; they contribute nothing directly.
  if (roleKind !== "supervisor" && roleKind !== "lead") return null;
  const kind = EPISODE_SIGNAL_KINDS[event.label];
  if (kind === undefined) return null;
  const redacted = redactSecrets(event.text);
  return {
    fact: {
      at: event.at,
      kind,
      signal: event.label,
      text: redacted.text,
    },
    redactions: redacted.redactions,
  };
}

export interface PromotionCandidate {
  id: string;
  at: string;
  scope: string;
  text: string;
  sourceRoomId: string;
}

export function candidatesFromFacts(
  facts: readonly EpisodeFact[],
  input: { scope: string; sourceRoomId: string },
): PromotionCandidate[] {
  const seen = new Set<string>();
  const candidates: PromotionCandidate[] = [];

  for (const fact of facts) {
    if (fact.kind !== "decision" && fact.kind !== "rejected") continue;
    const text = fact.text.trim().slice(0, LESSON_TEXT_CAP);
    if (text.length === 0) continue;
    const key = normalize(text);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: hash(`${input.scope}\n${key}`),
      at: fact.at,
      scope: input.scope,
      text,
      sourceRoomId: input.sourceRoomId,
    });
  }
  return candidates;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/episode.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/episode.ts agent-room/server/episode.test.ts
git commit -m "feat(agent-room): derive deterministic episode facts"
```

---

## Task 12: Promotion policy, dedupe, tombstones

**Files:**
- Create: `agent-room/server/promotion.ts`
- Test: `agent-room/server/promotion.test.ts`

**Interfaces:**
- Consumes: `MemberStore`, `MemoryPolicy`, `PromotionCandidate` (Task 11), `scopeType`.
- Produces:
  - `promotionTarget(policy, scope): "lesson" | "pending"`
  - `applyPromotion({ members, member, candidates, now, log }): Promise<{ promoted: number; pending: number }>`

- [ ] **Step 1: Write the failing promotion tests**

```ts
// agent-room/server/promotion.test.ts
import { describe, expect, it, vi } from "vitest";

import { memberRecordSchema, type Lesson, type PendingCandidate } from "../shared/member";
import type { MemberStore } from "./member-store";
import { applyPromotion, promotionTarget } from "./promotion";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const member = memberRecordSchema.parse({
  id: "lead-1",
  name: "Lead",
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  memory: { promotion: "auto", autoScopes: ["repo", "workspace"] },
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});

describe("promotionTarget", () => {
  it.each([
    [{ promotion: "human", autoScopes: ["repo", "workspace"] }, "repo:8f3c1a2b", "pending"],
    [{ promotion: "human", autoScopes: ["repo", "workspace"] }, "global", "pending"],
    [{ promotion: "auto", autoScopes: ["repo", "workspace"] }, "repo:8f3c1a2b", "lesson"],
    [{ promotion: "auto", autoScopes: ["repo", "workspace"] }, "workspace:/a", "lesson"],
    [{ promotion: "auto", autoScopes: ["repo", "workspace"] }, "global", "pending"],
    [{ promotion: "auto", autoScopes: ["global", "repo", "workspace"] }, "global", "lesson"],
  ])("routes %j with scope %s to %s", (policy, scope, expected) => {
    expect(promotionTarget(policy as never, scope)).toBe(expected);
  });
});

function fakeMembers() {
  const lessons: Lesson[] = [];
  const pending: PendingCandidate[] = [];
  return {
    lessons,
    pending,
    hasLesson: (id: string, scope: string, text: string) =>
      lessons.some((lesson) => lesson.scope === scope && lesson.text === text),
    hasPending: (id: string, candidateId: string) =>
      pending.some((candidate) => candidate.id === candidateId),
    appendLesson: vi.fn(async (id: string, lesson: Lesson) => {
      lessons.push(lesson);
      return true;
    }),
    appendPending: vi.fn(async (id: string, candidate: PendingCandidate) => {
      pending.push(candidate);
      return true;
    }),
  } as unknown as MemberStore;
}

const candidate = (text: string) => ({
  id: text,
  at: "2026-11-02T10:00:00.000Z",
  scope: "repo:8f3c1a2b",
  text,
  sourceRoomId: "R1",
});

describe("applyPromotion", () => {
  it("promotes auto candidates in an allowed scope", async () => {
    const members = fakeMembers();
    const out = await applyPromotion({
      members,
      member,
      candidates: [candidate("use pnpm")],
      now: () => Date.parse("2026-11-02T11:00:00.000Z"),
      log,
    });
    expect(out).toEqual({ promoted: 1, pending: 0 });
    expect(members.lessons[0]).toMatchObject({ text: "use pnpm", promotedBy: "auto" });
  });

  it("queues a human-policy candidate without promoting it", async () => {
    const members = fakeMembers();
    const out = await applyPromotion({
      members,
      member: { ...member, memory: { promotion: "human", autoScopes: ["repo", "workspace"] } },
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 1 });
    expect(members.lessons).toEqual([]);
    expect(members.pending).toHaveLength(1);
  });

  it("skips a candidate already promoted or already pending", async () => {
    const members = fakeMembers();
    members.lessons.push({
      at: "2026-11-02T10:00:00.000Z",
      scope: "repo:8f3c1a2b",
      text: "use pnpm",
      sourceRoomId: "R1",
      promotedBy: "human",
    });
    const out = await applyPromotion({
      members,
      member,
      candidates: [candidate("use pnpm")],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 0 });
  });

  it("keeps a global candidate pending under the default autoScopes", async () => {
    const members = fakeMembers();
    const out = await applyPromotion({
      members,
      member,
      candidates: [{ ...candidate("prefer small diffs"), scope: "global" }],
      now: () => 0,
      log,
    });
    expect(out).toEqual({ promoted: 0, pending: 1 });
    expect(members.pending[0]).toMatchObject({ scope: "global", text: "prefer small diffs" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/promotion.test.ts
```

Expected: FAIL with `Failed to resolve import "./promotion"`.

- [ ] **Step 3: Implement `server/promotion.ts`**

```ts
import { scopeType, type MemberRecord, type MemoryPolicy } from "../shared/member";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";
import type { PromotionCandidate } from "./episode";

export type PromotionTarget = "lesson" | "pending";

/** `human` always queues. `auto` promotes only the scope types it names. */
export function promotionTarget(policy: MemoryPolicy, scope: string): PromotionTarget {
  if (policy.promotion === "human") return "pending";
  return policy.autoScopes.includes(scopeType(scope)) ? "lesson" : "pending";
}

export interface ApplyPromotionInput {
  members: MemberStore;
  member: MemberRecord;
  candidates: readonly PromotionCandidate[];
  now: () => number;
  log: Logger;
}

export async function applyPromotion(
  input: ApplyPromotionInput,
): Promise<{ promoted: number; pending: number }> {
  let promoted = 0;
  let pending = 0;

  for (const candidate of input.candidates) {
    if (input.members.hasLesson(input.member.id, candidate.scope, candidate.text)) continue;
    if (input.members.hasPending(input.member.id, candidate.id)) continue;

    if (promotionTarget(input.member.memory, candidate.scope) === "lesson") {
      const added = await input.members.appendLesson(input.member.id, {
        at: new Date(input.now()).toISOString(),
        scope: candidate.scope,
        text: candidate.text,
        sourceRoomId: candidate.sourceRoomId,
        promotedBy: "auto",
      });
      if (added) promoted += 1;
    } else {
      const added = await input.members.appendPending(input.member.id, {
        id: candidate.id,
        at: candidate.at,
        scope: candidate.scope,
        text: candidate.text,
        sourceRoomId: candidate.sourceRoomId,
      });
      if (added) pending += 1;
    }
  }

  if (promoted > 0 || pending > 0) {
    input.log.info("member candidates routed", { promoted, pending });
  }
  return { promoted, pending };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/promotion.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/promotion.ts agent-room/server/promotion.test.ts
git commit -m "feat(agent-room): route member promotion candidates"
```

---

## Task 13: Capture episodes on turn end and promote on archive

**Files:**
- Modify: `agent-room/server/events.ts`
- Test: `agent-room/server/events.test.ts`

**Interfaces:**
- Consumes: `episodeFactFor`, `candidatesFromFacts` (Task 11), `applyPromotion` (Task 12), `candidateScope` (Task 5).
- Produces: `onTurnEnded` appends facts for Supervisor/Lead; `onArchived` writes the final outcome and routes candidates.

- [ ] **Step 1: Write the failing capture tests**

Add to `agent-room/server/events.test.ts`:

```ts
it("captures a DECISION_NEEDED supervisor turn as an episode fact", async () => {
  const timeline = [
    { type: "user_message", text: "Fix auth" },
    { type: "assistant_message", text: "DECISION_NEEDED: use pnpm or npm?" },
  ];
  const { store } = storedRoom();
  const { paseo } = fakePaseo({}, timeline);
  const { created, ctx } = eventsWith(paseo, store, undefined, {
    members: fakeMembers({ "sup-1": member() }),
    repoIdFor: async () => "8f3c1a2b",
  });
  // Bind the room's supervisor member.
  const room = store.room("S1")!;
  room.room.supervisorMemberId = "sup-1";

  await created.onTurnEnded({ agent: agent({ id: "S1", title: "Supervisor: fix auth" }) } as never, ctx);

  expect(appendEpisode).toHaveBeenCalledWith("sup-1", "S1", expect.objectContaining({
    kind: "decision",
    signal: "DECISION_NEEDED",
  }));
});

it("captures nothing from a worker turn", async () => {
  const timeline = [
    { type: "user_message", text: "work" },
    { type: "assistant_message", text: "DONE" },
  ];
  const seats = [roleSeat("W1", "S1", "L1", { id: "implementer", name: "Implementer", kind: "worker" })];
  const { store } = fakeStore({ rooms: [room("S1")], seats });
  const { paseo } = fakePaseo({}, timeline);
  const { created, ctx } = eventsWith(paseo, store, undefined, {
    members: fakeMembers({ "lead-1": member() }),
    repoIdFor: async () => null,
  });

  await created.onTurnEnded({ agent: agent({ id: "W1" }) } as never, ctx);

  expect(appendEpisode).not.toHaveBeenCalled();
});

it("writes the final outcome and promotes repo candidates at archive", async () => {
  const { store } = storedRoom();
  store.room("S1")!.room.supervisorMemberId = "sup-1";
  const { paseo } = fakePaseo();
  const members = fakeMembers({
    "sup-1": member({ memory: { promotion: "auto", autoScopes: ["repo", "workspace"] } }),
  });
  members.episodes = async () => [
    { roomId: "S1", at: "2026-11-02T10:00:00.000Z", kind: "decision", text: "use pnpm" },
  ];
  const { created, ctx } = eventsWith(paseo, store, undefined, {
    members,
    repoIdFor: async () => "8f3c1a2b",
  });

  await created.onArchived(
    { agent: agent({ id: "S1" }), archivedAt: "2026-11-02T12:00:00.000Z" },
    ctx,
  );

  expect(appendEpisode).toHaveBeenCalledWith("sup-1", "S1", expect.objectContaining({
    kind: "outcome",
  }));
  expect(appendLesson).toHaveBeenCalledWith("sup-1", expect.objectContaining({
    scope: "repo:8f3c1a2b",
    text: "use pnpm",
    promotedBy: "auto",
  }));
});

it("leaves human-policy candidates pending at archive", async () => {
  const { store } = storedRoom();
  store.room("S1")!.room.supervisorMemberId = "sup-1";
  const { paseo } = fakePaseo();
  const members = fakeMembers({ "sup-1": member({ memory: { promotion: "human", autoScopes: ["repo", "workspace"] } }) });
  members.episodes = async () => [
    { roomId: "S1", at: "2026-11-02T10:00:00.000Z", kind: "decision", text: "use pnpm" },
  ];
  const { created, ctx } = eventsWith(paseo, store, undefined, {
    members,
    repoIdFor: async () => "8f3c1a2b",
  });

  await created.onArchived(
    { agent: agent({ id: "S1" }), archivedAt: "2026-11-02T12:00:00.000Z" },
    ctx,
  );

  expect(appendLesson).not.toHaveBeenCalled();
  expect(appendPending).toHaveBeenCalledWith("sup-1", expect.objectContaining({
    scope: "repo:8f3c1a2b",
    text: "use pnpm",
  }));
});

it("reports a bound member that no longer exists", async () => {
  const { store, appendFeed } = storedRoom();
  store.room("S1")!.room.supervisorMemberId = "gone";
  const { paseo } = fakePaseo();
  const { created, ctx } = eventsWith(paseo, store, undefined, {
    members: fakeMembers({}),
    repoIdFor: async () => null,
  });

  await created.onArchived(
    { agent: agent({ id: "S1" }), archivedAt: "2026-11-02T12:00:00.000Z" },
    ctx,
  );

  expect(appendFeed).toHaveBeenCalledWith(expect.objectContaining({
    label: "member missing",
    text: expect.stringContaining("member missing"),
  }));
});
```

Extend `fakeMembers` with spies `appendEpisode`, `appendLesson`, `appendPending`, `episodes`, `hasLesson`, `hasPending`, `pending`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/events.test.ts
```

Expected: FAIL; no episode writes.

- [ ] **Step 3: Implement capture in `handleTurnEnded`**

```ts
  const handleTurnEnded = async (agent: PluginHookAgent, paseo: PaseoApi): Promise<void> => {
    const seat = store.seat(agent.id);
    if (seat === undefined) return;

    const page = await paseo.agents
      .ref(agent.id)
      .timeline.refetch({ direction: "tail", limit: FEED_TAIL_LIMIT });
    const timeline = (page?.entries ?? []).map((entry) => entry.item);
    const childIds = store.children(agent.id).map((child) => child.agentId);

    const room = store.room(seat.roomId)?.room;
    const memberId =
      room === undefined
        ? null
        : seat.roleKind === "supervisor"
          ? room.supervisorMemberId
          : seat.roleKind === "lead"
            ? room.leadMemberId
            : null;

    for (const draft of feedFromTurn({ agent: seat, childIds, timeline })) {
      const stored = store.appendFeed({ roomId: seat.roomId, ...draft });
      if (memberId === null) continue;
      const captured = episodeFactFor(stored, seat.roleKind);
      if (captured === null) continue;
      if (captured.redactions > 0) {
        log.warn("redacted secrets in member memory", {
          memberId,
          roomId: seat.roomId,
          redactions: captured.redactions,
        });
      }
      await deps.members.appendEpisode(memberId, seat.roomId, captured.fact);
    }
  };
```

- [ ] **Step 4: Implement archive finalization**

Change `handleArchived` to accept `archivedAt` and import the promotion helpers:

```ts
  const handleArchived = async (agent: PluginHookAgent, archivedAt: string): Promise<void> => {
    const found = store.room(agent.id);
    if (found === undefined) return;
    store.endRoom(agent.id);

    const repoId = await deps.repoIdFor(found.room.cwd);
    const scope = candidateScope(found.room.cwd, repoId);

    const bindings: Array<[string | null, "supervisor" | "lead"]> = [
      [found.room.supervisorMemberId, "supervisor"],
      [found.room.leadMemberId, "lead"],
    ];

    for (const [memberId, role] of bindings) {
      if (memberId === null) continue;
      const member = deps.members.get(memberId);
      if (member === undefined) {
        store.appendFeed({
          roomId: found.room.id,
          kind: "note",
          from: null,
          to: memberId,
          label: "member missing",
          text: `member missing: ${memberId} (${role}); memory was not written`,
        });
        continue;
      }

      await deps.members.appendEpisode(memberId, found.room.id, {
        at: archivedAt,
        kind: "outcome",
        text: `room ended: ${found.room.task.trim().length > 0 ? found.room.task : found.room.id}`.slice(0, 400),
      });

      const facts = (await deps.members.episodes(memberId)).filter(
        (fact) => fact.roomId === found.room.id,
      );
      const candidates = candidatesFromFacts(facts, {
        scope,
        sourceRoomId: found.room.id,
      });
      await applyPromotion({ members: deps.members, member, candidates, now: deps.now ?? (() => Date.now()), log });
    }
  };
```

`createRoomEvents` needs a `now` seam for tests. Add `now?: () => number` to `RoomEventsDeps` with default `() => Date.now()`.

`onArchived` passes `event.archivedAt`:

```ts
    async onArchived(event, ctx) {
      try {
        await handleArchived(event.agent, event.archivedAt);
      } catch (error) {
        log.error("agent.archived handling failed", {
          agentId: event.agent.id,
          error: reason(error),
        });
      }
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/events.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-room/server/events.ts agent-room/server/events.test.ts
git commit -m "feat(agent-room): capture room episodes and promote lessons"
```

---

## Task 14: Member RPCs and handlers

**Files:**
- Modify: `agent-room/shared/rpc.ts`
- Create: `agent-room/server/member-handlers.ts`
- Modify: `agent-room/index.server.ts`
- Test: `agent-room/server/member-handlers.test.ts` (new)
- Test: `agent-room/index.server.test.ts`

**Interfaces:**
- Consumes: `MemberStore` (Task 3).
- Produces RPCs:
  - `member.list` → `{ members: MemberRecord[] }`
  - `member.get` → member detail or `{ missing: true }`
  - `member.save` → `{ member: MemberRecord }`
  - `member.charter` → `{ ok: true }`
  - `member.pending` → `{ ok: true; lesson?: Lesson }`
- Produces `createMemberHandlers({ members, now, newId, log })`.

- [ ] **Step 1: Add the RPC contracts**

In `agent-room/shared/rpc.ts`:

```ts
import {
  episodeFactSchema,
  lessonSchema,
  memberRecordSchema,
  memoryPolicySchema,
  memberRoleSchema,
  pendingCandidateSchema,
} from "./member";

export const memberSaveInputSchema = z.object({
  id: nonEmptyText.optional(),
  name: z.string().min(1).max(60),
  role: memberRoleSchema,
  provider: nonEmptyText,
  model: nonEmptyText,
  modeId: nonEmptyText.optional(),
  thinkingOptionId: nonEmptyText.optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  memory: memoryPolicySchema,
});

export const memberListRpc = defineRpc({
  name: "member.list",
  input: z.object({}),
  output: z.object({ members: z.array(memberRecordSchema) }),
});

export const memberGetRpc = defineRpc({
  name: "member.get",
  input: z.object({ memberId: nonEmptyText }),
  output: z.union([
    z.object({
      member: memberRecordSchema,
      charter: z.string(),
      lessons: z.array(lessonSchema),
      pending: z.array(pendingCandidateSchema),
      episodes: z.array(episodeFactSchema.extend({ roomId: nonEmptyText })),
    }),
    z.object({ missing: z.literal(true) }),
  ]),
});

export const memberSaveRpc = defineRpc({
  name: "member.save",
  input: memberSaveInputSchema,
  output: z.object({ member: memberRecordSchema }),
});

export const memberCharterRpc = defineRpc({
  name: "member.charter",
  input: z.object({ memberId: nonEmptyText, text: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

export const memberPendingRpc = defineRpc({
  name: "member.pending",
  input: z.object({
    memberId: nonEmptyText,
    candidateId: nonEmptyText,
    action: z.enum(["accept", "reject"]),
  }),
  output: z.object({ ok: z.literal(true), lesson: lessonSchema.optional() }),
});
```

- [ ] **Step 2: Write the failing handler tests**

```ts
// agent-room/server/member-handlers.test.ts
import { describe, expect, it, vi } from "vitest";

import { memberRecordSchema } from "../shared/member";
import { createMemberHandlers } from "./member-handlers";
import type { MemberStore } from "./member-store";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const record = memberRecordSchema.parse({
  id: "lead-1",
  name: "Lead",
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  memory: { promotion: "human" },
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
});

function fakeMembers() {
  const records = [record];
  return {
    list: vi.fn(() => records),
    get: vi.fn((id: string) => records.find((member) => member.id === id)),
    upsert: vi.fn(async () => undefined),
    charter: vi.fn(() => "charter"),
    writeCharter: vi.fn(async () => undefined),
    lessons: vi.fn(() => []),
    pending: vi.fn(() => []),
    acceptPending: vi.fn(async () => ({
      at: "2026-11-02T10:00:00.000Z",
      scope: "global",
      text: "x",
      sourceRoomId: "R1",
      promotedBy: "human" as const,
    })),
    rejectPending: vi.fn(async () => true),
    episodes: vi.fn(async () => []),
  } as unknown as MemberStore;
}

describe("member handlers", () => {
  it("lists members", () => {
    const handlers = createMemberHandlers({ members: fakeMembers(), now: () => 0, newId: () => "new", log });
    expect(handlers.list()).toEqual({ members: [record] });
  });

  it("returns member detail and a missing member", async () => {
    const handlers = createMemberHandlers({ members: fakeMembers(), now: () => 0, newId: () => "new", log });
    await expect(handlers.get({ memberId: "lead-1" })).resolves.toMatchObject({
      member: record,
      charter: "charter",
      lessons: [],
      pending: [],
      episodes: [],
    });
    await expect(handlers.get({ memberId: "nope" })).resolves.toEqual({ missing: true });
  });

  it("creates a member with timestamps and a generated id", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({
      members,
      now: () => Date.parse("2026-11-02T10:00:00.000Z"),
      newId: () => "new-id",
      log,
    });

    const out = await handlers.save({
      name: "Lead",
      role: "lead",
      provider: "claude",
      model: "claude-opus-5-5",
      memory: { promotion: "human" },
    });

    expect(out.member).toMatchObject({
      id: "new-id",
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:00:00.000Z",
      memory: { promotion: "human", autoScopes: ["repo", "workspace"] },
    });
    expect(members.upsert).toHaveBeenCalledWith(out.member);
  });

  it("keeps createdAt when updating an existing member", async () => {
    const handlers = createMemberHandlers({
      members: fakeMembers(),
      now: () => Date.parse("2026-11-02T11:00:00.000Z"),
      newId: () => "unused",
      log,
    });
    const out = await handlers.save({
      id: "lead-1",
      name: "Renamed",
      role: "lead",
      provider: "codex",
      model: "gpt-5.6-sol",
      memory: { promotion: "auto", autoScopes: ["repo"] },
    });
    expect(out.member.createdAt).toBe("2026-11-02T00:00:00.000Z");
    expect(out.member.updatedAt).toBe("2026-11-02T11:00:00.000Z");
  });

  it("writes the charter", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    await expect(handlers.charter({ memberId: "lead-1", text: "use pnpm" })).resolves.toEqual({ ok: true });
    expect(members.writeCharter).toHaveBeenCalledWith("lead-1", "use pnpm");
  });

  it("accepts and rejects pending candidates", async () => {
    const members = fakeMembers();
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    await expect(
      handlers.pending({ memberId: "lead-1", candidateId: "c1", action: "accept" }),
    ).resolves.toMatchObject({ ok: true, lesson: expect.objectContaining({ promotedBy: "human" }) });
    await expect(
      handlers.pending({ memberId: "lead-1", candidateId: "c2", action: "reject" }),
    ).resolves.toEqual({ ok: true });
    expect(members.acceptPending).toHaveBeenCalledWith("lead-1", "c1");
    expect(members.rejectPending).toHaveBeenCalledWith("lead-1", "c2");
  });

  it("fails an accept for an unknown candidate", async () => {
    const members = fakeMembers();
    (members.acceptPending as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const handlers = createMemberHandlers({ members, now: () => 0, newId: () => "new", log });
    await expect(
      handlers.pending({ memberId: "lead-1", candidateId: "gone", action: "accept" }),
    ).rejects.toThrow(/candidate not found/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run server/member-handlers.test.ts
```

Expected: FAIL with `Failed to resolve import "./member-handlers"`.

- [ ] **Step 4: Implement `server/member-handlers.ts`**

```ts
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";

import { memberRecordSchema, type MemberRecord } from "../shared/member";
import {
  memberCharterRpc,
  memberGetRpc,
  memberListRpc,
  memberPendingRpc,
  memberSaveRpc,
} from "../shared/rpc";
import type { Logger } from "./logger";
import type { MemberStore } from "./member-store";

export interface MemberHandlerDeps {
  members: MemberStore;
  now: () => number;
  newId: () => string;
  log: Logger;
}

export interface MemberHandlers {
  list(): RpcOutput<typeof memberListRpc>;
  get(input: RpcInput<typeof memberGetRpc>): Promise<RpcOutput<typeof memberGetRpc>>;
  save(input: RpcInput<typeof memberSaveRpc>): Promise<RpcOutput<typeof memberSaveRpc>>;
  charter(input: RpcInput<typeof memberCharterRpc>): Promise<RpcOutput<typeof memberCharterRpc>>;
  pending(input: RpcInput<typeof memberPendingRpc>): Promise<RpcOutput<typeof memberPendingRpc>>;
}

export function createMemberHandlers(deps: MemberHandlerDeps): MemberHandlers {
  const { members } = deps;

  return {
    list() {
      return { members: members.list() };
    },

    async get(input) {
      const member = members.get(input.memberId);
      if (member === undefined) return { missing: true };
      return {
        member,
        charter: members.charter(member.id),
        lessons: members.lessons(member.id),
        pending: members.pending(member.id),
        episodes: await members.episodes(member.id),
      };
    },

    async save(input) {
      const existing = input.id === undefined ? undefined : members.get(input.id);
      const at = new Date(deps.now()).toISOString();
      const record: MemberRecord = memberRecordSchema.parse({
        id: input.id ?? deps.newId(),
        name: input.name,
        role: input.role,
        provider: input.provider,
        model: input.model,
        ...(input.modeId !== undefined ? { modeId: input.modeId } : {}),
        ...(input.thinkingOptionId !== undefined ? { thinkingOptionId: input.thinkingOptionId } : {}),
        ...(input.features !== undefined ? { features: input.features } : {}),
        memory: input.memory,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      });
      await members.upsert(record);
      deps.log.info("member saved", { memberId: record.id, role: record.role });
      return { member: record };
    },

    async charter(input) {
      if (members.get(input.memberId) === undefined) {
        throw new Error(`member.charter: member not found: ${input.memberId}`);
      }
      await members.writeCharter(input.memberId, input.text);
      return { ok: true };
    },

    async pending(input) {
      if (members.get(input.memberId) === undefined) {
        throw new Error(`member.pending: member not found: ${input.memberId}`);
      }
      if (input.action === "reject") {
        await members.rejectPending(input.memberId, input.candidateId);
        return { ok: true };
      }
      const lesson = await members.acceptPending(input.memberId, input.candidateId);
      if (lesson === null) {
        throw new Error(`member.pending: candidate not found: ${input.candidateId}`);
      }
      return { ok: true, lesson };
    },
  };
}
```

- [ ] **Step 5: Register the RPCs in `index.server.ts`**

```ts
import {
  memberCharterRpc,
  memberGetRpc,
  memberListRpc,
  memberPendingRpc,
  memberSaveRpc,
} from "./shared/rpc";
import { createMemberHandlers } from "./server/member-handlers";

  const memberHandlers = createMemberHandlers({
    members,
    now: () => Date.now(),
    newId: () => randomUUID(),
    log,
  });

  server.handle(memberListRpc, async () => {
    await loaded;
    return memberHandlers.list();
  });
  server.handle(memberGetRpc, async (input) => {
    await loaded;
    return memberHandlers.get(input);
  });
  server.handle(memberSaveRpc, async (input) => {
    await loaded;
    return memberHandlers.save(input);
  });
  server.handle(memberCharterRpc, async (input) => {
    await loaded;
    return memberHandlers.charter(input);
  });
  server.handle(memberPendingRpc, async (input) => {
    await loaded;
    return memberHandlers.pending(input);
  });
```

Register them after `room.get` and before `gc.status`, so the contract-order test is deterministic.

- [ ] **Step 6: Update the index test contract order**

```ts
expect(handled.map((entry) => entry.name)).toEqual([
  "room.launch",
  "room.adopt",
  "room.list",
  "room.get",
  "member.list",
  "member.get",
  "member.save",
  "member.charter",
  "member.pending",
  "gc.status",
  "gc.run",
]);
expect(new Set(handled.map((entry) => entry.handler)).size).toBe(11);
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd agent-room && npx vitest run server/member-handlers.test.ts index.server.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add agent-room/shared/rpc.ts agent-room/server/member-handlers.ts \
        agent-room/server/member-handlers.test.ts agent-room/index.server.ts \
        agent-room/index.server.test.ts
git commit -m "feat(agent-room): expose member RPCs"
```

---

## Task 15: Member screen, launch selectors, and member chips

**Files:**
- Create: `agent-room/client/member-screen.tsx`
- Modify: `agent-room/client/launch-form.tsx`
- Modify: `agent-room/client/rooms-screen.tsx`
- Modify: `agent-room/client/room-screen.tsx`
- Modify: `agent-room/client/view-model.ts`
- Modify: `agent-room/index.client.tsx`
- Test: `agent-room/client/view-model.test.ts`

**Interfaces:**
- Consumes: member RPCs (Task 14), `SeatEditor` / `Section` / `Field` / `ActionButton` / `ChoiceRow` / `TextEntry` / `useProviderCatalog` from `seat-editor.tsx`.
- Produces:
  - `memberChip(room, members): { supervisor: string | null; lead: string | null }`
  - `memberNameForSeat(seat, room, members): string | null`
  - member screen registered as `members`; sidebar row and Command Center entry.

- [ ] **Step 1: Write the failing view-model tests**

Add to `agent-room/client/view-model.test.ts`:

```ts
import { memberChip, memberNameForSeat } from "./view-model";
import { memberRecordSchema } from "../shared/member";

const member = (id: string, role: "supervisor" | "lead", name: string) =>
  memberRecordSchema.parse({
    id,
    name,
    role,
    provider: "claude",
    model: "claude-opus-5-5",
    memory: { promotion: "human" },
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  });

const boundRoom = {
  id: "R1",
  task: "fix",
  cwd: "/repo",
  workspaceId: null,
  supervisorMemberId: "sup-1",
  leadMemberId: "lead-1",
  createdAt: "2026-11-02T00:00:00.000Z",
};

describe("member chips", () => {
  it("names the room's bound members", () => {
    expect(memberChip(boundRoom, [member("sup-1", "supervisor", "Ada"), member("lead-1", "lead", "Grace")]))
      .toEqual({ supervisor: "Ada", lead: "Grace" });
  });

  it("returns null for unbound or missing members", () => {
    expect(memberChip({ ...boundRoom, leadMemberId: null }, [])).toEqual({
      supervisor: null,
      lead: null,
    });
    expect(memberChip(boundRoom, [])).toEqual({ supervisor: null, lead: null });
  });

  it("names the member behind a seat", () => {
    const members = [member("sup-1", "supervisor", "Ada"), member("lead-1", "lead", "Grace")];
    expect(memberNameForSeat({ roleKind: "supervisor" } as never, boundRoom, members)).toBe("Ada");
    expect(memberNameForSeat({ roleKind: "lead" } as never, boundRoom, members)).toBe("Grace");
    expect(memberNameForSeat({ roleKind: "worker" } as never, boundRoom, members)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd agent-room && npx vitest run client/view-model.test.ts
```

Expected: FAIL; helpers are missing.

- [ ] **Step 3: Implement the helpers in `client/view-model.ts`**

```ts
import type { MemberRecord } from "../shared/member";
import type { RoomRecord } from "../shared/room";

export interface MemberChip {
  supervisor: string | null;
  lead: string | null;
}

export function memberChip(room: RoomRecord, members: readonly MemberRecord[]): MemberChip {
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (members.find((member) => member.id === id)?.name ?? null);
  return { supervisor: nameOf(room.supervisorMemberId), lead: nameOf(room.leadMemberId) };
}

export function memberNameForSeat(
  seat: Pick<SeatRecord, "roleKind">,
  room: RoomRecord,
  members: readonly MemberRecord[],
): string | null {
  if (seat.roleKind === "supervisor") return memberChip(room, members).supervisor;
  if (seat.roleKind === "lead") return memberChip(room, members).lead;
  return null;
}
```

- [ ] **Step 4: Add the member selectors to the launch form**

In `client/launch-form.tsx`, extend `LaunchFormProps`:

```ts
import type { MemberRecord } from "../shared/member";

export interface LaunchFormProps extends Surface {
  target: LaunchTarget;
  members: MemberRecord[];
  supervisorMemberId: string;
  leadMemberId: string;
  onSupervisorMemberChange(id: string): void;
  onLeadMemberChange(id: string): void;
  task: string;
  onTaskChange(text: string): void;
  launching: boolean;
  error: string;
  onLaunch(): void;
}
```

Add two `Field`s after the target fields:

```tsx
      <Field surface={surface} label="Supervisor member">
        <ChoiceRow
          surface={surface}
          options={[
            { id: "", label: "host seat" },
            ...props.members
              .filter((member) => member.role === "supervisor")
              .map((member) => ({ id: member.id, label: member.name })),
          ]}
          value={props.supervisorMemberId}
          disabled={props.launching}
          onSelect={props.onSupervisorMemberChange}
        />
      </Field>

      <Field surface={surface} label="Lead member">
        <ChoiceRow
          surface={surface}
          options={[
            { id: "", label: "host seat" },
            ...props.members
              .filter((member) => member.role === "lead")
              .map((member) => ({ id: member.id, label: member.name })),
          ]}
          value={props.leadMemberId}
          disabled={props.launching}
          onSelect={props.onLeadMemberChange}
        />
      </Field>
```

- [ ] **Step 5: Wire members into the Rooms screen**

In `client/rooms-screen.tsx`:

```ts
import { memberListRpc } from "../shared/rpc";
import type { MemberRecord } from "../shared/member";
import { memberChip } from "./view-model";

  const listMembers = useRpc(memberListRpc);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [supervisorMemberId, setSupervisorMemberId] = useState("");
  const [leadMemberId, setLeadMemberId] = useState("");

  useEffect(() => {
    void listMembers({})
      .then((result) => setMembers(result.members))
      .catch(() => setMembers([]));
  }, [listMembers]);

  async function launch() {
    // ...existing guards...
    const result = await launchRoom({
      task: task.trim(),
      ...request,
      ...(supervisorMemberId.length > 0 ? { supervisorMemberId } : {}),
      ...(leadMemberId.length > 0 ? { leadMemberId } : {}),
    });
    // ...unchanged...
  }
```

Pass to `LaunchForm`:

```tsx
          members={members}
          supervisorMemberId={supervisorMemberId}
          leadMemberId={leadMemberId}
          onSupervisorMemberChange={setSupervisorMemberId}
          onLeadMemberChange={setLeadMemberId}
```

Add chips to `RoomRow`:

```tsx
function RoomRow(props: { surface: Surface; room: RoomRecord; members: MemberRecord[]; onOpen(): void }) {
  const chips = memberChip(props.room, props.members);
  // ...existing task/time text...
  const chipText = [chips.supervisor, chips.lead].filter((name) => name !== null).join(" · ");
  // render `chipText` in the muted meta line when non-empty
}
```

Pass `members={members}` from the list map.

- [ ] **Step 6: Show member names in the seat tree**

In `client/room-screen.tsx`, load members and pass the name into `SeatRow`:

```ts
import { memberListRpc } from "../shared/rpc";
import type { MemberRecord } from "../shared/member";
import { memberNameForSeat } from "./view-model";

  const listMembers = useRpc(memberListRpc);
  const membersQuery = useQuery({
    queryKey: ["agent-room", "members"],
    queryFn: () => listMembers({}),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const members = membersQuery.data?.members ?? [];
```

`SeatRowProps` gains `memberName: string | null`, rendered under the provider/model line:

```tsx
      {props.memberName === null ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {`member: ${props.memberName}`}
        </Text>
      )}
```

In the tree map:

```tsx
<SeatRow
  key={node.seat.agentId}
  surface={surface}
  seat={node.seat}
  depth={node.depth}
  memberName={loaded === null ? null : memberNameForSeat(node.seat, loaded.room, members)}
  openAgent={openAgent}
/>
```

- [ ] **Step 7: Build the member screen**

Create `agent-room/client/member-screen.tsx` with this structure:

```tsx
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import type { MemberRecord } from "../shared/member";
import { DEFAULT_SETTINGS } from "../shared/roles";
import type { SeatDraft } from "./settings-draft";
import {
  memberCharterRpc,
  memberGetRpc,
  memberListRpc,
  memberPendingRpc,
  memberSaveRpc,
} from "../shared/rpc";
import {
  ActionButton,
  ChoiceRow,
  Field,
  SeatEditor,
  Section,
  TextEntry,
  describeError,
  paddingFor,
  useProviderCatalog,
} from "./seat-editor";

const SUPERVISOR_SEAT = DEFAULT_SETTINGS.roles.find((role) => role.kind === "supervisor")!;
const LEAD_SEAT = DEFAULT_SETTINGS.roles.find((role) => role.kind === "lead")!;

type Draft = {
  id?: string;
  name: string;
  role: "supervisor" | "lead";
  seat: SeatDraft;
  promotion: "human" | "auto";
  autoScopes: Array<"global" | "repo" | "workspace">;
};

function draftFrom(member: MemberRecord): Draft {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    seat: {
      provider: member.provider,
      model: member.model,
      ...(member.modeId !== undefined ? { modeId: member.modeId } : {}),
      ...(member.thinkingOptionId !== undefined ? { thinkingOptionId: member.thinkingOptionId } : {}),
      ...(member.features !== undefined ? { features: member.features } : {}),
    },
    promotion: member.memory.promotion,
    autoScopes: [...member.memory.autoScopes],
  };
}

function emptyDraft(role: "supervisor" | "lead"): Draft {
  const seat = role === "supervisor" ? SUPERVISOR_SEAT : LEAD_SEAT;
  return {
    name: "",
    role,
    seat: {
      provider: seat.provider,
      model: seat.model,
      ...(seat.modeId !== undefined ? { modeId: seat.modeId } : {}),
      ...(seat.thinkingOptionId !== undefined ? { thinkingOptionId: seat.thinkingOptionId } : {}),
    },
    promotion: "human",
    autoScopes: ["repo", "workspace"],
  };
}

export function MemberScreen(props: PluginScreenProps) {
  // 1. member.list on mount, selected id in state.
  // 2. member.get for the selected id; hold the detail in state.
  // 3. SeatEditor edits the draft's seat through `setDraft`; provider catalog
  //    is loaded once with `useProviderCatalog()`.
  // 4. Save calls memberSaveRpc; charter Save calls memberCharterRpc; pending
  //    buttons call memberPendingRpc and then refetch member.get.
  // 5. Lessons render `[scope] date text`; episodes render `roomId kind text`.
  // 6. A "New member" button switches to an empty draft; role chips rebuild the
  //    seat from the matching stock role.
  // Use Section/Field/TextEntry/ActionButton/ChoiceRow exactly as rooms-screen does.
}
```

Implement the bodies in the same style as `rooms-screen.tsx`. Required behaviors:

- `member.list` result sets the list; selecting a row sets `selectedId`.
- `member.get` populates `detail`; `"missing" in detail` shows "member not found".
- Save builds:

```ts
      const result = await save({
        ...(draft.id !== undefined ? { id: draft.id } : {}),
        name: draft.name.trim(),
        role: draft.role,
        provider: draft.seat.provider,
        model: draft.seat.model ?? "",
        ...(draft.seat.modeId !== undefined ? { modeId: draft.seat.modeId } : {}),
        ...(draft.seat.thinkingOptionId !== undefined
          ? { thinkingOptionId: draft.seat.thinkingOptionId }
          : {}),
        ...(draft.seat.features !== undefined ? { features: draft.seat.features } : {}),
        memory: { promotion: draft.promotion, autoScopes: draft.autoScopes },
      });
```

- charter text is local state seeded from `detail.charter`; Save calls `charter({ memberId, text })`.
- pending rows show `candidate.text`, `candidate.scope`, and Accept/Reject buttons.
- lessons rows show `lesson.scope`, `lesson.at`, `lesson.promotedBy`, `lesson.sourceRoomId`, `lesson.text`.
- episodes rows show `episode.roomId`, `episode.kind`, `episode.signal ?? ""`, `episode.text`.
- Auto-scope toggles: one chip row per scope type; pressing toggles membership in `draft.autoScopes`.

- [ ] **Step 8: Register the screen**

In `index.client.tsx`:

```ts
import { MemberScreen } from "./client/member-screen";
```

Add after the rooms screen:

```ts
    client.addScreen({ id: "members", title: "Members", Component: MemberScreen }),
```

Add a sidebar row:

```tsx
function MembersSidebarItem(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="UserCog"
      active={props.currentScreen?.screenId === "members"}
      onPress={() => props.openScreen({ screenId: "members" })}
    />
  );
}
```

Register it and a Command Center entry:

```ts
    client.addSidebarHeaderItem({ id: "members", title: "Members", Component: MembersSidebarItem }),
    client.addCommandCenterItem({
      id: "open-members",
      title: "Members",
      icon: "UserCog",
      context: "global",
      onSelect(ctx) {
        ctx.openScreen({ screenId: "members" });
      },
    }),
```

- [ ] **Step 9: Run the tests and typecheck**

```bash
cd agent-room && npx vitest run client/view-model.test.ts client/settings-draft.test.ts
cd agent-room && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add agent-room/client/member-screen.tsx agent-room/client/launch-form.tsx \
        agent-room/client/rooms-screen.tsx agent-room/client/room-screen.tsx \
        agent-room/client/view-model.ts agent-room/client/view-model.test.ts \
        agent-room/index.client.tsx
git commit -m "feat(agent-room): add member screen and member selectors"
```

---

## Task 16: OVERVIEW, acceptance record, and whole-branch verification

**Files:**
- Modify: `agent-room/OVERVIEW.md`
- Create: `agent-room/docs/acceptance-2026-11-02-members.md`

**Interfaces:**
- Consumes: every earlier task.
- Produces: the shipped behavior documented, plus the observed verification record.

- [ ] **Step 1: Update `OVERVIEW.md`**

Add these sections and adjust the existing storage paragraph:

1. **Members** — a member is a durable Supervisor or Lead: name, role, seat defaults, memory policy, charter, lessons. Members are not worker roles.
2. **Memory scopes** — `global`, `repo:<sha8>`, `workspace:<path>`; load global + matching scopes; exact workspace match; repo identity is the normalized remote (or repo root).
3. **Promotion** — `human` queues in `pending.jsonl`; `auto` promotes scope types in `autoScopes`; default `["repo","workspace"]` keeps global for review; reject writes a tombstone.
4. **Episodes** — deterministic rows from `DECISION_NEEDED`, `REJECT`, `BLOCKED`, `ACCEPT`, `DONE` on Supervisor/Lead turns; not retrieved into a prompt in v1.
5. **Storage** — replace the `rooms.json` sentence with:

```
Room state is `rooms.json` (version 2) and `members.json` (version 1) under the
daemon's plugin data directory (`$PASEO_HOME/plugin-data/agent-room`, or
`~/.paseo/plugin-data/agent-room` when `PASEO_HOME` is unset). Member memory lives
in `members/<memberId>/`: `charter.md`, `lessons.jsonl`, `pending.jsonl`, and
`episodes/<roomId>.jsonl`. `rooms.json` is forward-only after version 2.
```

6. **Known limits** — add:
   - One Lead member per room; every Lead in a room shares it.
   - The pre-create hook sees no parent/room; a Lead member's seat is recognized by matching provider/model, so two Lead members on the same seat are indistinguishable.
   - Global candidates are not produced by a live room in v1; they arrive only through explicit import/tests and default to pending.
   - The `room-status` card does not show member names.
   - No worker members, no mid-room memory edits, no cross-member memory.

Also update the stale client copy in `client/room-pill.tsx`: replace
"titles Leads with `[room:lead]`" with "titles Leads with `Lead: <workstream>`",
and replace "saved Supervisor, Lead and peer seats" with "saved role seats".

- [ ] **Step 2: Run the full verification**

```bash
cd agent-room
npm test
npm run typecheck
npm run gen:prompts
git diff --exit-code server/prompts/generated.ts
```

Expected: all tests pass; typecheck exit 0; `gen:prompts` leaves `generated.ts` unchanged.

- [ ] **Step 3: Write the acceptance record**

Create `agent-room/docs/acceptance-2026-11-02-members.md` with the same shape as `acceptance-2026-11-02-role-titles.md`:

- Tree: branch, commit, Node version.
- Full suite: paste the exact `npm test` tail and count.
- Typecheck: paste the command and state exit 0.
- Spec acceptance mapping:
  1. Two rooms on one member → identical Supervisor seat (`server/handlers.test.ts` member launch tests).
  2. Prompt carries charter and only matching-scope lessons (`server/render.test.ts`, `server/inject.test.ts`).
  3. Human policy → `pending.jsonl`, not `lessons.jsonl`; accept → next prompt (`server/promotion.test.ts`, `server/events.test.ts`, `server/member-store.test.ts`).
  4. Auto + default scopes → repo promoted, global pending (`server/promotion.test.ts`).
  5. v1 rooms → null member ids, seeded members, idempotent second load (`server/store.test.ts`, `server/migrate-members.test.ts`, `index.server.test.ts`).
  6. Guard tests unchanged; `npm test` and typecheck green.
- Migration demonstration: paste the output of the `index.server.test.ts` seed test name and a `members.json` sample from the sandbox.
- Live Paseo probe: **PENDING USER RUN**, with exact steps:

```bash
cd agent-room
paseo plugin reload agent-room
```

Then, in the Paseo UI:

1. Open **Members** and confirm `default-supervisor` and `default-lead` exist with the catalog seats.
2. Launch a room with both members selected; open the Supervisor and confirm its system prompt contains `## Member` and its provider/model matches the member.
3. Archive the Supervisor; inspect:

```bash
ls ~/.paseo/plugin-data/agent-room/members
cat ~/.paseo/plugin-data/agent-room/members/default-lead/episodes/<roomId>.jsonl
cat ~/.paseo/plugin-data/agent-room/members/default-lead/pending.jsonl
cat ~/.paseo/plugin-data/agent-room/members/default-lead/lessons.jsonl
```

4. Confirm `pending.jsonl` has the room's decisions and `lessons.jsonl` is empty under `promotion: "human"`.

- [ ] **Step 4: Final whole-branch review**

Run the `superpowers:requesting-code-review` review over the full branch diff. Fix findings, re-run `npm test && npm run typecheck`, then commit.

- [ ] **Step 5: Commit**

```bash
git add agent-room/OVERVIEW.md agent-room/client/room-pill.tsx \
        agent-room/docs/acceptance-2026-11-02-members.md
git commit -m "docs(agent-room): document members and record phase 4 acceptance"
```

---

## Plan self-review

**Spec coverage**

| Spec section | Task |
|---|---|
| §3 Member record | 1 |
| §3 Room binding | 2, 8, 10 |
| §4 Lesson / episode shape | 1, 11 |
| §5 Scopes | 1, 5 |
| §6 Storage layout / concurrency | 3 |
| §7 Prompt assembly / budgets | 6, 7 |
| §8 Seat resolution / launch binding | 7, 8 |
| §9 Episode capture / promotion | 11, 12, 13 |
| §10 Migration | 2, 4, 10 |
| §11 Client surface | 15 |
| §12 Failure modes | 3, 5, 6, 13 (tests pin each row) |
| §13 Tests | every task |
| §14 Rollout 4a/4b/4c | 1–10 / 11–14 / 15 |
| §15 Acceptance | 16 |
| §16 Deferred items | Global Constraints + OVERVIEW limits |

**Placeholder scan:** no `TBD`, no "similar to Task N", no unshown code step.

**Type consistency:** `MemberRecord`, `MemberIndex.forSeat`, `MemberStore.lessonsFor`, `MemberRender`, `PromotionCandidate`, `RoomRecord.supervisorMemberId`, and `bindRoomMembers` use the same names in every task. `renderSystemPrompt` keeps its first three parameters, so existing call sites compile unchanged.

**Review Focus coverage:** entries 1–5 are pinned by Task 2 (`migrates a v1 file`), Tasks 3/4 (`corrupt lesson line`, `corrupt members.json`, `leaves an existing members file alone`), Task 5 (no git / no remote / remote normalization), Task 6 (oversized charter, >12 lessons, zero lessons), and Task 7 (no member match, already-prompted launch, worker unchanged).
