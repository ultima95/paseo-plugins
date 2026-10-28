# Agent Room Plugin (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Paseo plugin `agent-room` that lets any provider run any seat of the Supervisor ⇄ Lead ⇄ Peer room, with per-seat provider/model/effort config, role injection, a spawn guard, a Room screen, `/room`, and a live tree + feed view; plus the `command-code-provider` change that lets Command Code honor injected system prompts.

**Architecture:** Daemon side: a `before("agent.create")` hook recognizes `[room:…]` title markers, overrides the agent config with the saved seat config and appends protocol + role + seat table as `systemPrompt`; lifecycle hooks feed a persisted room store and enforce the guard. App side: settings-backed seat editor, launch form, `/room`, and a live view that polls a room RPC and reads live seat status with `useAgent`. Command Code receives the prompt through a generated Command Code mod fed by a per-connection prompt file.

**Tech Stack:** TypeScript, `@getpaseo/plugin` 0.13.1, React Native primitives, `@tanstack/react-query`, zod 4, vitest; Command Code mod API (`cmd.addFlag`, `cmd.hooks({ appendSystemPrompt })`).

**Spec:** `docs/superpowers/specs/2026-10-28-agent-room-plugin-phase1-design.md`

## Global Constraints

- New plugin directory: `/Users/ultima/Workspace/paseo-plugins/agent-room`, manifest id `agent-room`, `requirements.paseo` `>=0.13.1`.
- Pin `@getpaseo/plugin` `0.13.1` (installed daemon is 0.13.1); other dev deps as in `schedule-sending/package.json` (`react` 19.1.0, `react-native` 0.81.5, `@tanstack/react-query` ^5.90.11, `zod` ^4.4.3, `vitest` ^4.1.11, `typescript` ^5.9.3, `@types/node`, `@types/react` ~19.2.0). Scripts: `typecheck` = `tsc --noEmit`, `test` = `vitest run`, `gen:prompts` (Task 2).
- `agent-room/.gitignore` must contain `node_modules/` (root `.gitignore` does not, and `schedule-sending/node_modules` got committed by accident — do not repeat that).
- Code only in `client/`, `server/`, `shared/` plus the two entries; no other root modules.
- Client: React Native primitives only (`View`, `Text`, `Pressable`, `ScrollView`, `TextInput`), every `Text` colored from `theme.colors`, padding from `layout.compact`; no DOM, no `className`, no `onClick`.
- Seat markers, exactly: `[room:supervisor]`, `[room:lead]`, `[room:peer:<tier>]`. Tier ids match `^[a-z][a-z0-9-]*$`. Agent titles are capped at 60 characters.
- Agents whose title has no `[room:…]` marker are never modified, archived, or recorded. The old Claude room (`claude-supervisor`, `claude-lead`, `claude-peer`, `codex-peer`, `~/.claude/skills/supervisor`, `~/.config/slp-room`) is never touched.
- No plugin relay of turn-end reports; Paseo's native `notifyOnFinish` carries them.
- Never restart the daemon; load changes with `paseo plugin reload <id>`.
- Two git repos: the root repo (`paseo-plugins`, for `agent-room/` and docs) and `command-code-provider/` (its own `.git`). Work on branch `feat/agent-room` in each; never commit to `main`.

## Review Focus

1. Marker variants an agent will plausibly type — `[Room:Lead]`, `[room:lead]x` with no space, `  [room:peer]` with no tier, `Fix [room:lead]` with the marker mid-title — should parse case-insensitively at the start only, default a missing tier to `default`, and ignore mid-title markers. Tests in Task 1.
2. Settings not yet saved or saved invalid — agent creation must never fail or hang; the hook falls back to `DEFAULT_SETTINGS`. Test in Task 3.
3. A creating agent passes `modeId`/`thinkingOptionId`/`featureValues` meant for a different provider while the seat config leaves them unset — they must be removed, not carried into the new provider. Test in Task 3.
4. Plugin reload or daemon restart mid-room — the store reloads from disk, and the guard still resolves a parent seat that is missing from the store by fetching the parent's title. Test in Task 5.
5. A very long `/room` task — the Supervisor title is truncated to 60 characters with the marker intact; the full task still goes in as the first prompt. Test in Task 1 (title) and Task 6 (launch).

---

### Task 1: Scaffold `agent-room` and the shared seat model

**Files:**
- Create: `agent-room/paseo-plugin.json`, `agent-room/package.json`, `agent-room/tsconfig.json` (copy `schedule-sending/tsconfig.json`), `agent-room/.gitignore`, `agent-room/index.server.ts` (empty contribution returning cleanup), `agent-room/index.client.tsx` (same)
- Create: `agent-room/shared/seats.ts`
- Test: `agent-room/shared/seats.test.ts`

**Interfaces:**
- Produces (all from `shared/seats.ts`):
  - `seatConfigSchema` → `SeatConfig = { provider: string; model: string; modeId?: string; thinkingOptionId?: string; features?: Record<string, unknown> }` (`provider` is the bare provider id, e.g. `claude`; `model` the bare model id)
  - `peerTierSchema` → `PeerTier = SeatConfig & { id: string; useFor: string }`
  - `roomSettingsSchema` → `RoomSettings = { supervisor: SeatConfig; lead: SeatConfig; peerTiers: PeerTier[] }`; refine: ≥1 tier, unique ids, one tier with id `default`
  - `roomSettings = defineSettings({ id: "seats", scope: "host", version: 1, schema: roomSettingsSchema })`
  - `DEFAULT_SETTINGS: RoomSettings`
  - `type SeatMarker = { seat: "supervisor" } | { seat: "lead" } | { seat: "peer"; tier: string }`
  - `parseSeatMarker(title: string | null | undefined): { marker: SeatMarker; rest: string } | null`
  - `formatMarker(marker: SeatMarker): string` → `[room:supervisor]` / `[room:lead]` / `[room:peer:<tier>]`
  - `seatTitle(marker: SeatMarker, text: string): string`
  - `seatConfigFor(marker: SeatMarker, settings: RoomSettings): { config: SeatConfig; fallbackFrom?: string }`

`DEFAULT_SETTINGS` values (seeded from the user's current room profiles, `claude-*` → `claude`, `codex-peer` → `codex`):

| Seat / tier id | provider | model | modeId | thinkingOptionId | useFor |
|---|---|---|---|---|---|
| supervisor | claude | claude-opus-5-5 | bypassPermissions | xhigh | — |
| lead | claude | claude-opus-5-5 | bypassPermissions | high | — |
| cheap | claude | claude-haiku-4-5 | bypassPermissions | medium | Extraction, formatting, log triage, mechanical edits |
| default | claude | claude-sonnet-5-5 | bypassPermissions | medium | Implementation, debugging, research |
| expensive | claude | claude-opus-5-5 | bypassPermissions | medium | Hard problems a cheaper tier failed on |
| review | claude | claude-sonnet-5-5 | bypassPermissions | high | Read-only review of a candidate |
| cross-family | codex | gpt-5.6-sol | full-access | medium | Cross-family implementation or second opinion |
| cross-family-review | codex | gpt-5.6-sol | full-access | high | Cross-family read-only review |

- [ ] **Step 1: Create branch and scaffold**

```bash
cd /Users/ultima/Workspace/paseo-plugins && git switch -c feat/agent-room
```
Write the manifest (`{ "id": "agent-room", "description": "Run a Supervisor, Lead and Peer agent room on any provider", "requirements": { "paseo": ">=0.13.1" } }`), `package.json` (private, `files` list as in `schedule-sending`), tsconfig, `.gitignore`, empty entries. Run `npm install` in `agent-room/`.

- [ ] **Step 2: Write the failing tests** in `shared/seats.test.ts`

```ts
describe("parseSeatMarker", () => {
  it.each([
    ["[room:supervisor] Fix auth", { seat: "supervisor" }, "Fix auth"],
    ["[room:lead] API", { seat: "lead" }, "API"],
    ["[room:peer:cheap] format logs", { seat: "peer", tier: "cheap" }, "format logs"],
    ["[Room:Lead] API", { seat: "lead" }, "API"],
    ["  [room:peer] x", { seat: "peer", tier: "default" }, "x"],
    ["[room:lead]API", { seat: "lead" }, "API"],
    ["[ROOM:PEER:Review] y", { seat: "peer", tier: "review" }, "y"],
  ])("parses %s", (title, marker, rest) => {
    expect(parseSeatMarker(title)).toEqual({ marker, rest });
  });
  it.each([null, undefined, "", "[Lead] old room", "[Peer] old", "Fix [room:lead] x", "[room:boss] x", "[room:peer:Bad_Tier] x"])(
    "ignores %s", (title) => expect(parseSeatMarker(title)).toBeNull());
});
describe("seatTitle", () => {
  it("keeps the marker and caps at 60 chars", () => {
    const t = seatTitle({ seat: "supervisor" }, "x".repeat(200));
    expect(t.startsWith("[room:supervisor] ")).toBe(true);
    expect(t.length).toBe(60);
  });
  it("round-trips through parseSeatMarker", () => {
    expect(parseSeatMarker(seatTitle({ seat: "peer", tier: "review" }, "check diff"))?.marker)
      .toEqual({ seat: "peer", tier: "review" });
  });
});
describe("seatConfigFor", () => {
  it("returns the tier config", () => {
    expect(seatConfigFor({ seat: "peer", tier: "cheap" }, DEFAULT_SETTINGS).config.model).toBe("claude-haiku-4-5");
  });
  it("falls back to default for an unknown tier", () => {
    const r = seatConfigFor({ seat: "peer", tier: "nope" }, DEFAULT_SETTINGS);
    expect(r.config.model).toBe("claude-sonnet-5-5");
    expect(r.fallbackFrom).toBe("nope");
  });
});
describe("roomSettingsSchema", () => {
  it("accepts DEFAULT_SETTINGS", () => expect(roomSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true));
  it("rejects settings without a default tier", () => {
    const peerTiers = DEFAULT_SETTINGS.peerTiers.filter((t) => t.id !== "default");
    expect(roomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, peerTiers }).success).toBe(false);
  });
  it("rejects duplicate tier ids", () => {
    const peerTiers = [...DEFAULT_SETTINGS.peerTiers, DEFAULT_SETTINGS.peerTiers[0]];
    expect(roomSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, peerTiers }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests, expect FAIL** — `cd agent-room && npx vitest run shared/seats.test.ts` → fails, module missing.

- [ ] **Step 4: Implement `shared/seats.ts`** with the interfaces above. Marker regex anchored at the trimmed start: `/^\[room:(supervisor|lead|peer(?::([a-z0-9-]+))?)\]\s*/i`; lowercase the match; tier must then satisfy `^[a-z][a-z0-9-]*$` (so `Bad_Tier` fails on `_`). `seatTitle` = `${formatMarker(marker)} ${text.trim()}` sliced to 60.

- [ ] **Step 5: Run tests and typecheck** — `npx vitest run && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add agent-room && git commit -m "feat(agent-room): scaffold plugin and shared seat model"
```

---

### Task 2: Provider-neutral prompts and the system-prompt renderer

**Files:**
- Create: `agent-room/server/prompts/protocol.md`, `supervisor.md`, `lead.md`, `peer.md`
- Create: `agent-room/server/prompts/gen.mts`, `agent-room/server/prompts/generated.ts` (generated, committed)
- Create: `agent-room/server/render.ts`
- Test: `agent-room/server/prompts/prompts.test.ts`, `agent-room/server/render.test.ts`

**Interfaces:**
- Consumes: `SeatMarker`, `RoomSettings`, `formatMarker` (Task 1)
- Produces: `PROMPTS: { protocol: string; supervisor: string; lead: string; peer: string }` (from `generated.ts`); `renderSeatTable(marker: SeatMarker, settings: RoomSettings): string`; `renderSystemPrompt(marker: SeatMarker, settings: RoomSettings, existing?: string): string`

Why generated TS: Paseo bundles `index.server.ts`, so reading sibling `.md` files at runtime via a path is not reliable. `gen.mts` reads the four `.md` files and writes `generated.ts` as `export const PROMPTS = <JSON.stringify(...)> as const;`. Script: `"gen:prompts": "node server/prompts/gen.mts"` (Node 24 strips types natively).

Prompt sources: `~/.claude/skills/supervisor/PROTOCOL.md`, `SKILL.md` (Supervisor role, drop front matter), `roles/lead.md`, `roles/peer.md`. Keep authority, signals, dispositions, evidence and acceptance rules verbatim where they are provider-neutral. Rewrite per the spec's "Neutral protocol and roles" section:
- built-in `Agent`/`Task` rules → "never use your agent's own built-in sub-agent feature; delegate only with Paseo `create_agent`"
- remove `install.sh`, provider names `claude-*`/`codex-peer`, output styles, `CLAUDE_CONFIG_DIR`, `ROOM_DIR`, `$ARGUMENTS`, the tool-precondition fallback text about Supervisor profiles
- `list_profiles`/"Lead profile" lookups → "use the seat table at the end of this prompt"
- `slp-wait` sections → native `notifyOnFinish` (never pass `notifyOnFinish: false`); `paseo wait` only when a seat must block
- titles: Supervisor creates Leads titled `[room:lead] <workstream>`; Lead creates Peers titled `[room:peer:<tier>] <outcome>`; old `[Review]`, `[Committee]`, `[Advisor]` Peer kinds become tiers (`review`, or `default` with the purpose in the title text)
- forbid the detached `create_agent` form and creating agents through the `paseo` CLI

- [ ] **Step 1: Write the failing tests**

`prompts.test.ts`:
```ts
const FORBIDDEN = ["install.sh", "claude-lead", "claude-peer", "claude-supervisor", "codex-peer", "slp-wait",
  "CLAUDE_CONFIG_DIR", "ROOM_DIR", "$ARGUMENTS", "list_profiles", "output style"];
it.each(Object.entries(PROMPTS))("%s has no Claude/installer residue", (_name, text) => {
  for (const word of FORBIDDEN) expect(text).not.toContain(word);
});
it("protocol keeps the signal vocabulary", () => {
  for (const s of ["CANDIDATE", "REVIEW", "REOPEN_REQUEST", "DEPENDENCY_REQUEST", "BLOCKED", "QUESTION", "ACK",
    "ACCEPT", "REJECT", "REVISED BRIEF", "HOLD", "ANSWER", "DEFER", "DONE", "STATUS", "DECISION_NEEDED"])
    expect(PROMPTS.protocol).toContain(s);
});
it("roles name the room markers", () => {
  expect(PROMPTS.supervisor).toContain("[room:lead]");
  expect(PROMPTS.lead).toContain("[room:peer:");
});
it("generated.ts matches the markdown sources", async () => {
  for (const name of ["protocol", "supervisor", "lead", "peer"] as const)
    expect(PROMPTS[name]).toBe(await readFile(new URL(`./${name}.md`, import.meta.url), "utf8"));
});
```
`render.test.ts`:
```ts
it("supervisor prompt = protocol + supervisor role + lead seat line", () => {
  const p = renderSystemPrompt({ seat: "supervisor" }, DEFAULT_SETTINGS);
  expect(p).toContain(PROMPTS.protocol);
  expect(p).toContain(PROMPTS.supervisor);
  expect(p).toContain("[room:lead]");
  expect(p).toContain("claude/claude-opus-5-5");
  expect(p).not.toContain(PROMPTS.lead);
});
it("lead prompt lists every peer tier with marker, provider/model and useFor", () => {
  const p = renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS);
  for (const t of DEFAULT_SETTINGS.peerTiers) {
    expect(p).toContain(`[room:peer:${t.id}]`);
    expect(p).toContain(`${t.provider}/${t.model}`);
    expect(p).toContain(t.useFor);
  }
});
it("peer prompt names its tier and forbids spawning", () => {
  const p = renderSystemPrompt({ seat: "peer", tier: "cheap" }, DEFAULT_SETTINGS);
  expect(p).toContain(PROMPTS.peer);
  expect(p).toContain("cheap");
});
it("appends after an existing system prompt", () => {
  expect(renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS, "BASE").startsWith("BASE\n\n")).toBe(true);
});
```

- [ ] **Step 2: Run tests, expect FAIL** — `npx vitest run server` → modules missing.

- [ ] **Step 3: Write the four `.md` files** per the rewrite rules above.

- [ ] **Step 4: Implement `gen.mts`, run `npm run gen:prompts`, implement `render.ts`.** Join order: `existing`, `PROMPTS.protocol`, role text, `renderSeatTable(...)`, separated by `\n\n`, skipping empty parts. Seat table is a short markdown section titled `## Room seats` listing what this seat may create (Supervisor: the lead line; Lead: one row per tier; Peer: "your tier: <id>; you create no agents").

- [ ] **Step 5: Run tests and typecheck** → PASS.

- [ ] **Step 6: Commit** — `git add agent-room && git commit -m "feat(agent-room): provider-neutral room prompts and renderer"`

---

### Task 3: `before("agent.create")` — seat override and role injection

**Files:**
- Create: `agent-room/server/inject.ts`, `agent-room/server/settings.ts`
- Modify: `agent-room/index.server.ts`
- Test: `agent-room/server/inject.test.ts`, `agent-room/server/settings.test.ts`

**Interfaces:**
- Consumes: `parseSeatMarker`, `seatConfigFor`, `roomSettings`, `DEFAULT_SETTINGS` (Task 1); `renderSystemPrompt` (Task 2)
- Produces:
  - `type AgentCreateRequest = PluginBeforeRequests["agent.create"]` (from `@getpaseo/plugin/server`)
  - `applySeat(request: AgentCreateRequest, settings: RoomSettings): { request: AgentCreateRequest; marker: SeatMarker; fallbackFrom?: string } | null`
  - `createSettingsReader(settings: PluginSettings<typeof roomSettingsSchema>, log: Logger): () => Promise<RoomSettings>` — returns `values` when `status === "ready"`, else logs and returns `DEFAULT_SETTINGS`; never throws
  - `server/logger.ts` with `Logger = { info, warn, error }(message: string, data?: Record<string, unknown>)` writing to `console` (same shape as `schedule-sending/server/logger.ts`)

- [ ] **Step 1: Write the failing tests**

```ts
const base = (title: string | null, extra: Partial<AgentCreateRequest["config"]> = {}): AgentCreateRequest =>
  ({ config: { provider: "opencode", cwd: "/repo", title, model: "x", ...extra } });

it("returns null for unmarked and old-room titles", () => {
  for (const t of [null, "Fix it", "[Lead] old room", "[Peer] old"]) expect(applySeat(base(t), DEFAULT_SETTINGS)).toBeNull();
});
it("forces the seat's provider, model, mode, effort", () => {
  const r = applySeat(base("[room:peer:cheap] fmt"), DEFAULT_SETTINGS)!;
  expect(r.request.config).toMatchObject({ provider: "claude", model: "claude-haiku-4-5",
    modeId: "bypassPermissions", thinkingOptionId: "medium", cwd: "/repo", title: "[room:peer:cheap] fmt" });
});
it("drops provider-specific fields the seat leaves unset", () => {
  const settings = { ...DEFAULT_SETTINGS, lead: { provider: "opencode", model: "m" } };
  const r = applySeat(base("[room:lead] x", { modeId: "full-access", thinkingOptionId: "high", featureValues: { fast_mode: true } }), settings)!;
  expect(r.request.config.modeId).toBeUndefined();
  expect(r.request.config.thinkingOptionId).toBeUndefined();
  expect(r.request.config.featureValues).toBeUndefined();
});
it("appends the role prompt to an existing systemPrompt", () => {
  const r = applySeat(base("[room:lead] x", { systemPrompt: "BASE" }), DEFAULT_SETTINGS)!;
  expect(r.request.config.systemPrompt).toBe(renderSystemPrompt({ seat: "lead" }, DEFAULT_SETTINGS, "BASE"));
});
it("reports an unknown tier fallback", () => {
  expect(applySeat(base("[room:peer:zzz] x"), DEFAULT_SETTINGS)!.fallbackFrom).toBe("zzz");
});
it("keeps env untouched", () => {
  const req = { ...base("[room:lead] x"), env: { A: "1" } };
  expect(applySeat(req, DEFAULT_SETTINGS)!.request.env).toEqual({ A: "1" });
});
```
`settings.test.ts`: reader returns `values` for a `ready` state; returns `DEFAULT_SETTINGS` and logs once for an `invalid` state; returns `DEFAULT_SETTINGS` when `read()` rejects.

- [ ] **Step 2: Run tests, expect FAIL.**

- [ ] **Step 3: Implement `inject.ts`, `settings.ts`, `logger.ts`.** Copy `config` without `modeId`, `thinkingOptionId`, `featureValues`, then set `provider`, `model`, and the seat's optional fields only when defined; `featureValues` comes from `SeatConfig.features`.

- [ ] **Step 4: Wire in `index.server.ts`:** `const seats = server.registerSettings(roomSettings)`; `server.before("agent.create", async ({ request }) => { const applied = applySeat(request, await readSettings()); if (!applied) return; if (applied.fallbackFrom) log.warn("unknown peer tier", {...}); return applied.request; })`. The hook must return `undefined` (no change) for unmarked agents.

- [ ] **Step 5: Run tests and typecheck** → PASS.

- [ ] **Step 6: Install and probe injection live**

```bash
cd /Users/ultima/Workspace/paseo-plugins/agent-room && npm run typecheck
paseo plugin install /Users/ultima/Workspace/paseo-plugins/agent-room && paseo plugin ls
```
Expected: `agent-room running`. Then create one agent per provider (`claude`, `codex`, `opencode`) with title `[room:peer:default] probe` and prompt "Quote the first heading of your system instructions verbatim, nothing else." Expected: each answers with the protocol's first heading and runs on `claude/claude-sonnet-5-5` (the override wins even though you asked for another provider). Also check the `agent.turn_ended` timeline shape for later tasks: log `event.timeline.length` and item types once and note whether it carries only this turn's items or the full history. Record both results in `agent-room/docs/probe-results.md`; archive the probe agents.

- [ ] **Step 7: Commit** — `git add agent-room && git commit -m "feat(agent-room): inject seat config and role prompt on agent create"`

---

### Task 4: Persisted room store

**Files:**
- Create: `agent-room/shared/room.ts`, `agent-room/server/store.ts`
- Test: `agent-room/server/store.test.ts`

**Interfaces:**
- Consumes: `SeatMarker` (Task 1), `Logger` (Task 3)
- Produces (`shared/room.ts`, zod schemas + types, used by RPCs and client):
  - `RoomRecord = { id: string; task: string; cwd: string; workspaceId: string | null; createdAt: string; endedAt?: string }` (`id` = Supervisor agent id)
  - `SeatRecord = { agentId: string; roomId: string; parentId: string | null; marker: SeatMarker; provider: string; model: string; title: string }`
  - `FeedEvent = { id: string; roomId: string; at: string; kind: "message" | "guard" | "note"; from: string | null; to: string | null; label: string; text: string }` — `from`/`to` are agent ids, `null` means the user
  - `FEED_CAP_PER_ROOM = 500`, `FEED_TEXT_CAP = 4000`
- Produces (`server/store.ts`):
  - `resolveDataDir(env: Record<string, string | undefined>, home: string): string` → `<PASEO_HOME or ~/.paseo>/plugin-data/agent-room`
  - `createRoomStore(deps: { file: string; now: () => number; newId: () => string; log: Logger }): RoomStore`
  - `RoomStore = { load(): Promise<void>; addRoom(r: RoomRecord): void; addSeat(s: SeatRecord): void; seat(agentId: string): SeatRecord | undefined; children(agentId: string): SeatRecord[]; appendFeed(e: Omit<FeedEvent, "id" | "at"> & { at?: string }): FeedEvent; endRoom(roomId: string): void; listRooms(): RoomRecord[]; room(roomId: string): { room: RoomRecord; seats: SeatRecord[]; feed: FeedEvent[] } | undefined; flush(): Promise<void> }`

- [ ] **Step 1: Write the failing tests** (temp dir per test)

```ts
it("persists rooms, seats and feed across instances", async () => {
  const a = make(); await a.load();
  a.addRoom(room("R")); a.addSeat(seat("R", "R", null, { seat: "supervisor" })); a.addSeat(seat("L", "R", "R", { seat: "lead" }));
  a.appendFeed({ roomId: "R", kind: "message", from: "L", to: "R", label: "DONE", text: "ok" });
  await a.flush();
  const b = make(); await b.load();
  expect(b.room("R")!.seats.map((s) => s.agentId)).toEqual(["R", "L"]);
  expect(b.room("R")!.feed[0]).toMatchObject({ label: "DONE", from: "L", to: "R" });
  expect(b.children("R").map((s) => s.agentId)).toEqual(["L"]);
});
it("caps feed per room, dropping the oldest", async () => {
  // append FEED_CAP_PER_ROOM + 5 events labeled "#0".."#504" to room R
  expect(s.room("R")!.feed).toHaveLength(FEED_CAP_PER_ROOM);
  expect(s.room("R")!.feed[0].label).toBe("#5");
});
it("truncates long feed text", () => {
  const e = s.appendFeed({ roomId: "R", kind: "message", from: null, to: "R", label: "task", text: "x".repeat(FEED_TEXT_CAP + 100) });
  expect(e.text).toHaveLength(FEED_TEXT_CAP);
});
it("starts empty when the file is corrupt", async () => {
  // write "{not json" to rooms.json
  await expect(s.load()).resolves.toBeUndefined();
  expect(s.listRooms()).toEqual([]);
  expect(log.warn).toHaveBeenCalledOnce();
});
it("lists rooms newest first", () => {
  // addRoom A (createdAt 10:00), B (10:05)
  expect(s.listRooms().map((r) => r.id)).toEqual(["B", "A"]);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** One JSON file `rooms.json` (`{ version: 1, rooms, seats, feed }`), validated with the `shared/room.ts` schemas on load. Writes serialized through a promise chain, written to `rooms.json.tmp` then renamed; `flush()` awaits the chain.

- [ ] **Step 4: Run tests and typecheck** → PASS.

- [ ] **Step 5: Commit** — `git add agent-room && git commit -m "feat(agent-room): persisted room store"`

---

### Task 5: Room events — membership, guard, feed

**Files:**
- Create: `agent-room/server/guard.ts`, `agent-room/server/feed.ts`, `agent-room/server/events.ts`
- Modify: `agent-room/index.server.ts`
- Test: `agent-room/server/guard.test.ts`, `agent-room/server/feed.test.ts`, `agent-room/server/events.test.ts`

**Interfaces:**
- Consumes: `parseSeatMarker`, `seatConfigFor` (Task 1); `RoomStore`, `SeatRecord`, `FeedEvent` (Task 4); settings reader (Task 3)
- Produces:
  - `checkSpawn(parent: SeatMarker | null, child: SeatMarker | null): { allowed: true } | { allowed: false; rule: string }` — parent `null` (not a room seat) always allowed
  - `SIGNALS: readonly string[]` — every signal/disposition from Task 2's protocol test list
  - `labelFor(text: string, fallback: string): string` — first line's leading word(s) if they match `SIGNALS` (`REVISED BRIEF` is two words), else `fallback`
  - `feedFromTurn(input: { agent: SeatRecord; childIds: readonly string[]; timeline: readonly AgentTimelineItem[] }): Array<Pick<FeedEvent, "kind" | "from" | "to" | "label" | "text">>`
  - `createRoomEvents(deps: { store: RoomStore; readSettings: () => Promise<RoomSettings>; lookupTitle: (paseo: PaseoApi, agentId: string) => Promise<string | null>; log: Logger }): { onCreated(e: PluginLifecycleEvents["agent.created"], ctx: PluginHookContext): Promise<void>; onTurnEnded(e: PluginLifecycleEvents["agent.turn_ended"], ctx: PluginHookContext): Promise<void>; onArchived(e: PluginLifecycleEvents["agent.archived"], ctx: PluginHookContext): Promise<void> }`
  - Guard timeline row: `{ type: "plugin", id: "room-guard-<childId>", kind: "room-guard", version: 1, data: { childId: string; childTitle: string; violatorId: string; rule: string } }` (renderer in Task 8)

Guard table (from the spec):

| parent | allowed child |
|---|---|
| supervisor | lead |
| lead | peer (any tier) |
| peer | nothing |

`feedFromTurn` rules (the attribution heuristic the spec leaves to the builder, fixed here): for each `user_message` in the turn, `from` = the child id whose agent id appears in the text, else the agent's `parentId` (`null` for a Supervisor = the user), `to` = the agent, `label` = `labelFor(text, agent is supervisor && from === null ? "task" : "instruction")`. For the turn's last `assistant_message`, `from` = agent, `to` = `parentId`, `label` = `labelFor(text, "reply")`. If Task 3's probe showed the timeline is full history, use only items after the last `assistant_message` that precedes the final `user_message` run.

- [ ] **Step 1: Write the failing tests**

`guard.test.ts`:
```ts
it.each([
  [null, null, true], [null, { seat: "lead" }, true],
  [{ seat: "supervisor" }, { seat: "lead" }, true],
  [{ seat: "supervisor" }, { seat: "peer", tier: "default" }, false],
  [{ seat: "supervisor" }, null, false],
  [{ seat: "lead" }, { seat: "peer", tier: "cheap" }, true],
  [{ seat: "lead" }, { seat: "lead" }, false],
  [{ seat: "lead" }, { seat: "supervisor" }, false],
  [{ seat: "lead" }, null, false],
  [{ seat: "peer", tier: "default" }, { seat: "peer", tier: "default" }, false],
  [{ seat: "peer", tier: "default" }, null, false],
])("parent %j child %j → %s", (p, c, ok) => expect(checkSpawn(p as never, c as never).allowed).toBe(ok));
```
`feed.test.ts`: `labelFor("CANDIDATE abc\nmore", "x")` → `"CANDIDATE"`; `labelFor("REVISED BRIEF\n...", "x")` → `"REVISED BRIEF"`; `labelFor("please fix", "instruction")` → `"instruction"`; a Lead turn with a user message mentioning Peer id `P1` yields `from: "P1"`; a Lead turn with a plain user message yields `from: <supervisor id>`; a Supervisor turn with a plain user message yields `from: null, label: "task"`; final assistant text `"DONE\n..."` yields `{ from: lead, to: supervisor, label: "DONE" }`.

`events.test.ts` (fake store, fake `paseo` with `agents.ref(id)` returning spies for `archive`, `send`, `timeline.append`):
- `[room:supervisor]` created with no parent → `addRoom` + `addSeat`, task = title rest
- `[room:lead]` under a stored Supervisor → `addSeat` with that room, no archive
- `[room:peer:zzz]` (unknown tier) under a stored Lead → seat added with the `default` tier's model, plus one feed event `kind: "note"`, `label: "tier fallback"`, text naming `zzz` → `default` (the spec's "say so in the feed")
- `[room:peer:default]` under a stored Peer → child archived, violator (the Peer) gets one `send`, `room-guard` row appended to the Peer's parent (Lead), feed event `kind: "guard"`
- unmarked child under a stored Lead → archived, Lead gets one `send` naming `[room:peer:<tier>]`
- parent not in store but `lookupTitle` returns `"[room:peer:cheap] x"` → still archived (Review Focus 4)
- unmarked child of an unmarked parent → nothing called
- `agent.turn_ended` of a stored seat → feed events appended from `feedFromTurn`; of an unknown agent → nothing
- `agent.archived` of a room root → `endRoom`

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `guard.ts`, `feed.ts`, `events.ts`.** The violator message, one `send`, plain text: which agent was archived, the rule broken, and the correct marker to use. `lookupTitle` default implementation: `const h = paseo.agents.ref(id); await h.refresh(); return h.current()?.title ?? null`. Seat `provider` comes from the event; `model` from `seatConfigFor(marker, settings).config.model`.

- [ ] **Step 4: Wire in `index.server.ts`:** load the store from `resolveDataDir(process.env, os.homedir())`; `server.on("agent.created" | "agent.turn_ended" | "agent.archived", …)` → `events.on…`; each handler catches and logs, never throws. Cleanup awaits `store.flush()`.

- [ ] **Step 5: Run tests and typecheck** → PASS.

- [ ] **Step 6: Commit** — `git add agent-room && git commit -m "feat(agent-room): room membership, spawn guard and feed"`

---

### Task 6: RPCs — launch, list, get

**Files:**
- Create: `agent-room/shared/rpc.ts`, `agent-room/server/handlers.ts`
- Modify: `agent-room/index.server.ts`
- Test: `agent-room/server/handlers.test.ts`

**Interfaces:**
- Consumes: `RoomStore` (Task 4), settings reader (Task 3), `seatTitle` (Task 1)
- Produces (`shared/rpc.ts`, via `defineRpc`):
  - `launchRoomRpc` — name `room.launch`; input `{ task: string (min 1); workspaceId?: string; cwd?: string }` (one of the two required, refine); output `{ roomId: string }`
  - `listRoomsRpc` — `room.list`; input `{}`; output `{ rooms: RoomRecord[] }`
  - `getRoomRpc` — `room.get`; input `{ roomId: string }`; output `{ room: RoomRecord; seats: SeatRecord[]; feed: FeedEvent[] } | { missing: true }`
- Produces (`server/handlers.ts`): `createHandlers(deps: { store: RoomStore; readSettings: () => Promise<RoomSettings> }): { launch(input, paseo: PaseoApi): Promise<{ roomId: string }>; list(): …; get(input): … }`

- [ ] **Step 1: Write the failing tests** (fake `paseo`)
- `launch` with `workspaceId` calls `paseo.workspaces.ref(workspaceId).agents.create` with `title` = `seatTitle({ seat: "supervisor" }, task)`, `prompt` = full `task` (untruncated, Review Focus 5), `config.provider` = `"claude/claude-opus-5-5"`, `modeId` `bypassPermissions`, `thinkingOptionId` `xhigh`; returns the new agent id as `roomId`
- `launch` with `cwd` only calls `paseo.agents.create` with that `cwd`
- `launch` with a 300-char task → title length 60, prompt length 300
- `get` for an unknown room → `{ missing: true }`

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement handlers and register them with `server.handle`.** The room record itself is created by Task 5's `onCreated` when the Supervisor appears; `launch` only creates the agent.

- [ ] **Step 4: Run tests and typecheck** → PASS.

- [ ] **Step 5: Commit** — `git add agent-room && git commit -m "feat(agent-room): launch/list/get room RPCs"`

---

### Task 7: Room screen — seat editor and launch form

**Files:**
- Create: `agent-room/client/seat-editor.tsx`, `agent-room/client/launch-form.tsx`, `agent-room/client/rooms-screen.tsx`, `agent-room/client/settings-draft.ts`
- Modify: `agent-room/index.client.tsx`
- Test: `agent-room/client/settings-draft.test.ts`

**Interfaces:**
- Consumes: `roomSettings`, `RoomSettings`, `PeerTier`, `DEFAULT_SETTINGS` (Task 1); `launchRoomRpc`, `listRoomsRpc` (Task 6)
- Produces:
  - `settings-draft.ts` pure reducers: `setSeat(draft: RoomSettings, key: "supervisor" | "lead", patch: Partial<SeatConfig>): RoomSettings`; `setTier(draft, id: string, patch: Partial<PeerTier>): RoomSettings`; `addTier(draft, id: string): RoomSettings` (copies `default`); `removeTier(draft, id: string): RoomSettings` (refuses `default`); `changeProvider(seat: SeatConfig, provider: string): SeatConfig` (clears `model`, `modeId`, `thinkingOptionId`, `features`)
  - Screen id `rooms` (title "Room"), sidebar header item id `rooms` (icon `Users`), Command Center item id `open-rooms` (global)

The screen has three sections: **Seats** (one `SeatEditor` per seat and tier), **Launch** (task `TextInput`, workspace picker defaulting to the current one if known, otherwise a cwd field, Launch button → `launchRoomRpc` → `openScreen({ screenId: "room", params: { roomId } })`), **Rooms** (list from `listRoomsRpc`, newest first, tap → room screen). `SeatEditor` pickers: providers from `usePaseo().providers.snapshot()`, models from `listModels(provider)`, modes from `listModes(provider)`, effort from the selected model's thinking options, features via `listFeatures({ provider: "<p>/<m>" })`. Save with `useSettings(roomSettings).save(values, revision)`; show `saveError`.

- [ ] **Step 1: Write the failing tests** for the reducers: `changeProvider` clears the four dependent fields; `removeTier(draft, "default")` returns the draft unchanged; `addTier` copies `default`'s config with the new id and an empty `useFor`; every reducer output still passes `roomSettingsSchema` when the input did (except `addTier`, which needs a `useFor` before saving — assert the schema rejects it, so Save stays disabled).

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement reducers, components, registrations.** **Step 4: Run tests, typecheck, mobile audit:**

```bash
npx vitest run && npm run typecheck
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
```
Expected: tests pass, no audit hits.

- [ ] **Step 5: Reload and check in the app** — `paseo plugin reload agent-room`; open Room from the sidebar; change the Lead's provider, save, reload the plugin, confirm the value persisted (acceptance 1); check a narrow window and a dark theme.

- [ ] **Step 6: Commit** — `git add agent-room && git commit -m "feat(agent-room): Room screen with seat editor and launch"`

---

### Task 8: Live view, `/room`, guard row renderer

**Files:**
- Create: `agent-room/client/view-model.ts`, `agent-room/client/room-screen.tsx`, `agent-room/client/guard-row.tsx`
- Modify: `agent-room/index.client.tsx`
- Test: `agent-room/client/view-model.test.ts`

**Interfaces:**
- Consumes: `getRoomRpc`, `launchRoomRpc` (Task 6); `SeatRecord`, `FeedEvent` (Task 4); guard row shape (Task 5)
- Produces:
  - `buildTree(seats: SeatRecord[]): TreeNode[]` with `TreeNode = { seat: SeatRecord; depth: number }`, depth-first, children in insertion order, root first
  - `feedRows(feed: FeedEvent[], seats: SeatRecord[]): FeedRow[]` with `FeedRow = { id: string; time: string /* HH:MM */; fromLabel: string; toLabel: string; label: string; text: string; kind: FeedEvent["kind"] }`; seat labels: `Sup`, `Lead`, `Peer:<tier>`; `null` → `You`; unknown id → first 8 chars
  - Screen id `room` (title from params: "Room"), slash command `room` (context `workspace`, argumentHint `<task>`), timeline renderer `kind: "room-guard", version: 1`

Layout per the spec mockup: wide = tree column left, feed right; `layout.compact` = tree above feed. Tree row: indentation by depth, seat label, `provider/model`, live status via `useAgent(seat.agentId, (a) => a.status)`; tap → open that agent. Feed polls `getRoomRpc` with react-query `refetchInterval: 2000`; guard rows styled with `theme.colors` warning tone; tap a row to expand full text. `/room <task>`: empty args → `openScreen({ screenId: "rooms" })`; else `rpc(launchRoomRpc, { task: args, workspaceId: workspace.id })` then `openScreen({ screenId: "room", params: { roomId } })`.

- [ ] **Step 1: Write the failing tests** — `buildTree` on Sup → Lead → [PeerA, PeerB] yields depths `[0, 1, 2, 2]` in that order; a seat whose parent is missing is placed at depth 0 after the root; `feedRows` maps `from: null` to `You`, a lead id to `Lead`, a peer to `Peer:cheap`, formats `at` as local `HH:MM`.

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run tests, typecheck, mobile audit (same commands as Task 7).**

- [ ] **Step 5: Reload and check** — `/room write a haiku about the repo into HAIKU.md` in a workspace composer → the room screen opens; the tree shows the Supervisor; the feed shows `You→Sup task`.

- [ ] **Step 6: Commit** — `git add agent-room && git commit -m "feat(agent-room): live room view, /room command, guard row"`

---

### Task 9: Command Code honors `systemPrompt` (in `command-code-provider`)

**Files (repo `command-code-provider/`, own git):**
- Create: `command-code-provider/server/system-prompt-mod.ts`
- Modify: `command-code-provider/server/acp-connector.ts`, `command-code-provider/server/provider.ts`
- Modify: `command-code-provider/package.json` (add `vitest` dev dep and `"test": "vitest run"`)
- Test: `command-code-provider/server/system-prompt-mod.test.ts`

**Interfaces:**
- Produces:
  - `SYSTEM_PROMPT_MOD_SOURCE: string` — plain-JS Command Code mod (`.mjs`), body below
  - `extractSystemPrompt(message: AcpStreamMessage): string | undefined` — returns `params._meta._paseo.systemPrompt` when `message` is a request with `method` `session/new` or `session/load` and the value is a non-empty string
  - `ensureModFile(dir: string): Promise<string>` — writes `SYSTEM_PROMPT_MOD_SOURCE` to `<dir>/system-prompt-mod.mjs` if missing or different; returns the path
  - `createAcpConnector(launch, fallback, observe, promptChannel?: { modPath: string; promptFile: string })` — new optional 4th parameter

Mod source (exact behavior; the prompt must be byte-stable across rounds, so read once):
```js
import { readFileSync } from "node:fs";
export default function (cmd) {
  cmd.addFlag("system-prompt-file", { type: "string", default: "", description: "File with the Paseo session system prompt" });
  let cached;
  cmd.hooks({
    appendSystemPrompt() {
      if (cached === undefined) {
        const file = cmd.getFlag("system-prompt-file");
        try { cached = file ? readFileSync(file, "utf8") : ""; } catch { cached = ""; }
      }
      return cached || undefined;
    },
  });
}
```

Connector behavior: when `promptChannel` is given, spawn with extra args `--mod <modPath> --mod-option system-prompt-file=<promptFile>`; in `writable.write`, before forwarding, `const p = extractSystemPrompt(message); if (p) writeFileSync(promptFile, p)`; on child `close`, remove `promptFile` (ignore errors). `provider.ts` `connect`: `modPath = await ensureModFile(<PASEO_HOME or ~/.paseo>/plugin-data/command-code)`, `promptFile = <that dir>/prompts/<randomUUID()>.md` (mkdir `prompts`), pass both into the connector via `connectionState`.

- [ ] **Step 1: Branch and probe the CLI**

```bash
cd /Users/ultima/Workspace/paseo-plugins/command-code-provider && git switch -c feat/agent-room
cmd acp --help 2>&1 | grep -E "mod" ; cmd --help 2>&1 | grep -E "^\s+--mod"
```
Determine whether `--mod`/`--mod-option` go before or after `acp` (changelog: "cmd acp can load --mod and mod options"). Then write the mod to a temp file and run `cmd mods inspect <file>`; expected: it reports an `appendSystemPrompt` hook and a `system-prompt-file` flag. If `node:fs` imports are rejected in mods, stop and report before choosing another channel.

- [ ] **Step 2: Write the failing tests** — `extractSystemPrompt` returns the prompt for a `session/new` request carrying `_meta._paseo.systemPrompt: "ROLE"`, `undefined` for `session/prompt`, for a response, for a missing `_meta`, and for an empty string; `ensureModFile` writes once and rewrites when the file content differs; `SYSTEM_PROMPT_MOD_SOURCE` contains `appendSystemPrompt` and `system-prompt-file`.

- [ ] **Step 3: Run, expect FAIL.** `npm install -D vitest && npx vitest run`.

- [ ] **Step 4: Implement** `system-prompt-mod.ts`, connector and provider changes.

- [ ] **Step 5: Run tests and typecheck** — `npx vitest run && npm run typecheck` → PASS.

- [ ] **Step 6: Reload and verify live** — `paseo plugin reload command-code`; create a `command-code` agent with title `[room:peer:default] probe` while the `default` tier is temporarily set to `command-code/<a Command Code model>` in the Room screen; ask it to quote the first heading of its system instructions. Expected: the protocol heading. Create a plain `command-code` agent (no marker): it behaves as before, and no prompt file stays behind after it closes. Restore the tier.

- [ ] **Step 7: Commit (in `command-code-provider`)** — `git add server package.json package-lock.json && git commit -m "feat: deliver Paseo system prompts to Command Code through a mod"`

---

### Task 10: OVERVIEW, known limits, end-to-end acceptance

**Files:**
- Create: `agent-room/OVERVIEW.md`
- Modify: `command-code-provider/OVERVIEW.md` (the "Paseo tools are not injected" line is stale; state that `systemPrompt` is honored via the bundled mod)

`agent-room/OVERVIEW.md` follows the listing contract in the `paseo-plugin` skill (what it does, how it works, setup, capabilities, limits; sentence case, no em dashes, no install commands). Known limits section, verbatim facts from the spec: provider-native sub-agents are invisible to the guard; Leads' schedule/heartbeat tools cannot be disabled per seat; `notifyOnFinish: false` cannot be forced on; agents created without a parent link (detached `create_agent`, `paseo` CLI) escape the guard; seat config is global across rooms.

- [ ] **Step 1: Write both OVERVIEW files; run `npm run typecheck && npm test` in both plugins** → PASS; `paseo plugin ls` → `agent-room` and `command-code` `running`, no error.

- [ ] **Step 2: Acceptance run (with the user watching)** — in the Room screen set: Supervisor `command-code/<model>`, Lead `claude/claude-opus-5-5`, tier `default` `opencode/<model>`, tier `cross-family` `codex/gpt-5.6-sol`. Launch a real small task in a scratch repo. Check, and write each result to `agent-room/docs/acceptance-2026-10-28.md` with agent ids:
  1. settings persisted after `paseo plugin reload agent-room`
  2. each seat runs on its configured provider/model (agent details), and its first lines follow the protocol (signals on the first line; the Lead does not edit files itself)
  3. reports reach parents via `notifyOnFinish`; the live view shows the tree and labeled feed while it runs
  4. tell a Peer to call `create_agent`; its child is archived, the Peer receives the rule message, the feed shows a guard row, the Lead timeline shows the `room-guard` row
  5. `/room <task>` starts a second room with saved defaults
  6. an old-room agent (`claude-lead` provider, title `[Lead] …`) is created unchanged: same provider/model, no `[room:` text in its prompt

- [ ] **Step 3: Commit** — root repo: `git add agent-room docs && git commit -m "docs(agent-room): overview, known limits, acceptance record"`; `command-code-provider`: `git add OVERVIEW.md && git commit -m "docs: system prompt support"`.
