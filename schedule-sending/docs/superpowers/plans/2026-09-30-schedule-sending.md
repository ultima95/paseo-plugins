# schedule-sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Paseo plugin that lets the user queue a text message into an existing agent chat from that chat's composer, and delivers it at a chosen later time even when the Paseo app is closed.

**Architecture:** Daemon-owned queue. The plugin's server runtime persists items to a JSON file and runs one tick-loop scheduler that sends via the Paseo SDK, waiting for the agent to be idle and retrying with backoff. The client runtime registers one composer pill per agent whose popover has an add form and a pending/recent list, talking to the server through three Zod-validated RPCs.

**Tech Stack:** TypeScript (strict), Zod 4, React Native primitives, TanStack Query, `@getpaseo/plugin` SDK 0.10.x, Vitest 4 for unit tests.

**Spec:** `docs/superpowers/specs/2026-09-30-schedule-sending-design.md` (read it first; this plan implements it, including its §4.2 gateway/ordering rules and §8 probes).

## Global Constraints

- Plugin project root: `/Users/ultima/Workspace/paseo-plugins/schdule-sending` (note the directory's spelling). Plugin id is `schedule-sending` (lowercase letters, numbers, hyphens).
- Target Paseo daemon/app 0.10.1. `requirements.paseo` is the `>=` range that `paseo plugin init` writes (start from 0.10.1); never leave it missing.
- Only `client/`, `server/`, `shared/` may hold code modules besides the two entries `index.client.tsx` and `index.server.ts`. No `node:` imports in `client/` or `shared/`. `shared/` imports only `zod` and `@getpaseo/plugin` (never React, never Node). Server code must not import React, React Native or client SDK entries.
- Client code: React Native primitives only (`View`, `Text`, `Pressable`, `ScrollView`, `TextInput`). No HTML elements, `className`, CSS strings, `onClick`, `document`, `window`, `localStorage`, `navigator`. Every `Text` color comes from `theme.colors`; padding/stacking use `layout.compact`. Do not import `lucide-react-native` or `react-native-svg`.
- Limits (verbatim from the spec): message text 1–10,000 chars (after trim); `fireAt` at most 30 days ahead; server accepts `fireAt` at most 5 minutes in the past (clock skew); client requires at least 1 minute ahead; finished items pruned 7 days after `finishedAt`; scheduler tick 10 s; at most 5 send attempts; backoff 30 s, 2 min, 10 min, 30 min.
- Store file: `<PASEO_HOME>/plugin-data/schedule-sending/queue.json`, fallback `~/.paseo` when `PASEO_HOME` is unset. Writes atomic (temp file + rename), serialized.
- Never log message text; log ids, agent ids, counts and status only.
- Do not restart the daemon to load source changes. Use `paseo plugin reload schedule-sending`.
- Message text only: no attachments, no recurring schedules, no slash command, no sidebar surface.
- The project directory is not a git repository and the user has not asked for one. There are no commit steps; every task ends with a checkpoint (typecheck and tests green). If the user later runs `git init`, commit once per task.
- Install gate: before the first `paseo plugin install`, read `pluginsEnabled` from `/Users/ultima/.paseo/config.json`. If it is not `true`, stop and ask the user for explicit permission with the trusted-code warning from the paseo-plugin skill before enabling it.

## Review Focus

Inputs and conditions the spec implies but does not enumerate, most likely to bite first. Each has a pinning test in the task that owns the code.

- Whitespace-only or oversized message text: rejected with a readable error, nothing stored. (Task 6, `handlers.test.ts`)
- Clock inputs at boundaries: `12am` is 00:00, `12pm` is 12:00, `24:00`, `3:60`, `13pm`, `0am` and bare `3` are rejected with a hint, a time equal to now or under a minute ahead rolls to tomorrow. (Task 3, `parse-when.test.ts`)
- Two messages due for the same agent in one tick: exactly one is sent per tick, earliest first; a later item never overtakes an earlier one that is waiting out a retry backoff. (Task 5, `scheduler.test.ts`)
- Cancel arriving while the scheduler is inspecting the agent: the message is not sent and stays canceled. (Task 5, `scheduler.test.ts`)
- Corrupt, truncated, wrong-version or schema-invalid `queue.json`: moved aside as `queue.corrupt-<timestamp>.json`, plugin starts with an empty queue, no crash. (Task 4, `store.test.ts`)

---

### Task 1: Probe daemon behavior (scratch plugin, spec §8)

Answers the questions the public docs leave open before any dependent code is written. Nothing in the project directory is created except a notes file.

**Files:**
- Create (scratch, outside the project): `/tmp/schedule-probe/` via `paseo plugin init`
- Create: `docs/superpowers/notes/2026-09-30-probe-results.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the observed answers P1–P6 in the notes file. Task 6 reads P3/P4/P5 to finalize `server/gateway.ts`; Task 7 reads P2.

- [ ] **Step 1: Check the install gate**

Run:
```bash
python3 -c "import json;print(json.load(open('/Users/ultima/.paseo/config.json')).get('pluginsEnabled','<absent>'))"
```
Expected: `True`. If anything else, stop and ask the user for permission (see Global Constraints) before continuing.

- [ ] **Step 2: Scaffold the scratch plugin**

Run:
```bash
paseo plugin init /tmp/schedule-probe --id schedule-probe
cd /tmp/schedule-probe && npm install
```
Expected: `init` prints the created path; `npm install` finishes without errors.

- [ ] **Step 3: Replace the scratch server entry with the probe**

Overwrite `/tmp/schedule-probe/index.server.ts` with:

```ts
import os from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPaseo = any;

const show = (value: unknown): string => JSON.stringify(value, null, 2)?.slice(0, 2000) ?? "undefined";

async function inspect(label: string, paseo: AnyPaseo, agentId: string): Promise<void> {
  const handle = paseo.agents.ref(agentId);
  try {
    const result = await handle.refresh();
    console.log(`[probe] ${label} refresh() ->`, show(result));
    console.log(
      `[probe] ${label} handle ->`,
      show({ status: handle.status, archivedAt: handle.archivedAt, activeTurn: handle.activeTurn }),
    );
  } catch (error) {
    console.log(`[probe] ${label} refresh() THREW:`, String(error));
  }
}

export default function contribute(server: PluginServerContext) {
  console.log("[probe] P1 PASEO_HOME =", process.env.PASEO_HOME, "| homedir =", os.homedir());
  let saved: AnyPaseo = null;

  server.on("agent.turn_started", async (event, { paseo }) => {
    saved = paseo;
    await inspect("P4 turn_started", paseo, event.agent.id);
    await inspect("P3 unknown-id", paseo, "does-not-exist");
    setTimeout(() => {
      void inspect("P2 delayed-60s (paseo saved from hook)", saved, event.agent.id);
    }, 60_000);
  });
  server.on("agent.turn_ended", async (event, { paseo }) => {
    await inspect("P6 turn_ended", paseo, event.agent.id);
  });
  server.on("agent.archived", async (event, { paseo }) => {
    await inspect("P5 archived", paseo, event.agent.id);
  });

  return () => {};
}
```

- [ ] **Step 4: Typecheck, install, confirm running**

Run:
```bash
cd /tmp/schedule-probe && npm run typecheck && paseo plugin install /tmp/schedule-probe && paseo plugin ls
```
Expected: typecheck clean; `schedule-probe` listed as `running`. If it is not `running`, run `paseo plugin logs schedule-probe`, fix the probe, `paseo plugin reload schedule-probe`.

- [ ] **Step 5: Create a throwaway agent and drive the lifecycle**

Run (one short turn; negligible quota):
```bash
mkdir -p /tmp/paseo-probe-cwd
paseo run "Reply with the single word OK" --provider claude --title schedule-probe -d --cwd /tmp/paseo-probe-cwd
```
Note the printed agent id as `<PROBE_ID>`. Then:
```bash
paseo wait <PROBE_ID>
sleep 75
paseo archive <PROBE_ID>
sleep 5
paseo plugin logs schedule-probe
```
Expected: log lines tagged `[probe] P1`, `P4 turn_started`, `P3 unknown-id`, `P6 turn_ended`, `P2 delayed-60s`, `P5 archived`.

- [ ] **Step 6: Record the answers**

Create `docs/superpowers/notes/2026-09-30-probe-results.md` with this table filled from the log (paste real values, not the expectations):

```markdown
# Probe results — 2026-09-30

| # | Question | Observed |
| --- | --- | --- |
| P1 | `process.env.PASEO_HOME` in plugin subprocess | <value or unset>; homedir <value> |
| P2 | `paseo` saved from a hook still works 60 s later | <ok / THREW: message> |
| P3 | `refresh()` on an unknown agent id | <returns null / returns X / THREW: exact message> |
| P4 | handle at `turn_started` | status=<..> activeTurn=<..> archivedAt=<..> |
| P5 | handle at `archived` | status=<..> activeTurn=<..> archivedAt=<..> |
| P6 | handle at `turn_ended` | status=<..> activeTurn=<..> archivedAt=<..> |
| — | shape of a successful `refresh()` result (top-level keys) | <keys> |
```

Apply this decision table:

| Result | Action |
| --- | --- |
| P2 THREW | **Stop and report to the user.** The daemon-owned timer design needs rethinking (e.g. a direct `@getpaseo/client` connection). Do not continue to Task 2. |
| P4 shows neither `activeTurn` non-null nor `status` `running` while the turn is in flight | **Stop and report.** Busy detection needs a different source (in-memory tracking from `turn_started`/`turn_ended`). |
| P3 THREW with a message not matching `/not found\|unknown agent\|no such agent/i` | In Task 6 change the `NOT_FOUND` regex in `server/gateway.ts` (and its test) to match the observed message. |
| P5 `archivedAt` is null for an archived agent | In Task 6 adapt `inspect` to the field that does signal archival. |
| P6 still busy at `turn_ended` | No change; note it. The 10 s interval tick covers it. |
| P1 anything | No change; `resolveDataDir` handles set and unset. |

- [ ] **Step 7: Remove the probe**

Run:
```bash
paseo plugin remove schedule-probe
rm -rf /tmp/paseo-probe-cwd
```
Expected: `paseo plugin ls` no longer lists `schedule-probe`. (`/tmp/schedule-probe` source may stay; it is outside the project.)

**Checkpoint:** notes file exists with all seven rows filled and no Stop condition triggered.

---

### Task 2: Scaffold the project, test tooling, shared model and RPC contracts

**Files:**
- Create (via `paseo plugin init`): `paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.client.tsx`, `index.server.ts`, `client/web.ts`, and the greeting sample files (deleted below)
- Modify: `paseo-plugin.json`, `package.json`, `index.client.tsx`, `index.server.ts`
- Delete: `client/greeting.tsx`, `server/greeting.ts`, `shared/greeting.ts`
- Create: `shared/model.ts`, `shared/rpc.ts`
- Test: `shared/model.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`shared/model.ts`): constants `MAX_TEXT_LENGTH`, `MAX_HORIZON_MS`, `PAST_GRACE_MS`, `MIN_LEAD_MS`, `HISTORY_RETENTION_MS`, `MAX_ATTEMPTS`, `BACKOFF_MS`; `scheduleStatusSchema`; `scheduledMessageSchema`; `queueFileSchema`; types `ScheduleStatus`, `ScheduledMessage`.
- Produces (`shared/rpc.ts`): `addScheduleRpc` (`schedule.add`), `listScheduleRpc` (`schedule.list`), `cancelScheduleRpc` (`schedule.cancel`).

- [ ] **Step 1: Scaffold into the project directory**

Run:
```bash
cd /Users/ultima/Workspace/paseo-plugins/schdule-sending
paseo plugin init /Users/ultima/Workspace/paseo-plugins/schdule-sending --id schedule-sending
```
If `init` refuses because the directory is not empty (it holds `docs/`), scaffold elsewhere and copy:
```bash
paseo plugin init /tmp/schedule-sending-scaffold --id schedule-sending
cp -R /tmp/schedule-sending-scaffold/. /Users/ultima/Workspace/paseo-plugins/schdule-sending/
```
Expected: `paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/` exist next to the existing `docs/`.

- [ ] **Step 2: Install and inspect the scaffold**

Run:
```bash
cd /Users/ultima/Workspace/paseo-plugins/schdule-sending
npm install
cat paseo-plugin.json package.json tsconfig.json
```
Confirm: manifest `id` is `schedule-sending` and `requirements.paseo` is `>=0.10.1` (or the version `init` wrote); `package.json` has a `typecheck` script; `tsconfig.json` does not include `"DOM"` in `lib`.

- [ ] **Step 3: Add test tooling and manifest description**

Run:
```bash
npm pkg get devDependencies.vitest devDependencies.zod devDependencies.@types/node
```
For each of these that prints `{}` (missing) install it: `npm install -D vitest@^4.1.6`, `npm install -D zod@^4.4.3`, `npm install -D @types/node@^20.9.0`. Then:
```bash
npm pkg set scripts.test="vitest run"
```
Edit `paseo-plugin.json` to add the description, keeping `id` and `requirements` exactly as `init` wrote them:
```json
{
  "id": "schedule-sending",
  "description": "Schedule a message into an existing agent chat",
  "requirements": { "paseo": ">=0.10.1" }
}
```
(Keep the `requirements.paseo` value that `init` wrote if it differs from `>=0.10.1`.)

- [ ] **Step 4: Remove the greeting sample and stub both entries**

Run:
```bash
rm client/greeting.tsx server/greeting.ts shared/greeting.ts
```
Overwrite `index.client.tsx`:
```tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(_client: PluginClientContext) {
  return () => {};
}
```
Overwrite `index.server.ts`:
```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(_server: PluginServerContext) {
  return () => {};
}
```
Run `npm run typecheck`. Expected: PASS. (If `client/web.ts` fails typecheck without the greeting file, leave it untouched and investigate; it must not be deleted unless it is unreferenced and failing.)

- [ ] **Step 5: Write the failing model test**

Create `shared/model.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MAX_TEXT_LENGTH, queueFileSchema, scheduledMessageSchema } from "./model";

const valid = {
  id: "a",
  agentId: "agent-1",
  text: "hello",
  fireAt: 1_000,
  createdAt: 500,
  status: "pending",
  attempts: 0,
} as const;

describe("scheduledMessageSchema", () => {
  it("accepts a minimal pending item", () => {
    expect(scheduledMessageSchema.parse(valid)).toEqual(valid);
  });

  it("rejects empty text", () => {
    expect(scheduledMessageSchema.safeParse({ ...valid, text: "" }).success).toBe(false);
  });

  it("rejects text over the limit", () => {
    const text = "x".repeat(MAX_TEXT_LENGTH + 1);
    expect(scheduledMessageSchema.safeParse({ ...valid, text }).success).toBe(false);
  });

  it("accepts text exactly at the limit", () => {
    const text = "x".repeat(MAX_TEXT_LENGTH);
    expect(scheduledMessageSchema.safeParse({ ...valid, text }).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(scheduledMessageSchema.safeParse({ ...valid, status: "paused" }).success).toBe(false);
  });

  it("rejects a non-integer fireAt", () => {
    expect(scheduledMessageSchema.safeParse({ ...valid, fireAt: 1.5 }).success).toBe(false);
  });
});

describe("queueFileSchema", () => {
  it("accepts an empty version 1 queue", () => {
    expect(queueFileSchema.safeParse({ version: 1, items: [] }).success).toBe(true);
  });

  it("rejects any other version", () => {
    expect(queueFileSchema.safeParse({ version: 2, items: [] }).success).toBe(false);
  });

  it("rejects a queue containing an invalid item", () => {
    const broken = { ...valid, agentId: undefined };
    expect(queueFileSchema.safeParse({ version: 1, items: [broken] }).success).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- shared/model.test.ts`
Expected: FAIL, cannot resolve `./model`.

- [ ] **Step 7: Implement `shared/model.ts`**

```ts
import { z } from "zod";

export const MAX_TEXT_LENGTH = 10_000;
export const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
export const PAST_GRACE_MS = 5 * 60 * 1000;
export const MIN_LEAD_MS = 60 * 1000;
export const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Delay after failed attempt n (1-based). The fifth failure is final, so it has no delay. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

export const scheduleStatusSchema = z.enum(["pending", "sent", "failed", "canceled"]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduledMessageSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  fireAt: z.number().int(),
  createdAt: z.number().int(),
  status: scheduleStatusSchema,
  attempts: z.number().int().min(0),
  nextAttemptAt: z.number().int().optional(),
  lastError: z.string().optional(),
  sentAt: z.number().int().optional(),
  finishedAt: z.number().int().optional(),
});
export type ScheduledMessage = z.infer<typeof scheduledMessageSchema>;

export const queueFileSchema = z.object({
  version: z.literal(1),
  items: z.array(scheduledMessageSchema),
});
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- shared/model.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Write the RPC contracts**

Create `shared/rpc.ts`:
```ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MAX_TEXT_LENGTH, scheduledMessageSchema } from "./model";

export const addScheduleRpc = defineRpc({
  name: "schedule.add",
  input: z.object({
    agentId: z.string().min(1),
    text: z.string().min(1).max(MAX_TEXT_LENGTH),
    fireAt: z.number().int(),
  }),
  output: z.object({ item: scheduledMessageSchema }),
});

export const listScheduleRpc = defineRpc({
  name: "schedule.list",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ items: z.array(scheduledMessageSchema) }),
});

export const cancelScheduleRpc = defineRpc({
  name: "schedule.cancel",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ item: scheduledMessageSchema.nullable() }),
});
```

- [ ] **Step 10: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: both PASS.

---

### Task 3: Time grammar, formatting and view-model helpers (client, pure)

**Files:**
- Create: `client/parse-when.ts`, `client/format.ts`, `client/view-model.ts`
- Test: `client/parse-when.test.ts`, `client/format.test.ts`, `client/view-model.test.ts`

**Interfaces:**
- Consumes: `MIN_LEAD_MS`, `MAX_HORIZON_MS`, `MAX_ATTEMPTS`, `ScheduledMessage` from `../shared/model`.
- Produces:
  - `parseWhen(input: string, now: number): ParseWhenResult` where `ParseWhenResult = { ok: true; fireAt: number } | { ok: false; error: string }`.
  - `formatClock(ts: number): string` (`"03:05"`), `formatDelta(ms: number): string` (`"5h 12m"`), `formatFireTime(fireAt: number, now: number): string` (`"Tomorrow 03:00"`).
  - `previewText(text: string): string`, `describeItem(item: ScheduledMessage, now: number): ItemRow`, `previewLine(when: string, parsed: ParseWhenResult, now: number): { text: string; isError: boolean }`, `canSchedule(text: string, parsed: ParseWhenResult): boolean`; types `RowTone = "muted" | "success" | "warning" | "danger"`, `ItemRow = { id: string; preview: string; detail: string; tone: RowTone; cancellable: boolean }`.

- [ ] **Step 1: Write the failing `parse-when` tests**

Create `client/parse-when.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseWhen } from "./parse-when";

/** Local wall-clock time on 30 Sep 2026 plus dayOffset days. Tests never depend on the machine's timezone. */
const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 8, 30 + dayOffset, hour, minute, 0, 0).getTime();

const NOW = at(22, 0);

function fireOf(input: string, now = NOW): number {
  const result = parseWhen(input, now);
  if (!result.ok) throw new Error(`expected ok for "${input}", got error: ${result.error}`);
  return result.fireAt;
}

function errorOf(input: string, now = NOW): string {
  const result = parseWhen(input, now);
  if (result.ok) throw new Error(`expected error for "${input}", got ${new Date(result.fireAt).toString()}`);
  return result.error;
}

describe("relative durations", () => {
  it("parses 'in 5h'", () => expect(fireOf("in 5h")).toBe(NOW + 5 * 3_600_000));
  it("parses '+5h'", () => expect(fireOf("+5h")).toBe(NOW + 5 * 3_600_000));
  it("parses 'in 90m'", () => expect(fireOf("in 90m")).toBe(NOW + 90 * 60_000));
  it("parses 'in 1h30m'", () => expect(fireOf("in 1h30m")).toBe(NOW + 90 * 60_000));
  it("ignores case and inner spaces", () => expect(fireOf("  IN 1h 30M ")).toBe(NOW + 90 * 60_000));
  it("accepts long unit names", () => expect(fireOf("in 2 hours")).toBe(NOW + 2 * 3_600_000));
  it("rejects a zero duration as too soon", () => expect(errorOf("in 0m")).toMatch(/at least 1 minute/));
  it("rejects more than 30 days", () => expect(errorOf("in 800h")).toMatch(/30 days/));
  it("rejects a bare 'in'", () => expect(errorOf("in")).toMatch(/Can't parse/));
  it("rejects a duration without a unit", () => expect(errorOf("in 5")).toMatch(/Can't parse/));
});

describe("clock times", () => {
  it("rolls 3am to tomorrow when it is 22:00", () => expect(fireOf("3am")).toBe(at(3, 0, 1)));
  it("keeps 3am today when it is 01:00", () => expect(fireOf("3am", at(1, 0))).toBe(at(3, 0)));
  it("parses 3:30pm", () => expect(fireOf("3:30pm")).toBe(at(15, 30, 1)));
  it("parses 24-hour 15:30", () => expect(fireOf("15:30")).toBe(at(15, 30, 1)));
  it("keeps a later time today", () => expect(fireOf("23:30")).toBe(at(23, 30)));
  it("accepts a space before am/pm and uppercase", () => expect(fireOf("3:00 PM")).toBe(at(15, 0, 1)));
  it("trims surrounding whitespace", () => expect(fireOf("  3am  ")).toBe(at(3, 0, 1)));
  it("treats the current minute as tomorrow", () => expect(fireOf("22:00")).toBe(at(22, 0, 1)));
  it("treats a time under one minute ahead as tomorrow", () =>
    expect(fireOf("22:00", at(21, 59) + 30_000)).toBe(at(22, 0, 1)));
  it("treats a time exactly one minute ahead as today", () =>
    expect(fireOf("22:00", at(21, 59))).toBe(at(22, 0)));
});

describe("12-hour boundaries", () => {
  it("12am is midnight", () => expect(fireOf("12am")).toBe(at(0, 0, 1)));
  it("12:30am is half past midnight", () => expect(fireOf("12:30am")).toBe(at(0, 30, 1)));
  it("12pm is noon (tomorrow at 22:00)", () => expect(fireOf("12pm")).toBe(at(12, 0, 1)));
  it("12pm is noon today when it is 01:00", () => expect(fireOf("12pm", at(1, 0))).toBe(at(12, 0)));
  it("00:00 is midnight", () => expect(fireOf("00:00")).toBe(at(0, 0, 1)));
});

describe("rejections", () => {
  it.each(["24:00", "3:60", "13pm", "0am", "3", "15", "tomorrow", "banana", "3::00", "1:2am"])(
    "rejects %s with a hint",
    (input) => expect(errorOf(input)).toMatch(/Can't parse .*Try 3am, 15:30 or in 5h/),
  );
  it("rejects empty input", () => expect(errorOf("")).toMatch(/Enter a time/));
  it("rejects whitespace-only input", () => expect(errorOf("   ")).toMatch(/Enter a time/));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- client/parse-when.test.ts`
Expected: FAIL, cannot resolve `./parse-when`.

- [ ] **Step 3: Implement `client/parse-when.ts`**

```ts
import { MAX_HORIZON_MS, MIN_LEAD_MS } from "../shared/model";

export type ParseWhenResult = { ok: true; fireAt: number } | { ok: false; error: string };

const HINT = "Try 3am, 15:30 or in 5h";
const RELATIVE = /^(?:in|\+)\s*(?:(\d+)\s*(?:h|hrs?|hours?))?\s*(?:(\d+)\s*(?:m|mins?|minutes?))?$/;
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

function fail(error: string): ParseWhenResult {
  return { ok: false, error };
}

function check(fireAt: number, now: number): ParseWhenResult {
  if (fireAt < now + MIN_LEAD_MS) return fail("Pick a time at least 1 minute ahead");
  if (fireAt > now + MAX_HORIZON_MS) return fail("Too far ahead (max 30 days)");
  return { ok: true, fireAt };
}

function nextClockOccurrence(
  hourInput: number,
  minuteInput: number | undefined,
  meridiem: string | undefined,
  now: number,
): number | undefined {
  const minute = minuteInput ?? 0;
  if (minute > 59) return undefined;

  let hour: number;
  if (meridiem === undefined) {
    // A bare "3" is ambiguous; 24-hour times must include minutes.
    if (minuteInput === undefined || hourInput > 23) return undefined;
    hour = hourInput;
  } else {
    if (hourInput < 1 || hourInput > 12) return undefined;
    hour = (hourInput % 12) + (meridiem === "pm" ? 12 : 0);
  }

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < now + MIN_LEAD_MS) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

export function parseWhen(input: string, now: number): ParseWhenResult {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") return fail("Enter a time, e.g. 3am or in 5h");

  const relative = RELATIVE.exec(text);
  if (relative !== null && (relative[1] !== undefined || relative[2] !== undefined)) {
    const hours = Number(relative[1] ?? 0);
    const minutes = Number(relative[2] ?? 0);
    return check(now + hours * 3_600_000 + minutes * 60_000, now);
  }

  const clock = CLOCK.exec(text);
  if (clock !== null) {
    const minute = clock[2] === undefined ? undefined : Number(clock[2]);
    const fireAt = nextClockOccurrence(Number(clock[1]), minute, clock[3], now);
    if (fireAt !== undefined) return check(fireAt, now);
  }

  return fail(`Can't parse "${input.trim()}". ${HINT}`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- client/parse-when.test.ts`
Expected: PASS (all cases). If `"1:2am"` unexpectedly parses, the `CLOCK` regex's `\d{2}` minute group is wrong; it must require two digits.

- [ ] **Step 5: Write the failing `format` tests**

Create `client/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatClock, formatDelta, formatFireTime } from "./format";

const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 8, 30 + dayOffset, hour, minute, 0, 0).getTime();

describe("formatClock", () => {
  it("pads hours and minutes", () => expect(formatClock(at(3, 5))).toBe("03:05"));
  it("uses 24-hour time", () => expect(formatClock(at(15, 30))).toBe("15:30"));
});

describe("formatDelta", () => {
  it("shows under a minute", () => {
    expect(formatDelta(0)).toBe("<1m");
    expect(formatDelta(59_999)).toBe("<1m");
  });
  it("clamps negative values", () => expect(formatDelta(-5_000)).toBe("<1m"));
  it("shows minutes", () => expect(formatDelta(45 * 60_000)).toBe("45m"));
  it("shows whole hours", () => expect(formatDelta(5 * 3_600_000)).toBe("5h"));
  it("shows hours and minutes", () => expect(formatDelta((5 * 60 + 12) * 60_000)).toBe("5h 12m"));
  it("shows days and hours", () => expect(formatDelta(25 * 3_600_000)).toBe("1d 1h"));
});

describe("formatFireTime", () => {
  it("labels the same day Today", () => expect(formatFireTime(at(23, 30), at(22))).toBe("Today 23:30"));
  it("labels the next day Tomorrow", () => expect(formatFireTime(at(3, 0, 1), at(22))).toBe("Tomorrow 03:00"));
  it("labels later days with weekday and date", () =>
    expect(formatFireTime(at(3, 0, 3), at(22))).toBe("Sat 3 Oct 03:00"));
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- client/format.test.ts`
Expected: FAIL, cannot resolve `./format`.

- [ ] **Step 7: Implement `client/format.ts`**

```ts
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

const pad = (value: number): string => String(value).padStart(2, "0");

// Plain getters instead of Intl: keeps output identical on every React Native runtime.
export function formatClock(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDelta(ms: number): string {
  if (ms < 60_000) return "<1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatFireTime(fireAt: number, now: number): string {
  const dayDiff = Math.round((startOfDay(fireAt) - startOfDay(now)) / DAY_MS);
  const date = new Date(fireAt);
  let label: string;
  if (dayDiff === 0) label = "Today";
  else if (dayDiff === 1) label = "Tomorrow";
  else label = `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return `${label} ${formatClock(fireAt)}`;
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- client/format.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing `view-model` tests**

Create `client/view-model.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ScheduledMessage } from "../shared/model";
import { parseWhen } from "./parse-when";
import { canSchedule, describeItem, previewLine, previewText } from "./view-model";

const at = (hour: number, minute = 0, dayOffset = 0): number =>
  new Date(2026, 8, 30 + dayOffset, hour, minute, 0, 0).getTime();
const NOW = at(22, 0);

const base: ScheduledMessage = {
  id: "m1",
  agentId: "agent-1",
  text: "run the tests",
  fireAt: at(3, 0, 1),
  createdAt: at(21, 0),
  status: "pending",
  attempts: 0,
};

describe("previewText", () => {
  it("collapses whitespace and newlines", () => expect(previewText("a\n\n  b\tc")).toBe("a b c"));
  it("truncates long text to 120 characters with an ellipsis", () => {
    const result = previewText("x".repeat(500));
    expect(result).toHaveLength(120);
    expect(result.endsWith("…")).toBe(true);
  });
  it("leaves exactly 120 characters alone", () => expect(previewText("y".repeat(120))).toBe("y".repeat(120)));
});

describe("describeItem", () => {
  it("shows a future pending item with its fire time", () => {
    expect(describeItem(base, NOW)).toEqual({
      id: "m1",
      preview: "run the tests",
      detail: "Tomorrow 03:00",
      tone: "muted",
      cancellable: true,
    });
  });

  it("flags a pending item that is already due", () => {
    const row = describeItem({ ...base, fireAt: NOW - 1 }, NOW);
    expect(row.detail).toBe("Due · waiting to send");
    expect(row.tone).toBe("warning");
    expect(row.cancellable).toBe(true);
  });

  it("shows retry progress with the last error", () => {
    const row = describeItem({ ...base, fireAt: NOW - 1, attempts: 2, lastError: "socket closed" }, NOW);
    expect(row.detail).toBe("Retry 2/5 · socket closed");
    expect(row.tone).toBe("warning");
  });

  it("shows a sent item as not cancellable", () => {
    const row = describeItem({ ...base, status: "sent", sentAt: at(3, 0, 1) }, at(8, 0, 1));
    expect(row).toMatchObject({ detail: "Sent Today 03:00", tone: "success", cancellable: false });
  });

  it("shows a failed item with its reason", () => {
    const row = describeItem({ ...base, status: "failed", lastError: "Agent archived" }, NOW);
    expect(row).toMatchObject({ detail: "Failed · Agent archived", tone: "danger", cancellable: false });
  });

  it("falls back when a failed item has no reason", () => {
    expect(describeItem({ ...base, status: "failed" }, NOW).detail).toBe("Failed · unknown error");
  });

  it("shows a canceled item", () => {
    expect(describeItem({ ...base, status: "canceled" }, NOW)).toMatchObject({
      detail: "Canceled",
      tone: "muted",
      cancellable: false,
    });
  });
});

describe("previewLine", () => {
  it("shows a hint for empty input", () => {
    expect(previewLine("", parseWhen("", NOW), NOW)).toEqual({ text: "e.g. 3am, 15:30 or in 5h", isError: false });
  });

  it("shows the resolved time and delta", () => {
    const line = previewLine("in 5h", parseWhen("in 5h", NOW), NOW);
    expect(line).toEqual({ text: "Fires Tomorrow 03:00 · in 5h", isError: false });
  });

  it("shows the parse error", () => {
    const line = previewLine("banana", parseWhen("banana", NOW), NOW);
    expect(line.isError).toBe(true);
    expect(line.text).toMatch(/Can't parse/);
  });
});

describe("canSchedule", () => {
  it("requires non-blank text and a valid time", () => {
    const ok = parseWhen("in 5h", NOW);
    const bad = parseWhen("banana", NOW);
    expect(canSchedule("hello", ok)).toBe(true);
    expect(canSchedule("   ", ok)).toBe(false);
    expect(canSchedule("hello", bad)).toBe(false);
  });
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `npm test -- client/view-model.test.ts`
Expected: FAIL, cannot resolve `./view-model`.

- [ ] **Step 11: Implement `client/view-model.ts`**

```ts
import { MAX_ATTEMPTS, type ScheduledMessage } from "../shared/model";
import { formatDelta, formatFireTime } from "./format";
import type { ParseWhenResult } from "./parse-when";

export type RowTone = "muted" | "success" | "warning" | "danger";

export interface ItemRow {
  id: string;
  preview: string;
  detail: string;
  tone: RowTone;
  cancellable: boolean;
}

const PREVIEW_MAX = 120;

export function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export function describeItem(item: ScheduledMessage, now: number): ItemRow {
  const base = { id: item.id, preview: previewText(item.text) };
  switch (item.status) {
    case "pending":
      if (item.attempts > 0) {
        const reason = item.lastError ?? "send failed";
        return { ...base, detail: `Retry ${item.attempts}/${MAX_ATTEMPTS} · ${reason}`, tone: "warning", cancellable: true };
      }
      if (item.fireAt <= now) {
        return { ...base, detail: "Due · waiting to send", tone: "warning", cancellable: true };
      }
      return { ...base, detail: formatFireTime(item.fireAt, now), tone: "muted", cancellable: true };
    case "sent":
      return { ...base, detail: `Sent ${formatFireTime(item.sentAt ?? item.fireAt, now)}`, tone: "success", cancellable: false };
    case "failed":
      return { ...base, detail: `Failed · ${item.lastError ?? "unknown error"}`, tone: "danger", cancellable: false };
    case "canceled":
      return { ...base, detail: "Canceled", tone: "muted", cancellable: false };
  }
}

export function previewLine(
  when: string,
  parsed: ParseWhenResult,
  now: number,
): { text: string; isError: boolean } {
  if (when.trim() === "") return { text: "e.g. 3am, 15:30 or in 5h", isError: false };
  if (!parsed.ok) return { text: parsed.error, isError: true };
  return {
    text: `Fires ${formatFireTime(parsed.fireAt, now)} · in ${formatDelta(parsed.fireAt - now)}`,
    isError: false,
  };
}

export function canSchedule(text: string, parsed: ParseWhenResult): boolean {
  return text.trim().length > 0 && parsed.ok;
}
```

- [ ] **Step 12: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: PASS. Run the client audit; expected no output:
```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/ --glob '!client/web.ts' --glob '!*.test.ts'
```

---

### Task 4: Logger and queue store (server)

**Files:**
- Create: `server/logger.ts`, `server/store.ts`
- Test: `server/store.test.ts`

**Interfaces:**
- Consumes: `ScheduledMessage`, `queueFileSchema`, `HISTORY_RETENTION_MS` from `../shared/model`.
- Produces:
  - `server/logger.ts`: `interface Logger { info(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void }`; `consoleLogger: Logger`.
  - `server/store.ts`: `interface QueueStore { load(): Promise<void>; list(): ScheduledMessage[]; get(id: string): ScheduledMessage | undefined; add(item: ScheduledMessage): Promise<void>; update(id: string, change: (item: ScheduledMessage) => ScheduledMessage): Promise<ScheduledMessage | undefined>; prune(now: number): Promise<void> }`; `createFileStore(options: { dir: string; now: () => number; log: Logger }): QueueStore`; `resolveDataDir(env: Record<string, string | undefined>, home: string): string`.

- [ ] **Step 1: Write the logger**

Create `server/logger.ts`:
```ts
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const PREFIX = "[schedule-sending]";

// Callers pass ids, counts and statuses only. Never message text: plugin output is retained in daemon.log.
export const consoleLogger: Logger = {
  info: (message, fields) => console.log(PREFIX, message, fields ?? ""),
  error: (message, fields) => console.error(PREFIX, message, fields ?? ""),
};
```

- [ ] **Step 2: Write the failing store tests**

Create `server/store.test.ts`:
```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_RETENTION_MS, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";
import { createFileStore, resolveDataDir } from "./store";

const errors: string[] = [];
const recording: Logger = {
  info() {},
  error: (message) => {
    errors.push(message);
  },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "schedule-store-"));
  errors.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const item = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: "a",
  agentId: "agent-1",
  text: "hi",
  fireAt: 1_000,
  createdAt: 0,
  status: "pending",
  attempts: 0,
  ...over,
});

const make = (now: () => number = () => 10_000) => createFileStore({ dir, now, log: recording });

describe("resolveDataDir", () => {
  it("uses PASEO_HOME when set", () => {
    expect(resolveDataDir({ PASEO_HOME: "/data/paseo" }, "/home/u")).toBe(
      path.join("/data/paseo", "plugin-data", "schedule-sending"),
    );
  });

  it("falls back to ~/.paseo when PASEO_HOME is unset or empty", () => {
    const expected = path.join("/home/u", ".paseo", "plugin-data", "schedule-sending");
    expect(resolveDataDir({}, "/home/u")).toBe(expected);
    expect(resolveDataDir({ PASEO_HOME: "" }, "/home/u")).toBe(expected);
  });
});

describe("file store", () => {
  it("starts empty when the file is missing", async () => {
    const store = make();
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it("persists added items across a fresh instance", async () => {
    const first = make();
    await first.load();
    await first.add(item({ id: "a" }));
    await first.add(item({ id: "b", text: "second" }));

    const second = make();
    await second.load();
    expect(second.list().map((i) => i.id)).toEqual(["a", "b"]);
    expect(second.get("b")?.text).toBe("second");
  });

  it("updates and persists a patch, and returns undefined for an unknown id", async () => {
    const store = make();
    await store.load();
    await store.add(item());
    const updated = await store.update("a", (current) => ({ ...current, attempts: 3 }));
    expect(updated?.attempts).toBe(3);
    expect(await store.update("missing", (current) => current)).toBeUndefined();

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.get("a")?.attempts).toBe(3);
  });

  it("leaves no temp files behind", async () => {
    const store = make();
    await store.load();
    await store.add(item());
    expect(await readdir(dir)).toEqual(["queue.json"]);
  });

  it("keeps every item when many writes are issued concurrently", async () => {
    const store = make();
    await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.add(item({ id: `id-${index}` }))));

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(20);
  });

  it("returns copies so callers cannot mutate stored state", async () => {
    const store = make();
    await store.load();
    await store.add(item());
    store.list()[0]!.text = "tampered";
    expect(store.get("a")!.text).toBe("hi");
  });

  it("prunes finished items past retention and keeps the rest", async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const store = make(() => now);
    await store.load();
    await store.add(item({ id: "old-pending", createdAt: 0 }));
    await store.add(item({ id: "old-sent", status: "sent", finishedAt: now - HISTORY_RETENTION_MS - 1 }));
    await store.add(item({ id: "edge-sent", status: "sent", finishedAt: now - HISTORY_RETENTION_MS }));
    await store.add(item({ id: "new-failed", status: "failed", finishedAt: now - 1_000 }));
    await store.prune(now);
    expect(store.list().map((i) => i.id).sort()).toEqual(["edge-sent", "new-failed", "old-pending"]);
  });
});

describe("corrupt files", () => {
  const cases: Array<[string, string]> = [
    ["invalid JSON", "{not json"],
    ["truncated JSON", '{"version":1,"items":[{"id":"a"'],
    ["wrong version", JSON.stringify({ version: 2, items: [] })],
    ["schema-invalid item", JSON.stringify({ version: 1, items: [{ id: "a" }] })],
  ];

  it.each(cases)("quarantines %s and starts empty", async (_name, contents) => {
    await writeFile(path.join(dir, "queue.json"), contents, "utf8");
    const store = make(() => 12_345);
    await store.load();

    expect(store.list()).toEqual([]);
    expect(errors).toHaveLength(1);
    const files = await readdir(dir);
    expect(files).toEqual(["queue.corrupt-12345.json"]);
    expect(await readFile(path.join(dir, "queue.corrupt-12345.json"), "utf8")).toBe(contents);

    await store.add(item());
    const reloaded = make();
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- server/store.test.ts`
Expected: FAIL, cannot resolve `./store`.

- [ ] **Step 4: Implement `server/store.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HISTORY_RETENTION_MS, queueFileSchema, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";

export interface QueueStore {
  load(): Promise<void>;
  list(): ScheduledMessage[];
  get(id: string): ScheduledMessage | undefined;
  add(item: ScheduledMessage): Promise<void>;
  update(
    id: string,
    change: (item: ScheduledMessage) => ScheduledMessage,
  ): Promise<ScheduledMessage | undefined>;
  prune(now: number): Promise<void>;
}

export function resolveDataDir(env: Record<string, string | undefined>, home: string): string {
  const base = env.PASEO_HOME !== undefined && env.PASEO_HOME !== "" ? env.PASEO_HOME : path.join(home, ".paseo");
  return path.join(base, "plugin-data", "schedule-sending");
}

function parseQueue(raw: string): ScheduledMessage[] | undefined {
  try {
    const result = queueFileSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data.items : undefined;
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function createFileStore(options: { dir: string; now: () => number; log: Logger }): QueueStore {
  const { dir, now, log } = options;
  const file = path.join(dir, "queue.json");
  let items: ScheduledMessage[] = [];
  let writeChain: Promise<void> = Promise.resolve();

  // The snapshot is taken when the write is queued; writes run one at a time, so the last one wins.
  function persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, items });
    const write = writeChain.then(async () => {
      await mkdir(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, file);
    });
    writeChain = write.catch(() => undefined);
    return write;
  }

  async function quarantine(): Promise<void> {
    const target = path.join(dir, `queue.corrupt-${now()}.json`);
    await rename(file, target);
    log.error("queue file unreadable; moved aside and starting empty", { target });
  }

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (isNotFound(error)) {
          items = [];
          return;
        }
        throw error;
      }
      const parsed = parseQueue(raw);
      if (parsed === undefined) {
        await quarantine();
        items = [];
        return;
      }
      items = parsed;
    },

    list: () => items.map((item) => ({ ...item })),

    get(id) {
      const found = items.find((item) => item.id === id);
      return found === undefined ? undefined : { ...found };
    },

    async add(item) {
      items.push({ ...item });
      try {
        await persist();
      } catch (error) {
        items = items.filter((existing) => existing.id !== item.id);
        throw error;
      }
    },

    async update(id, change) {
      const index = items.findIndex((item) => item.id === id);
      const current = items[index];
      if (current === undefined) return undefined;
      const next = change({ ...current });
      items[index] = next;
      await persist();
      return { ...next };
    },

    async prune(cutoffNow) {
      const before = items.length;
      items = items.filter(
        (item) => item.status === "pending" || cutoffNow - (item.finishedAt ?? item.createdAt) <= HISTORY_RETENTION_MS,
      );
      if (items.length !== before) await persist();
    },
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- server/store.test.ts`
Expected: PASS (all cases, including the four corrupt-file variants).

- [ ] **Step 6: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: PASS.

---

### Task 5: Scheduler (server)

**Files:**
- Create: `server/scheduler.ts`
- Test: `server/scheduler.test.ts`

**Interfaces:**
- Consumes: `BACKOFF_MS`, `MAX_ATTEMPTS`, `ScheduledMessage` from `../shared/model`; `Logger` from `./logger`; `QueueStore`, `createFileStore` from `./store`.
- Produces (`server/scheduler.ts`): `TICK_MS = 10_000`; `type AgentState = "idle" | "busy" | "missing" | "archived"`; `interface AgentGateway { inspect(agentId: string): Promise<AgentState>; send(agentId: string, text: string): Promise<void> }`; `interface SchedulerDeps { store: QueueStore; now: () => number; log: Logger; getGateway: () => AgentGateway | null }`; `interface Scheduler { tick(): Promise<void>; start(intervalMs?: number): void; stop(): void }`; `createScheduler(deps: SchedulerDeps): Scheduler`.

- [ ] **Step 1: Write the failing scheduler tests**

Create `server/scheduler.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, HISTORY_RETENTION_MS, MAX_ATTEMPTS, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";
import { createScheduler, type AgentGateway, type AgentState } from "./scheduler";
import { createFileStore, type QueueStore } from "./store";

const SECRET = "the-secret-message-body";
const logged: string[] = [];
const recording: Logger = {
  info: (message, fields) => {
    logged.push(JSON.stringify([message, fields]));
  },
  error: (message, fields) => {
    logged.push(JSON.stringify([message, fields]));
  },
};

class FakeGateway implements AgentGateway {
  states = new Map<string, AgentState>();
  sent: Array<{ agentId: string; text: string }> = [];
  sendError: Error | null = null;
  inspectError: Error | null = null;
  beforeInspect: (() => Promise<void>) | null = null;

  async inspect(agentId: string): Promise<AgentState> {
    if (this.beforeInspect) await this.beforeInspect();
    if (this.inspectError) throw this.inspectError;
    return this.states.get(agentId) ?? "idle";
  }

  async send(agentId: string, text: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ agentId, text });
  }
}

let dir: string;
let clock: number;
let store: QueueStore;

const pending = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: "m1",
  agentId: "agent-1",
  text: SECRET,
  fireAt: clock - 1,
  createdAt: clock - 10_000,
  status: "pending",
  attempts: 0,
  ...over,
});

const makeScheduler = (gateway: AgentGateway | null) =>
  createScheduler({ store, now: () => clock, log: recording, getGateway: () => gateway });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "schedule-scheduler-"));
  clock = 1_800_000_000_000;
  logged.length = 0;
  store = createFileStore({ dir, now: () => clock, log: recording });
  await store.load();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("delivery", () => {
  it("sends a due item when the agent is idle and records it as sent", async () => {
    const gateway = new FakeGateway();
    await store.add(pending());
    await makeScheduler(gateway).tick();

    expect(gateway.sent).toEqual([{ agentId: "agent-1", text: SECRET }]);
    expect(store.get("m1")).toMatchObject({ status: "sent", sentAt: clock, finishedAt: clock });
  });

  it("does not send before fireAt", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ fireAt: clock + 60_000 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")!.status).toBe("pending");
  });

  it("does nothing while no gateway is available", async () => {
    await store.add(pending());
    await makeScheduler(null).tick();
    expect(store.get("m1")!.status).toBe("pending");
  });

  it("delivers an item that became overdue long ago instead of dropping it", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ fireAt: clock - 3 * 24 * 60 * 60 * 1000 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toHaveLength(1);
  });

  it("never logs the message text", async () => {
    const gateway = new FakeGateway();
    await store.add(pending());
    await makeScheduler(gateway).tick();
    gateway.sendError = new Error("boom");
    await store.add(pending({ id: "m2", agentId: "agent-2" }));
    await makeScheduler(gateway).tick();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});

describe("busy agents", () => {
  it("waits while the agent is busy, then sends once it is idle", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "busy");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    await scheduler.tick();
    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")).toMatchObject({ status: "pending", attempts: 0 });

    gateway.states.set("agent-1", "idle");
    await scheduler.tick();
    expect(gateway.sent).toHaveLength(1);
    expect(store.get("m1")!.status).toBe("sent");
  });
});

describe("failures and retries", () => {
  it("records a failed attempt with backoff and does not retry early", async () => {
    const gateway = new FakeGateway();
    gateway.sendError = new Error("socket closed");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    await scheduler.tick();
    expect(store.get("m1")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "socket closed",
      nextAttemptAt: clock + BACKOFF_MS[0],
    });

    gateway.sendError = null;
    await scheduler.tick();
    expect(gateway.sent).toEqual([]);

    clock = store.get("m1")!.nextAttemptAt!;
    await scheduler.tick();
    expect(gateway.sent).toHaveLength(1);
    expect(store.get("m1")!.status).toBe("sent");
  });

  it("retries with growing backoff and fails after MAX_ATTEMPTS", async () => {
    const gateway = new FakeGateway();
    gateway.sendError = new Error("socket closed");
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await scheduler.tick();
      const current = store.get("m1")!;
      expect(current.status).toBe("pending");
      expect(current.attempts).toBe(attempt);
      expect(current.nextAttemptAt).toBe(clock + BACKOFF_MS[attempt - 1]!);
      clock = current.nextAttemptAt!;
    }

    await scheduler.tick();
    expect(store.get("m1")).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: "socket closed",
      finishedAt: clock,
    });
  });

  it("counts an inspect error as a failed attempt", async () => {
    const gateway = new FakeGateway();
    gateway.inspectError = new Error("daemon unreachable");
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(store.get("m1")).toMatchObject({ status: "pending", attempts: 1, lastError: "daemon unreachable" });
  });

  it("fails immediately, without sending, when the agent is archived", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "archived");
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")).toMatchObject({ status: "failed", lastError: "Agent archived" });
  });

  it("fails immediately, without sending, when the agent no longer exists", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "missing");
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(store.get("m1")).toMatchObject({ status: "failed", lastError: "Agent not found" });
  });
});

describe("ordering", () => {
  it("sends only the earliest item for an agent per tick", async () => {
    const gateway = new FakeGateway();
    const scheduler = makeScheduler(gateway);
    await store.add(pending({ id: "late", text: "second", fireAt: clock - 10 }));
    await store.add(pending({ id: "early", text: "first", fireAt: clock - 500 }));

    await scheduler.tick();
    expect(gateway.sent.map((s) => s.text)).toEqual(["first"]);

    await scheduler.tick();
    expect(gateway.sent.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("breaks fireAt ties by createdAt", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "b", text: "created-later", fireAt: clock - 5, createdAt: clock - 100 }));
    await store.add(pending({ id: "a", text: "created-first", fireAt: clock - 5, createdAt: clock - 200 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent.map((s) => s.text)).toEqual(["created-first"]);
  });

  it("does not let a later item overtake an earlier one waiting out a backoff", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "head", text: "head", fireAt: clock - 500, attempts: 1, nextAttemptAt: clock + 60_000 }));
    await store.add(pending({ id: "next", text: "next", fireAt: clock - 10 }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent).toEqual([]);
  });

  it("sends to different agents in the same tick", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "a", agentId: "agent-1", text: "one" }));
    await store.add(pending({ id: "b", agentId: "agent-2", text: "two" }));
    await makeScheduler(gateway).tick();
    expect(gateway.sent.map((s) => s.text).sort()).toEqual(["one", "two"]);
  });
});

describe("races", () => {
  it("does not send when the item is canceled while the agent is being inspected", async () => {
    const gateway = new FakeGateway();
    gateway.beforeInspect = async () => {
      await store.update("m1", (item) => ({ ...item, status: "canceled", finishedAt: clock }));
    };
    await store.add(pending());
    await makeScheduler(gateway).tick();

    expect(gateway.sent).toEqual([]);
    expect(store.get("m1")!.status).toBe("canceled");
  });

  it("keeps a canceled item canceled when the agent turns out to be archived", async () => {
    const gateway = new FakeGateway();
    gateway.states.set("agent-1", "archived");
    gateway.beforeInspect = async () => {
      await store.update("m1", (item) => ({ ...item, status: "canceled", finishedAt: clock }));
    };
    await store.add(pending());
    await makeScheduler(gateway).tick();
    expect(store.get("m1")!.status).toBe("canceled");
  });

  it("sends once when two ticks overlap", async () => {
    const gateway = new FakeGateway();
    const scheduler = makeScheduler(gateway);
    await store.add(pending());
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(gateway.sent).toHaveLength(1);
  });
});

describe("housekeeping", () => {
  it("prunes finished items past the retention window on each tick", async () => {
    const gateway = new FakeGateway();
    await store.add(pending({ id: "old", status: "sent", finishedAt: clock - HISTORY_RETENTION_MS - 1 }));
    await makeScheduler(gateway).tick();
    expect(store.get("old")).toBeUndefined();
  });
});

describe("timer", () => {
  it("ticks on an interval after start() and stops after stop()", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const gateway = new FakeGateway();
    const scheduler = makeScheduler(gateway);
    await store.add(pending());

    scheduler.start(10_000);
    vi.advanceTimersByTime(10_000);
    await vi.waitFor(() => expect(gateway.sent).toHaveLength(1));

    scheduler.stop();
    await store.add(pending({ id: "m2", agentId: "agent-2", text: "after stop" }));
    vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- server/scheduler.test.ts`
Expected: FAIL, cannot resolve `./scheduler`.

- [ ] **Step 3: Implement `server/scheduler.ts`**

```ts
import { BACKOFF_MS, MAX_ATTEMPTS, type ScheduledMessage } from "../shared/model";
import type { Logger } from "./logger";
import type { QueueStore } from "./store";

export const TICK_MS = 10_000;

export type AgentState = "idle" | "busy" | "missing" | "archived";

export interface AgentGateway {
  inspect(agentId: string): Promise<AgentState>;
  send(agentId: string, text: string): Promise<void>;
}

export interface SchedulerDeps {
  store: QueueStore;
  now: () => number;
  log: Logger;
  getGateway: () => AgentGateway | null;
}

export interface Scheduler {
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

const MAX_ERROR_LENGTH = 300;
const LAST_BACKOFF_MS = 1_800_000;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, now, log, getGateway } = deps;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // A cancel that lands mid-flight must win over a failure verdict, so failures only touch pending items.
  async function closeIfPending(id: string, patch: Partial<ScheduledMessage>): Promise<void> {
    await store.update(id, (item) =>
      item.status === "pending" ? { ...item, ...patch, finishedAt: now() } : item,
    );
  }

  async function recordFailure(item: ScheduledMessage, error: unknown): Promise<void> {
    const attempts = item.attempts + 1;
    const lastError = describeError(error);
    if (attempts >= MAX_ATTEMPTS) {
      log.error("giving up", { id: item.id, agentId: item.agentId, attempts });
      await closeIfPending(item.id, { status: "failed", attempts, lastError });
      return;
    }
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? LAST_BACKOFF_MS;
    log.error("attempt failed, will retry", { id: item.id, agentId: item.agentId, attempts });
    await store.update(item.id, (current) =>
      current.status === "pending" ? { ...current, attempts, lastError, nextAttemptAt: now() + delay } : current,
    );
  }

  async function deliver(item: ScheduledMessage, gateway: AgentGateway): Promise<void> {
    let state: AgentState;
    try {
      state = await gateway.inspect(item.agentId);
    } catch (error) {
      await recordFailure(item, error);
      return;
    }
    if (state === "missing") {
      await closeIfPending(item.id, { status: "failed", lastError: "Agent not found" });
      return;
    }
    if (state === "archived") {
      await closeIfPending(item.id, { status: "failed", lastError: "Agent archived" });
      return;
    }
    if (state === "busy") return;

    const current = store.get(item.id);
    if (current === undefined || current.status !== "pending") return;

    try {
      await gateway.send(item.agentId, item.text);
    } catch (error) {
      await recordFailure(item, error);
      return;
    }
    log.info("sent", { id: item.id, agentId: item.agentId });
    // The message is out; record the truth even if a cancel slipped in after the check above.
    await store.update(item.id, (latest) => ({ ...latest, status: "sent", sentAt: now(), finishedAt: now() }));
  }

  // Only the head item of each agent is eligible, so nothing overtakes an earlier waiting item
  // and at most one message per agent is sent per tick.
  function dueHeads(nowMs: number): ScheduledMessage[] {
    const heads = new Map<string, ScheduledMessage>();
    for (const item of store.list()) {
      if (item.status !== "pending") continue;
      const head = heads.get(item.agentId);
      const earlier =
        head === undefined ||
        item.fireAt < head.fireAt ||
        (item.fireAt === head.fireAt && item.createdAt < head.createdAt);
      if (earlier) heads.set(item.agentId, item);
    }
    return [...heads.values()].filter(
      (item) => item.fireAt <= nowMs && (item.nextAttemptAt === undefined || item.nextAttemptAt <= nowMs),
    );
  }

  async function runTick(): Promise<void> {
    const gateway = getGateway();
    if (gateway === null) return;
    const nowMs = now();
    try {
      await store.prune(nowMs);
    } catch (error) {
      log.error("prune failed", { error: describeError(error) });
    }
    for (const item of dueHeads(nowMs)) {
      try {
        await deliver(item, gateway);
      } catch (error) {
        log.error("delivery crashed", { id: item.id, agentId: item.agentId, error: describeError(error) });
      }
    }
  }

  function tick(): Promise<void> {
    if (inFlight === null) {
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    tick,
    start(intervalMs = TICK_MS) {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- server/scheduler.test.ts`
Expected: PASS (all cases). If the timer test hangs, confirm `vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })` fakes only the interval functions; faking `setTimeout` would starve `vi.waitFor` and the file I/O.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: PASS.

---

### Task 6: SDK gateway and RPC handlers (server)

**Files:**
- Create: `server/gateway.ts`, `server/handlers.ts`
- Test: `server/gateway.test.ts`, `server/handlers.test.ts`

**Interfaces:**
- Consumes: `AgentGateway`, `AgentState` from `./scheduler`; `QueueStore`, `createFileStore` from `./store`; `MAX_HORIZON_MS`, `MAX_TEXT_LENGTH`, `PAST_GRACE_MS`, `ScheduledMessage` from `../shared/model`. Read `docs/superpowers/notes/2026-09-30-probe-results.md` (Task 1) before Step 3 and apply its P3/P5 decision-table rows to `NOT_FOUND` and the archived check.
- Produces:
  - `server/gateway.ts`: `interface AgentHandleLike { refresh(): Promise<unknown>; send(text: string): Promise<unknown>; readonly archivedAt: string | null; readonly activeTurn: unknown; readonly status: string | null }`; `interface PaseoLike { readonly agents: { ref(agentId: string): AgentHandleLike } }`; `createPaseoGateway(paseo: PaseoLike): AgentGateway`.
  - `server/handlers.ts`: `interface HandlerDeps { store: QueueStore; now: () => number; newId: () => string; ready: Promise<void>; attach(paseo: PaseoLike): void; gatewayFor(paseo: PaseoLike): AgentGateway }`; `interface AddInput { agentId: string; text: string; fireAt: number }`; `createHandlers(deps: HandlerDeps): { add(input: AddInput, paseo: PaseoLike): Promise<{ item: ScheduledMessage }>; list(input: { agentId: string }, paseo: PaseoLike): Promise<{ items: ScheduledMessage[] }>; cancel(input: { id: string }, paseo: PaseoLike): Promise<{ item: ScheduledMessage | null }> }`.

- [ ] **Step 1: Write the failing gateway tests**

Create `server/gateway.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createPaseoGateway, type AgentHandleLike, type PaseoLike } from "./gateway";

function paseoWith(handle: Partial<AgentHandleLike>, refs: string[] = []): PaseoLike {
  const full: AgentHandleLike = {
    refresh: async () => ({}),
    send: async () => undefined,
    archivedAt: null,
    activeTurn: null,
    status: "idle",
    ...handle,
  };
  return {
    agents: {
      ref: (agentId) => {
        refs.push(agentId);
        return full;
      },
    },
  };
}

describe("createPaseoGateway.inspect", () => {
  it("reports an idle agent", async () => {
    expect(await createPaseoGateway(paseoWith({})).inspect("a")).toBe("idle");
  });

  it("reports busy when a turn is in flight", async () => {
    const paseo = paseoWith({ activeTurn: { turnId: "t1", startedAt: "now" } });
    expect(await createPaseoGateway(paseo).inspect("a")).toBe("busy");
  });

  it.each(["running", "initializing"])("reports busy for status %s", async (status) => {
    expect(await createPaseoGateway(paseoWith({ status })).inspect("a")).toBe("busy");
  });

  it("reports archived, ahead of busy", async () => {
    const paseo = paseoWith({ archivedAt: "2026-09-30T00:00:00Z", activeTurn: { turnId: "t" } });
    expect(await createPaseoGateway(paseo).inspect("a")).toBe("archived");
  });

  it("reports missing when refresh returns null", async () => {
    expect(await createPaseoGateway(paseoWith({ refresh: async () => null })).inspect("a")).toBe("missing");
  });

  it("reports missing when refresh throws a not-found error", async () => {
    const paseo = paseoWith({
      refresh: async () => {
        throw new Error("Agent not found: a");
      },
    });
    expect(await createPaseoGateway(paseo).inspect("a")).toBe("missing");
  });

  it("rethrows other refresh errors", async () => {
    const paseo = paseoWith({
      refresh: async () => {
        throw new Error("socket closed");
      },
    });
    await expect(createPaseoGateway(paseo).inspect("a")).rejects.toThrow("socket closed");
  });
});

describe("createPaseoGateway.send", () => {
  it("sends the text to the referenced agent", async () => {
    const refs: string[] = [];
    const sent: string[] = [];
    const paseo = paseoWith(
      {
        send: async (text) => {
          sent.push(text);
        },
      },
      refs,
    );
    await createPaseoGateway(paseo).send("agent-9", "hello there");
    expect(refs).toEqual(["agent-9"]);
    expect(sent).toEqual(["hello there"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- server/gateway.test.ts`
Expected: FAIL, cannot resolve `./gateway`.

- [ ] **Step 3: Implement `server/gateway.ts`**

```ts
import type { AgentGateway, AgentState } from "./scheduler";

// Structural slice of the SDK's agent handle. Kept local so the scheduler and handlers
// can be unit-tested without the SDK, and so a real `PaseoApi` is checked against it at compile time.
export interface AgentHandleLike {
  refresh(): Promise<unknown>;
  send(text: string): Promise<unknown>;
  readonly archivedAt: string | null;
  readonly activeTurn: unknown;
  readonly status: string | null;
}

export interface PaseoLike {
  readonly agents: { ref(agentId: string): AgentHandleLike };
}

// Adjust to the message observed in probe P3 (docs/superpowers/notes/2026-09-30-probe-results.md).
const NOT_FOUND = /not found|unknown agent|no such agent/i;
const BUSY_STATUSES = new Set(["running", "initializing"]);

export function createPaseoGateway(paseo: PaseoLike): AgentGateway {
  return {
    async inspect(agentId: string): Promise<AgentState> {
      const handle = paseo.agents.ref(agentId);
      let refreshed: unknown;
      try {
        refreshed = await handle.refresh();
      } catch (error) {
        if (error instanceof Error && NOT_FOUND.test(error.message)) return "missing";
        throw error;
      }
      if (refreshed === null || refreshed === undefined) return "missing";
      if (handle.archivedAt) return "archived";
      if (handle.activeTurn || (handle.status !== null && BUSY_STATUSES.has(handle.status))) return "busy";
      return "idle";
    },

    async send(agentId: string, text: string): Promise<void> {
      await paseo.agents.ref(agentId).send(text);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- server/gateway.test.ts`
Expected: PASS. Apply the Task 1 decision-table rows for P3 (regex) and P5 (archived field) now, keeping the tests aligned with the observed messages/fields, then re-run.

- [ ] **Step 5: Write the failing handler tests**

Create `server/handlers.test.ts`:
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HORIZON_MS, MAX_TEXT_LENGTH, PAST_GRACE_MS, type ScheduledMessage } from "../shared/model";
import type { PaseoLike } from "./gateway";
import { createHandlers } from "./handlers";
import type { Logger } from "./logger";
import type { AgentGateway, AgentState } from "./scheduler";
import { createFileStore, type QueueStore } from "./store";

const silent: Logger = { info() {}, error() {} };
const paseo: PaseoLike = { agents: { ref: () => { throw new Error("handlers must use the gateway"); } } };

let dir: string;
let clock: number;
let store: QueueStore;
let agentState: AgentState;
let attached: PaseoLike[];
let nextId: number;

function setup() {
  const gateway: AgentGateway = {
    inspect: async () => agentState,
    send: async () => undefined,
  };
  return createHandlers({
    store,
    now: () => clock,
    newId: () => `id-${(nextId += 1)}`,
    ready: Promise.resolve(),
    attach: (p) => {
      attached.push(p);
    },
    gatewayFor: () => gateway,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "schedule-handlers-"));
  clock = 1_800_000_000_000;
  agentState = "idle";
  attached = [];
  nextId = 0;
  store = createFileStore({ dir, now: () => clock, log: silent });
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("add", () => {
  it("stores a pending item and remembers the paseo handle", async () => {
    const { add } = setup();
    const { item } = await add({ agentId: "agent-1", text: "hello", fireAt: clock + 120_000 }, paseo);

    expect(item).toEqual({
      id: "id-1",
      agentId: "agent-1",
      text: "hello",
      fireAt: clock + 120_000,
      createdAt: clock,
      status: "pending",
      attempts: 0,
    });
    expect(store.list()).toEqual([item]);
    expect(attached).toEqual([paseo]);
  });

  it("trims the message text", async () => {
    const { add } = setup();
    const { item } = await add({ agentId: "a", text: "  hi there \n", fireAt: clock + 120_000 }, paseo);
    expect(item.text).toBe("hi there");
  });

  it("rejects whitespace-only text and stores nothing", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "  \n\t ", fireAt: clock + 120_000 }, paseo)).rejects.toThrow("Message is empty");
    expect(store.list()).toEqual([]);
  });

  it("rejects text over the limit but accepts text exactly at it", async () => {
    const { add } = setup();
    await expect(
      add({ agentId: "a", text: "x".repeat(MAX_TEXT_LENGTH + 1), fireAt: clock + 120_000 }, paseo),
    ).rejects.toThrow(`Message is too long (max ${MAX_TEXT_LENGTH} characters)`);
    await expect(
      add({ agentId: "a", text: "x".repeat(MAX_TEXT_LENGTH), fireAt: clock + 120_000 }, paseo),
    ).resolves.toBeDefined();
  });

  it("rejects a time more than 30 days ahead", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "x", fireAt: clock + MAX_HORIZON_MS + 1 }, paseo)).rejects.toThrow(
      "Time is more than 30 days ahead",
    );
  });

  it("rejects a time further in the past than the clock-skew grace, accepts one inside it", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "x", fireAt: clock - PAST_GRACE_MS - 1 }, paseo)).rejects.toThrow(
      "Time is in the past",
    );
    await expect(add({ agentId: "a", text: "x", fireAt: clock - 4 * 60_000 }, paseo)).resolves.toBeDefined();
  });

  it("rejects a non-integer time", async () => {
    const { add } = setup();
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 0.5 }, paseo)).rejects.toThrow("Invalid time");
    await expect(add({ agentId: "a", text: "x", fireAt: Number.NaN }, paseo)).rejects.toThrow("Invalid time");
  });

  it("rejects a missing or archived agent", async () => {
    const { add } = setup();
    agentState = "missing";
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 120_000 }, paseo)).rejects.toThrow("Agent not found");
    agentState = "archived";
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 120_000 }, paseo)).rejects.toThrow("Agent is archived");
    expect(store.list()).toEqual([]);
  });

  it("accepts a busy agent (the message will wait for it)", async () => {
    const { add } = setup();
    agentState = "busy";
    await expect(add({ agentId: "a", text: "x", fireAt: clock + 120_000 }, paseo)).resolves.toBeDefined();
  });
});

describe("list", () => {
  it("returns only that agent's items: pending by fireAt, then finished newest first", async () => {
    const { list } = setup();
    const base = { agentId: "agent-1", attempts: 0, createdAt: clock - 1_000 };
    const items: ScheduledMessage[] = [
      { ...base, id: "later", text: "later", fireAt: clock + 9_000, status: "pending" },
      { ...base, id: "sooner", text: "sooner", fireAt: clock + 1_000, status: "pending" },
      { ...base, id: "sent-old", text: "s1", fireAt: clock - 500, status: "sent", finishedAt: clock - 400 },
      { ...base, id: "failed-new", text: "s2", fireAt: clock - 300, status: "failed", finishedAt: clock - 100 },
      { ...base, agentId: "agent-2", id: "other", text: "other", fireAt: clock + 1, status: "pending" },
    ];
    for (const item of items) await store.add(item);

    const { items: result } = await list({ agentId: "agent-1" }, paseo);
    expect(result.map((i) => i.id)).toEqual(["sooner", "later", "failed-new", "sent-old"]);
    expect(attached).toEqual([paseo]);
  });
});

describe("cancel", () => {
  const seed = (over: Partial<ScheduledMessage>): ScheduledMessage => ({
    id: "m1",
    agentId: "a",
    text: "x",
    fireAt: clock + 1_000,
    createdAt: clock,
    status: "pending",
    attempts: 0,
    ...over,
  });

  it("cancels a pending item", async () => {
    const { cancel } = setup();
    await store.add(seed({}));
    const { item } = await cancel({ id: "m1" }, paseo);
    expect(item).toMatchObject({ id: "m1", status: "canceled", finishedAt: clock });
    expect(store.get("m1")!.status).toBe("canceled");
  });

  it.each(["sent", "failed", "canceled"] as const)("leaves a %s item unchanged", async (status) => {
    const { cancel } = setup();
    await store.add(seed({ status, finishedAt: clock - 5 }));
    const { item } = await cancel({ id: "m1" }, paseo);
    expect(item).toMatchObject({ status, finishedAt: clock - 5 });
  });

  it("returns null for an unknown id", async () => {
    const { cancel } = setup();
    expect(await cancel({ id: "nope" }, paseo)).toEqual({ item: null });
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- server/handlers.test.ts`
Expected: FAIL, cannot resolve `./handlers`.

- [ ] **Step 7: Implement `server/handlers.ts`**

```ts
import { MAX_HORIZON_MS, MAX_TEXT_LENGTH, PAST_GRACE_MS, type ScheduledMessage } from "../shared/model";
import type { PaseoLike } from "./gateway";
import type { AgentGateway } from "./scheduler";
import type { QueueStore } from "./store";

export interface HandlerDeps {
  store: QueueStore;
  now: () => number;
  newId: () => string;
  ready: Promise<void>;
  attach(paseo: PaseoLike): void;
  gatewayFor(paseo: PaseoLike): AgentGateway;
}

export interface AddInput {
  agentId: string;
  text: string;
  fireAt: number;
}

export function createHandlers(deps: HandlerDeps) {
  const { store, now, newId, ready, attach, gatewayFor } = deps;

  return {
    async add(input: AddInput, paseo: PaseoLike): Promise<{ item: ScheduledMessage }> {
      await ready;
      attach(paseo);

      const text = input.text.trim();
      if (text.length === 0) throw new Error("Message is empty");
      if (text.length > MAX_TEXT_LENGTH) throw new Error(`Message is too long (max ${MAX_TEXT_LENGTH} characters)`);

      const nowMs = now();
      if (!Number.isInteger(input.fireAt)) throw new Error("Invalid time");
      if (input.fireAt < nowMs - PAST_GRACE_MS) throw new Error("Time is in the past");
      if (input.fireAt > nowMs + MAX_HORIZON_MS) throw new Error("Time is more than 30 days ahead");

      const state = await gatewayFor(paseo).inspect(input.agentId);
      if (state === "missing") throw new Error("Agent not found");
      if (state === "archived") throw new Error("Agent is archived");

      const item: ScheduledMessage = {
        id: newId(),
        agentId: input.agentId,
        text,
        fireAt: input.fireAt,
        createdAt: nowMs,
        status: "pending",
        attempts: 0,
      };
      await store.add(item);
      return { item };
    },

    async list(input: { agentId: string }, paseo: PaseoLike): Promise<{ items: ScheduledMessage[] }> {
      await ready;
      attach(paseo);
      const mine = store.list().filter((item) => item.agentId === input.agentId);
      const pending = mine
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.fireAt - b.fireAt || a.createdAt - b.createdAt);
      const finished = mine
        .filter((item) => item.status !== "pending")
        .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
      return { items: [...pending, ...finished] };
    },

    async cancel(input: { id: string }, paseo: PaseoLike): Promise<{ item: ScheduledMessage | null }> {
      await ready;
      attach(paseo);
      const updated = await store.update(input.id, (item) =>
        item.status === "pending" ? { ...item, status: "canceled", finishedAt: now() } : item,
      );
      return { item: updated ?? null };
    },
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- server/handlers.test.ts`
Expected: PASS.

- [ ] **Step 9: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: PASS.

---

### Task 7: Wire the server entry, install, and check it runs

**Files:**
- Modify: `index.server.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 5, 6. `PluginServerContext.handle(contract, (input, { paseo }) => ...)` and `PluginServerContext.on(name, (event, { paseo, signal }) => ...)`. Read probe P2 in the notes file: it must be `ok`.
- Produces: the running plugin subprocess; no new exported symbols.

- [ ] **Step 1: Write the server entry**

Overwrite `index.server.ts`:
```ts
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoGateway, type PaseoLike } from "./server/gateway";
import { createHandlers } from "./server/handlers";
import { consoleLogger } from "./server/logger";
import { createScheduler, type AgentGateway } from "./server/scheduler";
import { createFileStore, resolveDataDir } from "./server/store";
import { addScheduleRpc, cancelScheduleRpc, listScheduleRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const log = consoleLogger;
  const dir = resolveDataDir(process.env, os.homedir());
  const store = createFileStore({ dir, now: Date.now, log });

  // The server context has no `paseo` of its own: keep the newest one seen in any RPC or hook call.
  let gateway: AgentGateway | null = null;
  const attach = (paseo: PaseoLike): void => {
    gateway = createPaseoGateway(paseo);
  };

  const scheduler = createScheduler({ store, now: Date.now, log, getGateway: () => gateway });

  const ready = store.load().then(() => {
    scheduler.start();
    log.info("started", { dir, pending: store.list().filter((item) => item.status === "pending").length });
  });
  ready.catch((error: unknown) => log.error("failed to load queue", { dir, error: String(error) }));

  const handlers = createHandlers({
    store,
    now: Date.now,
    newId: randomUUID,
    ready,
    attach,
    gatewayFor: createPaseoGateway,
  });
  server.handle(addScheduleRpc, (input, { paseo }) => handlers.add(input, paseo));
  server.handle(listScheduleRpc, (input, { paseo }) => handlers.list(input, paseo));
  server.handle(cancelScheduleRpc, (input, { paseo }) => handlers.cancel(input, paseo));

  // Agent activity is the only thing that can wake a freshly restarted plugin with no app open.
  const wake = (paseo: PaseoLike): void => {
    attach(paseo);
    void ready.then(() => scheduler.tick()).catch(() => undefined);
  };
  server.on("agent.turn_started", (_event, { paseo }) => wake(paseo));
  server.on("agent.turn_ended", (_event, { paseo }) => wake(paseo));
  server.on("agent.created", (_event, { paseo }) => wake(paseo));

  return () => {
    scheduler.stop();
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If the compiler rejects passing the SDK's `paseo` as `PaseoLike`, read the reported member mismatch and loosen only that member of `AgentHandleLike` in `server/gateway.ts` (for example widen a field type to `unknown`), then re-run `npm test -- server/gateway.test.ts` and `npm run typecheck`. Do not cast with `as`.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Install gate, install, confirm running**

Run:
```bash
python3 -c "import json;print(json.load(open('/Users/ultima/.paseo/config.json')).get('pluginsEnabled','<absent>'))"
```
Expected `True` (otherwise stop and ask the user, see Global Constraints). Then:
```bash
paseo plugin install /Users/ultima/Workspace/paseo-plugins/schdule-sending
paseo plugin ls
paseo plugin logs schedule-sending
```
Expected: `schedule-sending` is `running` with no error; logs contain `[schedule-sending] started` with a `dir` under `plugin-data/schedule-sending` and `pending: 0`. If the plugin is already installed from an earlier attempt, run `paseo plugin reload schedule-sending` instead of `install`.

- [ ] **Step 5: Checkpoint**

`paseo plugin ls` shows `running`; typecheck and tests green.

---

### Task 8: Client UI — composer pill, popover, form, list

**Files:**
- Create: `client/query-keys.ts`, `client/types.ts`, `client/schedule-form.tsx`, `client/schedule-list.tsx`, `client/schedule-popover.tsx`, `client/pills.ts`
- Modify: `index.client.tsx`

**Interfaces:**
- Consumes: `parseWhen`, `previewLine`, `canSchedule`, `describeItem`, `RowTone`, `ItemRow` (Task 3); `addScheduleRpc`, `listScheduleRpc`, `cancelScheduleRpc` (Task 2); SDK `useRpc`, `PluginButtonContentProps`, `PluginHostProps`, `PluginClientContext`, `PluginButtonRegistration` from `@getpaseo/plugin/client`; `useQuery`, `useMutation`, `useQueryClient` from `@tanstack/react-query`.
- Produces: `listQueryKey(agentId: string): readonly ["schedule-sending", "list", string]` (`client/query-keys.ts`); `type Theme = PluginHostProps["theme"]`, `type Layout = PluginHostProps["layout"]` (`client/types.ts`); `SchedulePopover(props: PluginButtonContentProps)`; `contributePills(client: PluginClientContext): () => void`.

UI components have no unit tests (they need a React Native renderer that the plugin project does not carry); their logic lives in the tested Task 3 modules, and the components are verified by typecheck, the DOM audit and the manual checks in Task 9.

- [ ] **Step 1: Shared client helpers**

Create `client/query-keys.ts`:
```ts
export const listQueryKey = (agentId: string) => ["schedule-sending", "list", agentId] as const;
```
Create `client/types.ts`:
```ts
import type { PluginHostProps } from "@getpaseo/plugin/client";

export type Theme = PluginHostProps["theme"];
export type Layout = PluginHostProps["layout"];
```

- [ ] **Step 2: The add form**

Create `client/schedule-form.tsx`:
```tsx
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { parseWhen } from "./parse-when";
import type { Layout, Theme } from "./types";
import { canSchedule, previewLine } from "./view-model";

const CHIPS = ["+1h", "+5h", "8am"] as const;

interface Props {
  theme: Theme;
  layout: Layout;
  now: number;
  busy: boolean;
  error: string | null;
  onSubmit: (text: string, fireAt: number) => Promise<unknown>;
}

export function ScheduleForm({ theme, layout, now, busy, error, onSubmit }: Props) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const parsed = useMemo(() => parseWhen(when, now), [when, now]);
  const line = previewLine(when, parsed, now);
  const enabled = !busy && canSchedule(text, parsed);

  const styles = useMemo(
    () => ({
      form: { gap: layout.compact ? 8 : 10 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: 10,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
      },
      message: { minHeight: 72, textAlignVertical: "top" as const },
      chips: { flexDirection: "row" as const, gap: 8 },
      chip: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      chipText: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      button: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
        opacity: enabled ? 1 : 0.5,
      },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, layout.compact, enabled],
  );

  const submit = useCallback(async () => {
    if (!parsed.ok) return;
    try {
      await onSubmit(text.trim(), parsed.fireAt);
      setText("");
      setWhen("");
    } catch {
      // The container renders the failure; keep the draft so the user can retry.
    }
  }, [onSubmit, parsed, text]);

  return (
    <View style={styles.form}>
      <TextInput
        multiline
        value={text}
        onChangeText={setText}
        placeholder="Message to send"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Message to send"
        style={[styles.input, styles.message]}
      />
      <TextInput
        value={when}
        onChangeText={setWhen}
        placeholder="When: 3am, 15:30, in 5h"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="When to send"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <View style={styles.chips}>
        {CHIPS.map((chip) => (
          <Pressable
            key={chip}
            accessibilityRole="button"
            accessibilityLabel={`Set time to ${chip}`}
            onPress={() => setWhen(chip)}
            style={styles.chip}
          >
            <Text style={styles.chipText}>{chip}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={line.isError ? styles.error : styles.muted}>{line.text}</Text>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Schedule message"
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={() => void submit()}
        style={styles.button}
      >
        <Text style={styles.buttonText}>{busy ? "Scheduling…" : "Schedule"}</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 3: The list**

Create `client/schedule-list.tsx`:
```tsx
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { ScheduledMessage } from "../shared/model";
import type { Layout, Theme } from "./types";
import { describeItem, type ItemRow, type RowTone } from "./view-model";

interface Props {
  theme: Theme;
  layout: Layout;
  items: readonly ScheduledMessage[];
  now: number;
  cancelingId: string | null;
  onCancel: (id: string) => void;
}

export function ScheduleList({ theme, layout, items, now, cancelingId, onCancel }: Props) {
  const rows = useMemo(() => items.map((item) => describeItem(item, now)), [items, now]);
  const pending = rows.filter((row) => row.cancellable);
  const recent = rows.filter((row) => !row.cancellable);

  const toneColor: Record<RowTone, string> = {
    muted: theme.colors.foregroundMuted,
    success: theme.colors.statusSuccess,
    warning: theme.colors.statusWarning,
    danger: theme.colors.statusDanger,
  };

  const styles = useMemo(
    () => ({
      list: { gap: layout.compact ? 12 : 16 },
      heading: { color: theme.colors.foregroundMuted, fontSize: 12, textTransform: "uppercase" as const },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      rowText: { flex: 1, gap: 2 },
      preview: { color: theme.colors.foreground },
      cancel: { color: theme.colors.statusDanger },
      empty: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );

  const renderRow = (row: ItemRow) => (
    <View key={row.id} style={styles.row}>
      <View style={styles.rowText}>
        <Text numberOfLines={2} style={styles.preview}>
          {row.preview}
        </Text>
        <Text style={{ color: toneColor[row.tone] }}>{row.detail}</Text>
      </View>
      {row.cancellable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel scheduled message"
          disabled={cancelingId === row.id}
          onPress={() => onCancel(row.id)}
        >
          <Text style={styles.cancel}>{cancelingId === row.id ? "Canceling…" : "Cancel"}</Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (rows.length === 0) return <Text style={styles.empty}>Nothing scheduled for this chat.</Text>;

  return (
    <View style={styles.list}>
      {pending.length > 0 ? (
        <View>
          <Text style={styles.heading}>Pending</Text>
          {pending.map(renderRow)}
        </View>
      ) : null}
      {recent.length > 0 ? (
        <View>
          <Text style={styles.heading}>Recent (7 days)</Text>
          {recent.map(renderRow)}
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 4: The popover container**

Create `client/schedule-popover.tsx`:
```tsx
import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text } from "react-native";
import { addScheduleRpc, cancelScheduleRpc, listScheduleRpc } from "../shared/rpc";
import { listQueryKey } from "./query-keys";
import { ScheduleForm } from "./schedule-form";
import { ScheduleList } from "./schedule-list";

const REFETCH_MS = 5_000;
const CLOCK_MS = 15_000;

type AgentProps = Extract<PluginButtonContentProps, { context: "agent" }>;

export function SchedulePopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <AgentSchedule {...props} />;
}

function AgentSchedule({ theme, layout, agentId }: AgentProps) {
  const list = useRpc(listScheduleRpc);
  const add = useRpc(addScheduleRpc);
  const cancel = useRpc(cancelScheduleRpc);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => listQueryKey(agentId), [agentId]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const query = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: REFETCH_MS,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const addMutation = useMutation({ mutationFn: add, onSuccess: refresh });
  const cancelMutation = useMutation({ mutationFn: cancel, onSuccess: refresh });

  const styles = useMemo(
    () => ({
      screen: {
        padding: layout.compact ? 12 : 16,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <ScheduleForm
        theme={theme}
        layout={layout}
        now={now}
        busy={addMutation.isPending}
        error={addMutation.error?.message ?? null}
        onSubmit={(text, fireAt) => addMutation.mutateAsync({ agentId, text, fireAt })}
      />
      {query.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
      {query.error ? <Text style={styles.error}>{query.error.message}</Text> : null}
      {cancelMutation.error ? <Text style={styles.error}>{cancelMutation.error.message}</Text> : null}
      {query.data ? (
        <ScheduleList
          theme={theme}
          layout={layout}
          items={query.data.items}
          now={now}
          cancelingId={cancelMutation.isPending ? (cancelMutation.variables?.id ?? null) : null}
          onCancel={(id) => cancelMutation.mutate({ id })}
        />
      ) : null}
    </ScrollView>
  );
}
```

- [ ] **Step 5: Pill registration**

Create `client/pills.ts`:
```ts
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { SchedulePopover } from "./schedule-popover";

// One composer pill per agent, following the agent directory (documented owned-subscription pattern).
export function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  let stopped = false;

  const remove = (agentId: string): void => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const register = (agent: { id: string; workspaceId?: string | null }): void => {
    if (stopped || !agent.workspaceId) return;
    remove(agent.id);
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "schedule",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Schedule a message",
          icon: "Clock",
          label: "Schedule",
          behavior: { kind: "popover", Content: SchedulePopover },
        },
      }),
    );
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const pill of pills.values()) pill.remove();
          pills.clear();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
```

- [ ] **Step 6: Client entry**

Overwrite `index.client.tsx`:
```tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  return contributePills(client);
}
```

- [ ] **Step 7: Typecheck and audit**

Run: `npm run typecheck`
Expected: PASS. If the compiler flags a pill/agent-update type (for example `message.payload` or `subscription.subscribe` shapes), the upstream `plugin-examples/local-plugin/client/main.tsx` in `github.com/getpaseo/paseo` is the reference; align to its types, not with casts.

Run the DOM audit; expected no output:
```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/ --glob '!client/web.ts' --glob '!*.test.ts'
```
If `rg` reports JSX-looking hits in `.tsx` (for example generic type arguments), read each and confirm it is not an HTML element or DOM API.

- [ ] **Step 8: Reload and confirm running**

Run:
```bash
npm test
paseo plugin reload schedule-sending
paseo plugin ls
```
Expected: tests PASS; plugin `running` with no error. In the Paseo app, open any agent chat: the composer track shows a **Schedule** pill; tapping it opens the popover with the form and "Nothing scheduled for this chat."

- [ ] **Step 9: Checkpoint**

Typecheck, tests, audit clean; plugin running; pill visible.

---

### Task 9: End-to-end verification on the real daemon

Exercises the spec's known limits and the parts unit tests cannot: real SDK delivery, wait-for-idle, cancel, restart behavior, archived-agent failure, layout and themes. Steps marked (user) need a person looking at the Paseo app; ask the user to confirm via `AskUserQuestion`, describing exactly what to look for. Uses two throwaway agents in `/tmp` (small quota use).

**Files:**
- Modify: none (fixes found here go back into the owning task's files with a test where the bug is logic).

**Interfaces:**
- Consumes: the installed plugin; `paseo run`, `paseo send`, `paseo logs`, `paseo wait`, `paseo archive`, `paseo plugin reload`, `paseo plugin logs`.
- Produces: pass/fail per scenario, recorded in a short report to the user.

- [ ] **Step 1: Create the first throwaway agent**

Run:
```bash
mkdir -p /tmp/paseo-e2e
paseo run "Reply with the single word READY" --provider claude --title schedule-e2e-1 -d --cwd /tmp/paseo-e2e
```
Note the id as `<E2E1>`. Then `paseo wait <E2E1>`.

- [ ] **Step 2: Basic delivery (user)**

Ask the user to open chat `schedule-e2e-1`, tap **Schedule**, enter message `Reply with the single word DELIVERED` and when `in 2m`, and confirm the preview reads `Fires Today HH:MM · in 2m`, then tap **Schedule**. Expected: it appears under **Pending**. After about two minutes and one tick:
```bash
paseo logs <E2E1>
```
Expected: a user message `Reply with the single word DELIVERED` followed by an agent reply. The popover row moves to **Recent** as `Sent Today HH:MM`. Also `paseo plugin logs schedule-sending` shows a `sent` line with ids and no message text.

- [ ] **Step 3: Wait-for-idle**

Run:
```bash
paseo send <E2E1> "Run the shell command 'sleep 150' and then reply DONE"
```
(If the app shows a permission prompt for the command, ask the user to approve it.) While that turn runs, ask the user to schedule `Reply with the single word AFTER` for `in 1m` on the same chat. Expected: the row shows `Due · waiting to send` once a minute has passed, and the message is delivered only after the `sleep` turn ends — `paseo logs <E2E1>` shows `DONE` before the `AFTER` user message.

- [ ] **Step 4: Cancel (user)**

Ask the user to schedule any message for `in 5h`, confirm it is listed under **Pending**, tap **Cancel**, and confirm it moves to **Recent** as `Canceled`. Expected: `paseo logs <E2E1>` never shows it.

- [ ] **Step 5: Reload keeps the queue, and the restart gap**

Ask the user to schedule `Reply with the single word RELOADED` for `in 3m`, then close the popover. Run `paseo plugin reload schedule-sending`. Expected: `paseo plugin logs schedule-sending` shows `started` with `pending: 1`. Do not interact with any agent. Wait past the due time and record whether the message is delivered without any event (spec §7 "Restart gap" predicts it is not). Then reopen the popover (which issues an RPC) or run `paseo send <E2E1> "Reply OK"` and confirm the pending message is delivered right after. Record the observed behavior in the report to the user.

- [ ] **Step 6: Archived agent fails visibly**

Run:
```bash
paseo run "Reply with the single word READY" --provider claude --title schedule-e2e-2 -d --cwd /tmp/paseo-e2e
```
Note the id as `<E2E2>` and `paseo wait <E2E2>`. Ask the user to schedule any message for `in 2m` on `schedule-e2e-2`, then run `paseo archive <E2E2>`. After the due time, ask the user to confirm the row reads `Failed · Agent archived` under **Recent** (the popover for an archived chat may be reachable from the archived list; if not, confirm with the file instead):
```bash
python3 -c "import json,glob,os;p=os.path.expanduser('~/.paseo/plugin-data/schedule-sending/queue.json');print([ (i['status'],i.get('lastError')) for i in json.load(open(p))['items'] if i['agentId']=='<E2E2>'])"
```
Expected: `[('failed', 'Agent archived')]`.

- [ ] **Step 7: Layout and themes (user)**

Ask the user to confirm, at desktop width and at a narrow/mobile width, and in one dark and one light theme: all text is readable (no black-on-dark), the form, chips, preview line and list fit without horizontal clipping, and the keyboard does not hide the **Schedule** button on mobile (scrolling reaches it).

- [ ] **Step 8: Clean up**

Run:
```bash
paseo archive <E2E1>
rm -rf /tmp/paseo-e2e
paseo plugin ls
```
Expected: `schedule-sending` still `running`. Final checkpoint:
```bash
npm run typecheck && npm test
```
Expected: PASS. Report to the user: per-scenario result, the observed restart-gap behavior from Step 5, and the reminder that the Mac must stay awake overnight (spec §7) for anything to fire.

---

### Task 10 (optional): Pending-count badge on the pill icon

Only do this if the user wants it after Task 9. Spec §5.1 allows shipping without it.

**Files:**
- Create: `client/schedule-icon.tsx`
- Modify: `client/pills.ts` (the `icon` field)

**Interfaces:**
- Consumes: `listQueryKey` (Task 8), `listScheduleRpc` (Task 2), SDK `PluginButtonIconProps`, `useRpc`.
- Produces: `ScheduleIcon(props: PluginButtonIconProps)`.

- [ ] **Step 1: Write the icon**

Create `client/schedule-icon.tsx`:
```tsx
import { useRpc, type PluginButtonIconProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { listScheduleRpc } from "../shared/rpc";
import { listQueryKey } from "./query-keys";

const REFETCH_MS = 15_000;

export function ScheduleIcon(props: PluginButtonIconProps) {
  if (props.context !== "agent") return null;
  return <PendingBadge size={props.size} color={props.color} agentId={props.agentId} />;
}

function PendingBadge({ size, color, agentId }: { size: number; color: string; agentId: string }) {
  const list = useRpc(listScheduleRpc);
  const { data } = useQuery({
    queryKey: listQueryKey(agentId),
    queryFn: () => list({ agentId }),
    refetchInterval: REFETCH_MS,
  });
  const pending = data?.items.filter((item) => item.status === "pending").length ?? 0;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color, fontSize: size * 0.8 }}>{pending > 0 ? String(pending) : "◷"}</Text>
    </View>
  );
}
```

- [ ] **Step 2: Use it in the pill**

In `client/pills.ts` add `import { ScheduleIcon } from "./schedule-icon";` and change `icon: "Clock",` to `icon: ScheduleIcon,`.

- [ ] **Step 3: Verify, with a fallback**

Run `npm run typecheck && npm test && paseo plugin reload schedule-sending && paseo plugin ls`. Ask the user to confirm the pill icon shows `◷` with nothing pending and the count when items are pending. If the icon fails to render or throws (plugin console error), revert both edits and delete `client/schedule-icon.tsx`; the plugin ships with the static `Clock` icon, which is the spec's stated fallback.

**Checkpoint:** typecheck and tests green; badge works or is reverted.
