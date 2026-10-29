# Agent Room Phase 3 (GC Port) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the bash `slp-gc` (1359 lines) into `agent-room/server/gc/` as typed modules with identical rules, replace its conf file with plugin settings and its launchd tick with a 60 s plugin interval, add a GC screen, and delete the bash tool only after a field-by-field equivalence diff.

**Architecture:** One module per bash phase under `agent-room/server/gc/`, rules copied rather than redesigned, with the report JSON shape preserved. A `scheduler.ts` interval drives `tick.ts`; settings come from a Zod schema with a one-time `slp-gc.conf` import; state moves to `$PASEO_HOME/plugin-data/agent-room/gc/`. The client gets one screen and one sidebar row. Safety rules are proven by unit tests over injected `ps`/`top`/agent snapshots plus golden fixtures captured from the live bash.

**Tech Stack:** TypeScript, zod, vitest, `@getpaseo/plugin` 0.13.1 (`PluginServerContext`, `PluginHandlerContext.paseo`, `spawnProcess`/`execCommand`), React Native primitives via `@getpaseo/plugin/client`.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-room-plugin-phase3-gc-design.md`

## Global Constraints

- **No rule changes.** Every predicate — garbage, stale, over-memory, orphan proof, protected classes, budget, max kills — ports with the same semantics and the same failure direction (closed). Where a rule is unclear, the reference implementation wins, not a cleaner rewrite.
- **Destructive rules default off.** `apply`, `killStale`, `killMemory` are off until enabled individually; enabling each requires a confirm dialog naming what will be signalled.
- **Never signalled, ever:** the daemon, the Supervisor, the app main, a `claude-child`/`codex-child` itself, anything in the invoking agent's own tree, anything with an unreadable env, any class not in the allowlist.
- **The tick lives in the plugin.** No launchd job is created. The launchd job and `~/.config/slp-room` are removed only in Task 14, after the equivalence diff in Task 13 is clean, each confirmed in chat.
- **Settings import once.** `~/.config/slp-room/slp-gc.conf` is read exactly once, on first settings load; after that the file is never read. Invalid lines are logged, not fatal — a broken GC setting must never stop the room plugin from loading.
- **State:** all GC state under `$PASEO_HOME/plugin-data/agent-room/gc/`. Migration is copy-only; `~/Library/Logs/slp-gc` is never written and never deleted.
- **macOS-first:** `top` parsing has an RSS fallback; no new platform-specific code beyond what the reference already does.
- **No room behaviour changes:** existing room tests, `npm run typecheck`, and `paseo plugin ls` (agent-room `running`) must stay green at every task boundary.
- Work happens on branch `feat/agent-room-gc`. Never commit to `main`.

## Review Focus

1. **A live process that merely looks orphaned** (env unreadable, ledger missing, owner record unknown) must be reported, never signalled — the reference fails closed on all four; a "simplified" proof here is how a GC kills live work. Pinned in Task 7.
2. **Over-memory eligibility must exclude the daemon, Supervisor, app main and agent children even at 40 GB**, and must require the allowlisted comm for descendants — pinned by the table-driven test in Task 6.
3. **A failed index read must refuse every reclamation** rather than delete a subset, and the refusal must be visible in the report — pinned in Tasks 8 and 11.
4. **A malformed `slp-gc.conf` must not break settings**: import logs and ignores bad lines, `settings.status` stays usable, and the room plugin still starts — pinned in Task 2.
5. **A tick must not overlap or outlive the plugin**: an interval tick during a running tick is dropped, and the returned cleanup clears the timer so a plugin reload leaves exactly one timer — pinned in Task 12.

---

### Task 1: Reference capture and fixture harness

**Files:**
- Create: `agent-room/docs/gc-port/slp-gc.bash` (verbatim copy of the live tool)
- Create: `agent-room/docs/gc-port/slp-gc.conf`
- Create: `agent-room/server/gc/__fixtures__/` (captured report + ps/top/env samples)
- Create: `agent-room/server/gc/fixtures.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `REFERENCE_BASH` path, `__fixtures__/report-clean.json`, `report-candidates.json`, `ps.txt`, `top.txt`, `env.txt`, `agents.json`, `schedules.json`, and a loader used by every later test.

- [ ] **Step 1: Copy the live reference into the repo (it is the port source)**

```bash
cd /Users/ultima/Workspace/paseo-plugins
mkdir -p agent-room/docs/gc-port
cp ~/.config/slp-room/bin/slp-gc agent-room/docs/gc-port/slp-gc.bash
cp ~/.config/slp-room/slp-gc.conf agent-room/docs/gc-port/slp-gc.conf
wc -l agent-room/docs/gc-port/slp-gc.bash
```

Expected: `1359 agent-room/docs/gc-port/slp-gc.bash`.

- [ ] **Step 2: Capture golden fixtures from the live tool**

```bash
cd /Users/ultima/Workspace/paseo-plugins/agent-room
mkdir -p server/gc/__fixtures__
SLP_GC_STATE_DIR="$PWD/server/gc/__fixtures__/state" \
  bash docs/gc-port/slp-gc.bash report --json > server/gc/__fixtures__/report-live.json
python3 - <<'PY'
import json, pathlib
r = json.loads(pathlib.Path("server/gc/__fixtures__/report-live.json").read_text())
print("top-level keys:", sorted(r))
print("procs:", len(r["procs"]["procs"]), "orphans:", len(r["procs"]["orphans"]), "garbage:", len(r["garbage"]))
PY
```

Expected: keys exactly `['agents','daemonMetrics','garbage','generated','home','index','procs','retention','schedules','transcripts','version']`; `version: 1`.

- [ ] **Step 3: Write the failing fixture loader test**

```ts
// agent-room/server/gc/fixtures.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "__fixtures__");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

describe("gc fixtures", () => {
  it("captured report keeps the reference shape", () => {
    const report = JSON.parse(read("report-live.json"));
    expect(report.version).toBe(1);
    expect(Object.keys(report).sort()).toEqual([
      "agents", "daemonMetrics", "garbage", "generated", "home", "index",
      "procs", "retention", "schedules", "transcripts", "version",
    ]);
    expect(report.procs).toHaveProperty("ident.ok");
    expect(Array.isArray(report.procs.procs)).toBe(true);
  });

  it("captured process and top samples are non-empty", () => {
    expect(read("ps.txt").trim().length).toBeGreaterThan(0);
    expect(read("top.txt").split("\n").filter(Boolean).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Capture the process samples the same test expects**

```bash
cd /Users/ultima/Workspace/paseo-plugins/agent-room
ps -axww -o pid=,ppid=,pgid=,etime=,rss=,lstart=,command= > server/gc/__fixtures__/ps.txt
top -l 1 -stats pid,mem,cmprs 2>/dev/null | awk 'NR>12 && NF>=3 {print $1" "$2" "$3}' > server/gc/__fixtures__/top.txt
wc -l server/gc/__fixtures__/ps.txt server/gc/__fixtures__/top.txt
```

Expected: both files non-empty (hundreds of ps rows, tens of top rows).

- [ ] **Step 5: Run the test — expect it to fail only if a fixture is missing**

Run: `cd agent-room && npx vitest run server/gc/fixtures.test.ts`
Expected: PASS. If it fails, the named file is missing — capture it, do not weaken the assertion.

- [ ] **Step 6: Commit**

```bash
git add agent-room/docs/gc-port agent-room/server/gc
git commit -m "test(agent-room): capture gc port reference and fixtures"
```

---

### Task 2: GC types and settings with one-time conf import

**Files:**
- Create: `agent-room/shared/gc.ts` (settings schema + report types)
- Create: `agent-room/server/gc/settings.ts`
- Create: `agent-room/server/gc/settings.test.ts`

**Interfaces:**
- Consumes: `__fixtures__/slp-gc.conf` copied in Task 1.
- Produces:
  - `gcSettings` — zod schema with every knob.
  - `DEFAULT_GC_SETTINGS: GcSettings`
  - `parseConf(text: string, log): { values: Partial<GcSettings>; problems: string[] }`
  - `createGcSettingsReader(settings, { confPath, log }): Promise<GcSettings>` — imports once, memoized for the process lifetime.

- [ ] **Step 1: Write the failing tests**

```ts
// agent-room/server/gc/settings.test.ts
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GC_SETTINGS, parseConf } from "./settings";

const conf = `
# comment
SLP_GC_APPLY=0
SLP_GC_MEM_WARN_MB=2048
SLP_GC_MEM_KILL_MB=1024
SLP_GC_ORPHAN_MIN_AGE_MIN=5
SLP_GC_KILL_COMMS=node bun
SLP_GC_MAX_KILLS=3
SLP_GC_REPORT_INTERVAL_MIN=15
SLP_GC_UNKNOWN_KEY=1
SLP_GC_TICK_BUDGET_S=abc
SLP_GC_APPLY=1
`;

describe("gc settings import", () => {
  it("defaults are the reference defaults and every rule is off", () => {
    expect(DEFAULT_GC_SETTINGS.apply).toBe(false);
    expect(DEFAULT_GC_SETTINGS.killStale).toBe(false);
    expect(DEFAULT_GC_SETTINGS.killMemory).toBe(false);
    expect(DEFAULT_GC_SETTINGS.memWarnMb).toBe(3072);
    expect(DEFAULT_GC_SETTINGS.memKillMb).toBe(4096);
    expect(DEFAULT_GC_SETTINGS.orphanMinAgeMin).toBe(10);
    expect(DEFAULT_GC_SETTINGS.maxKills).toBe(10);
    expect(DEFAULT_GC_SETTINGS.tickBudgetS).toBe(45);
    expect(DEFAULT_GC_SETTINGS.reportIntervalMin).toBe(60);
  });

  it("last value wins and a flag is on only when exactly 1", () => {
    const { values } = parseConf(conf, vi.fn());
    expect(values.apply).toBe(true);
    expect(values.memWarnMb).toBe(2048);
  });

  it("clamps kill below warn and to the 1024 floor", () => {
    const { values } = parseConf(conf, vi.fn());
    expect(values.memKillMb).toBe(2048);
  });

  it("logs unknown keys and invalid numbers instead of throwing", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { problems } = parseConf(conf, log as never);
    expect(problems.join("\n")).toContain("SLP_GC_UNKNOWN_KEY");
    expect(problems.join("\n")).toContain("SLP_GC_TICK_BUDGET_S");
  });

  it("empty conf yields defaults", () => {
    expect(parseConf("", vi.fn()).values).toEqual({});
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd agent-room && npx vitest run server/gc/settings.test.ts`
Expected: FAIL with `Cannot find module './settings'`.

- [ ] **Step 3: Implement the schema, defaults and parser**

```ts
// agent-room/shared/gc.ts (excerpt — full schema lists every knob)
export interface GcSettings {
  apply: boolean; killStale: boolean; killMemory: boolean;
  memWarnMb: number; memKillMb: number; treeWarnMb: number | null;
  killComms: string[]; orphanMinAgeMin: number; testConcurrencyWarn: number;
  maxKills: number; tickBudgetS: number; reportIntervalMin: number; cliTimeoutS: number;
}

export const DEFAULT_KILL_COMMS = [
  "node","bun","deno","npm","npx","pnpm","yarn","esbuild","tsc","vitest","jest",
  "python","python3","uv","pytest","ruby","java","gradle","go","cargo",
];
```

```ts
// agent-room/server/gc/settings.ts
import { DEFAULT_KILL_COMMS, type GcSettings } from "../../shared/gc";

export const DEFAULT_GC_SETTINGS: GcSettings = {
  apply: false, killStale: false, killMemory: false,
  memWarnMb: 3072, memKillMb: 4096, treeWarnMb: null,
  killComms: DEFAULT_KILL_COMMS, orphanMinAgeMin: 10, testConcurrencyWarn: 3,
  maxKills: 10, tickBudgetS: 45, reportIntervalMin: 60, cliTimeoutS: 30,
};

type Log = { info(msg: string, extra?: unknown): void; warn(msg: string, extra?: unknown): void; error(msg: string, extra?: unknown): void };

const INT_KEYS = {
  SLP_GC_MEM_WARN_MB: "memWarnMb", SLP_GC_MEM_KILL_MB: "memKillMb",
  SLP_GC_TREE_WARN_MB: "treeWarnMb", SLP_GC_ORPHAN_MIN_AGE_MIN: "orphanMinAgeMin",
  SLP_GC_TEST_CONCURRENCY_WARN: "testConcurrencyWarn", SLP_GC_MAX_KILLS: "maxKills",
  SLP_GC_TICK_BUDGET_S: "tickBudgetS", SLP_GC_REPORT_INTERVAL_MIN: "reportIntervalMin",
  SLP_GC_CLI_TIMEOUT: "cliTimeoutS",
} as const;
const FLAG_KEYS = {
  SLP_GC_APPLY: "apply", SLP_GC_KILL_STALE: "killStale", SLP_GC_KILL_MEMORY: "killMemory",
} as const;

/** Parse `slp-gc.conf`: comments skipped, last value wins, flags on only when exactly "1". */
export function parseConf(text: string, log: Pick<Log, "warn">): { values: Partial<GcSettings>; problems: string[] } {
  const values: Partial<GcSettings> = {};
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) { problems.push(`unparseable line: ${line}`); continue; }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key in FLAG_KEYS) {
      const field = FLAG_KEYS[key as keyof typeof FLAG_KEYS];
      values[field] = value === "1";
      continue;
    }
    if (key === "SLP_GC_KILL_COMMS" || key === "SLP_GC_ORPHAN_COMMS") {
      values.killComms = value.split(/\s+/).filter(Boolean);
      continue;
    }
    const field = INT_KEYS[key as keyof typeof INT_KEYS];
    if (field === undefined) { problems.push(`unknown key: ${key}`); continue; }
    if (!/^\d{1,12}$/.test(value)) { problems.push(`invalid number for ${key}: ${value}`); continue; }
    (values as Record<string, unknown>)[field] = Number(value);
  }
  if (values.memWarnMb !== undefined && values.memKillMb === undefined) {
    values.memKillMb = Math.max(values.memWarnMb, DEFAULT_GC_SETTINGS.memKillMb);
  }
  if (values.memKillMb !== undefined) {
    const floor = Math.max(1024, values.memWarnMb ?? DEFAULT_GC_SETTINGS.memWarnMb);
    values.memKillMb = Math.max(floor, values.memKillMb);
  }
  for (const problem of problems) log.warn("gc conf import", { problem });
  return { values, problems };
}
```

`createGcSettingsReader` reads the conf **once** (module-level memo keyed by resolved path), merges over defaults, logs `gc conf imported` with the changed key count, and returns the merged settings. If the file is absent it logs once and returns defaults. It never throws: an unreadable file is logged and treated as absent.

```ts
// agent-room/server/gc/settings.ts (excerpt)
let imported: Promise<GcSettings> | null = null;

export function createGcSettingsReader(input: {
  confPath: string; log: Log; readFile?: (path: string) => Promise<string>;
}): Promise<GcSettings> {
  if (imported !== null) return imported;
  imported = (async () => {
    let text: string;
    try {
      text = await (input.readFile ?? ((p) => import("node:fs/promises").then((fs) => fs.readFile(p, "utf8"))))(input.confPath);
    } catch {
      input.log.info("gc conf absent; using defaults", { path: input.confPath });
      return DEFAULT_GC_SETTINGS;
    }
    const { values, problems } = parseConf(text, input.log);
    const merged = { ...DEFAULT_GC_SETTINGS, ...values };
    input.log.info("gc conf imported", { keys: Object.keys(values).length, problems: problems.length });
    return merged;
  })();
  return imported;
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/settings.test.ts`
Expected: 5/5 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/shared/gc.ts agent-room/server/gc/settings.ts agent-room/server/gc/settings.test.ts
git commit -m "feat(agent-room): gc settings schema with one-time conf import"
```

---

### Task 3: Process collection and classification

**Files:**
- Create: `agent-room/server/gc/procs.ts`
- Create: `agent-room/server/gc/procs.test.ts`

**Interfaces:**
- Consumes: raw `ps`/`top`/env text.
- Produces:
  - `parseEtime(input: string): number`
  - `classify(cmd: string): ProcClass`
  - `parsePs(text: string): { rows: ProcRow[]; badRows: number; dupes: number }`
  - `parseTop(text: string): Map<number, { mem: number; cmprs: number }>`
  - `buildProcTable(input: ProcTableInput): ProcTable` — classes, owners, footprint, `protected`, `underDaemon` come from Task 6.

- [ ] **Step 1: Write the failing classification tests (table-driven, one row per reference regex)**

```ts
// agent-room/server/gc/procs.test.ts
import { describe, expect, it } from "vitest";
import { classify, parseEtime, parsePs } from "./procs";

describe("classify", () => {
  const cases: Array<[string, string | null]> = [
    ["/Applications/Paseo.app/Contents/MacOS/Paseo", "app-main"],
    ["Paseo Supervisor", "supervisor"],
    ["Paseo Daemon", "daemon"],
    ["Paseo Helper (Renderer) --type=renderer", "renderer"],
    ["Paseo Helper (GPU) --type=gpu-process", "gpu"],
    ["Paseo Helper --type=utility", "utility"],
    ["/usr/local/bin/claude --output-format stream-json --input-format stream-json --permission-prompt-tool x", "claude-child"],
    ["/usr/local/bin/codex app-server --port 0", "codex-child"],
    ["/usr/local/bin/claude --print hi", null],
    ["/usr/bin/git status", null],
  ];
  it.each(cases)("%s", (cmd, expected) => {
    expect(classify(cmd)).toBe(expected);
  });
});

describe("parseEtime", () => {
  it("handles the three shapes ps emits", () => {
    expect(parseEtime("05:12")).toBe(312);
    expect(parseEtime("16:03:22")).toBe(57802);
    expect(parseEtime("2-01:02:03")).toBe(176523);
  });
});

describe("parsePs", () => {
  it("counts unreadable rows instead of throwing", () => {
    const text = [
      "  101   1  101 05:12 20480 Mon Oct 27 10:00:00 2026 Paseo Supervisor",
      "garbage line that does not match",
    ].join("\n");
    const parsed = parsePs(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ pid: 101, ppid: 1, rss_mb: 20 });
    expect(parsed.badRows).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/procs.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement, transliterating the reference**

Port from `docs/gc-port/slp-gc.bash`:
- `parse_etime` (~line 70) → `parseEtime`.
- `classify` inside `PROCS_JQ` (the `def classify` block, ~line 275) → an ordered regex list; order is load-bearing (`app-main` before helpers, `claude-child` requires all three flags).
- The `ps` capture regex and the `top` parser (`top_parse`, ~line 605) → `parsePs`, `parseTop`.
- Duplicate-pid detection: `rows.length - new Set(rows.map(r => r.pid)).size`, reported as `dupes` (identity refuses on it).

Rules to preserve exactly:
- Missing `top` row → `footprintSource: "rss"`, `mem_mb: null`.
- `rss_mb` rounded to one decimal from KB.
- Unparseable `ps` rows are counted, skipped, never fatal.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/procs.test.ts`
Expected: 14/14 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/procs.ts agent-room/server/gc/procs.test.ts
git commit -m "feat(agent-room): gc process parsing and classification"
```

---

### Task 4: Agent and schedule snapshots through the Paseo API

**Files:**
- Create: `agent-room/server/gc/agents.ts`
- Create: `agent-room/server/gc/agents.test.ts`

**Interfaces:**
- Consumes: `PaseoApi` from `PluginHandlerContext`.
- Produces:
  - `interface AgentRec { id: string; provider: string; archivedAt: string | null; archivedEpoch: number | null; status: string | null; cwd: string | null; internal: boolean; labels: Record<string,string>; parent: string | null; sessionId: string | null; strict: boolean }`
  - `interface ScheduleRec { id: string; name: string | null; status: string; targetType: string; targetAgent: string | null; lastRunAt: string | null; nextRunAt: string | null; runs: number; runsRunning: number; fail24h: number }`
  - `snapshotAgents(paseo): Promise<{ agents: AgentRec[]; index: { ok: boolean; why: string[] } }>`
  - `snapshotSchedules(paseo): Promise<{ schedules: ScheduleRec[]; index: { ok: boolean; why: string[] } }>`

- [ ] **Step 1: Write the failing tests**

```ts
// agent-room/server/gc/agents.test.ts
import { describe, expect, it, vi } from "vitest";
import { snapshotAgents, snapshotSchedules } from "./agents";

describe("snapshotAgents", () => {
  it("maps API records and marks index ok", async () => {
    const paseo = {
      agents: { list: vi.fn(async () => ({ agents: [
        { id: "a1", provider: "claude", archivedAt: null, lastStatus: "idle", cwd: "/tmp" },
        { id: "a2", provider: "command-code", archivedAt: "2026-10-01T00:00:00Z", lastStatus: "idle", cwd: null },
      ] })) },
    } as never;
    const { agents, index } = await snapshotAgents(paseo);
    expect(index.ok).toBe(true);
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(agents[1].archivedEpoch).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
  });

  it("a failed read yields an incomplete index and no agents", async () => {
    const paseo = { agents: { list: vi.fn(async () => { throw new Error("boom"); }) } } as never;
    const { agents, index } = await snapshotAgents(paseo);
    expect(agents).toEqual([]);
    expect(index.ok).toBe(false);
    expect(index.why.join()).toContain("boom");
  });
});

describe("snapshotSchedules", () => {
  it("counts failures in the last 24h", async () => {
    const now = Math.floor(Date.now() / 1000);
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const paseo = { scheduleList: vi.fn(async () => ({ schedules: [
      { id: "s1", status: "active", target: { type: "agent", agentId: "a1" },
        runs: [{ startedAt: iso(now - 60), status: "failed", error: "boom" }, { startedAt: iso(now - 7200), status: "ok" }] },
    ] })) } as never;
    const { schedules } = await snapshotSchedules(paseo);
    expect(schedules[0]).toMatchObject({ id: "s1", runs: 2, fail24h: 1, targetAgent: "a1" });
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/agents.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement using the real API surface**

Use `paseo.agents.list({})` and `paseo.scheduleList({})` — verify the exact method names against `@getpaseo/client` typings before writing (the client exposes `agents.*` and `scheduleDelete`; if `scheduleList` differs, use the daemon-client name and record the deviation in the task report). Both functions catch their own errors and return `index.ok = false` with the message, because a failed index must refuse reclamation (Task 10) rather than delete a subset.

Port the derived fields from `SCHED_JQ` (~line 245): `room` detection (`name` starts with `supervisor:` or prompt starts with `[supervisor-heartbeat]`), `fires1h`/`fires24h`, `fail24h`, `activeRunFail24h`, and the `strict` flag (all keys the deletion rule needs are present and typed).

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/agents.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/agents.ts agent-room/server/gc/agents.test.ts
git commit -m "feat(agent-room): gc agent and schedule snapshots via the paseo api"
```

---

### Task 5: Lineage ledger

**Files:**
- Create: `agent-room/server/gc/ledger.ts`
- Create: `agent-room/server/gc/ledger.test.ts`

**Interfaces:**
- Consumes: `ledger.tsv` path, `ProcTable`, `now`.
- Produces:
  - `interface LedgerRow { pid: number; lstart: string; comm: string; owner: string; first: number; orphaned: number; exe: string }`
  - `validateLedger(rows: LedgerRow[], now: number): { rows: LedgerRow[]; dropped: number }`
  - `readLedger(path): Promise<{ rows: LedgerRow[]; note: string | null }>` — refuses symlinks, wrong owner/mode, oversized files
  - `nextLedger(...): { rows: LedgerRow[] }` — the reference's `$curr + $keep + $envrows`, deduped by `[pid, lstart]`, newest first, capped at 5000

- [ ] **Step 1: Write the failing validation tests**

```ts
// agent-room/server/gc/ledger.test.ts
import { describe, expect, it } from "vitest";
import { validateLedger } from "./ledger";

const LSTART = "Mon Oct 27 10:00:00 2026";
const UUID = "9f1c2f0a-1111-4bbb-8ccc-1234567890ab";
const base = { pid: 42, lstart: LSTART, comm: "node", owner: UUID, first: 1_700_000_000, orphaned: 0, exe: "/usr/bin/node" };

describe("validateLedger", () => {
  it("keeps a valid row", () => {
    expect(validateLedger([base], 1_800_000_000)).toMatchObject({ dropped: 0, rows: [base] });
  });

  it.each([
    ["bad lstart", { lstart: "yesterday" }],
    ["bad comm", { comm: "node --flag" }],
    ["bad owner", { owner: "not-a-uuid" }],
    ["first in the future", { first: 1_900_000_000 }],
    ["orphaned before first", { first: 1_700_000_000, orphaned: 1_600_000_000 }],
    ["relative exe", { exe: "node" }],
  ])("drops %s", (_label, patch) => {
    const result = validateLedger([{ ...base, ...patch }], 1_800_000_000);
    expect(result.rows).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });

  it("accepts a pid owner", () => {
    const row = { ...base, owner: `pid:42@${LSTART}` };
    expect(validateLedger([row], 1_800_000_000).rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/ledger.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Port the validation predicates verbatim from the `$ledgerRaw | map(select(...))` block (~line 386), and the write logic from `load_ledger`/`write_lineage` (~lines 703–746): regular file only, owner uid + mode `0600`, size ≤ 4 MB, temp file + rename, one predecessor not kept.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/ledger.test.ts`
Expected: 8/8 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/ledger.ts agent-room/server/gc/ledger.test.ts
git commit -m "feat(agent-room): gc lineage ledger with reference validation"
```

---

### Task 6: Identity, protection, and per-process decisions

**Files:**
- Create: `agent-room/server/gc/identity.ts`
- Create: `agent-room/server/gc/evaluate.ts`
- Create: `agent-room/server/gc/identity.test.ts`
- Create: `agent-room/server/gc/evaluate.test.ts`

**Interfaces:**
- Consumes: `ProcRow[]`, `top` map, env map, `AgentRec[]`, `pidFile`.
- Produces:
  - `resolveIdentity(input): Identity` with `{ ok, why, pidFile, supervisor, daemon, listener, homeBound, supervisorPid, daemonPid, appPid }`
  - `buildProcTable(input): ProcTable` adding `class`, `owner`, `ownerState`, `protected`, `underDaemon`, `warn`, `footprint_mb`
  - `staleDecision(entry, ctx): Decision` and `overmemDecision(entry, ctx): Decision` where `Decision = { eligible: boolean; why: string }`

- [ ] **Step 1: Write the failing protection and staleness tests**

```ts
// agent-room/server/gc/evaluate.test.ts
import { describe, expect, it } from "vitest";
import { overmemDecision, staleDecision } from "./evaluate";

const idOk = { ok: true, why: "ok", daemonPid: 200, appPid: 100, supervisorPid: 150 };
const baseEntry = {
  pid: 300, ppid: 1, class: "claude-child" as const, owner: "owner-1", ownerState: "archived" as const,
  envRead: true, home: "match" as const, etime_s: 3600, footprint_mb: 100, exe: "node",
  protected: null, underDaemon: false, cmd: "claude --output-format stream-json",
};
const ctx = { identity: idOk, killMb: 4096, killComms: ["node"], warnMb: 3072, famPids: [300], invoker: null, invTree: [] };

describe("staleDecision", () => {
  it("signals an aged ppid-1 agent child whose owner is archived", () => {
    expect(staleDecision(baseEntry, ctx).eligible).toBe(true);
  });
  it("refuses when the env is unreadable", () => {
    expect(staleDecision({ ...baseEntry, home: "unreadable" }, ctx)).toMatchObject({ eligible: false });
  });
  it("refuses when identification failed", () => {
    expect(staleDecision(baseEntry, { ...ctx, identity: { ...idOk, ok: false, why: "x" } }).eligible).toBe(false);
  });
  it("refuses daemon-owned processes", () => {
    expect(staleDecision({ ...baseEntry, underDaemon: true }, ctx).why).toContain("daemon-owned");
  });
  it("refuses a live parent in the Paseo family", () => {
    expect(staleDecision({ ...baseEntry, ppid: 250 }, { ...ctx, famPids: [250] }).eligible).toBe(false);
  });
  it("refuses an owner that is neither archived nor missing", () => {
    expect(staleDecision({ ...baseEntry, ownerState: "live" }, ctx).eligible).toBe(false);
  });
  it("refuses below the minimum age", () => {
    expect(staleDecision({ ...baseEntry, etime_s: 60 }, ctx).why).toContain("< 600s");
  });
});

describe("overmemDecision", () => {
  const big = { ...baseEntry, class: "agent-descendant" as const, ppid: 200, footprint_mb: 9000, exe: "node", underDaemon: true };
  it("refuses the daemon, supervisor and app main", () => {
    for (const cls of ["daemon", "supervisor", "app-main"] as const) {
      expect(overmemDecision({ ...big, class: cls }, ctx).eligible).toBe(false);
    }
  });
  it("refuses an agent child even at 9 GB", () => {
    expect(overmemDecision({ ...big, class: "claude-child" }, ctx).why).toContain("never memory-killed");
  });
  it("refuses a comm outside the allowlist", () => {
    expect(overmemDecision({ ...big, exe: "somebinary" }, ctx).eligible).toBe(false);
  });
  it("refuses an executable inside an .app or /System", () => {
    expect(overmemDecision({ ...big, cmd: "/Applications/X.app/Contents/MacOS/X" }, ctx).eligible).toBe(false);
    expect(overmemDecision({ ...big, cmd: "/System/Library/x" }, ctx).eligible).toBe(false);
  });
  it("allows an allowlisted descendant of the daemon above the threshold", () => {
    expect(overmemDecision(big, ctx).eligible).toBe(true);
  });
  it("refuses at or below the threshold", () => {
    expect(overmemDecision({ ...big, footprint_mb: 4096 }, ctx).eligible).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/evaluate.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement, preserving the reference's order of refusals**

Identity ports the `$idt` block (~lines 320–345). The refusal order matters for the `why` text and for fail-closed behaviour; keep it exactly:

`not a stalable class` → `protected` → `identification failed` → `home != match` → `daemon-owned` → `parent in Paseo family` → `no owner and ppid != 1` → `owner live` → `age below minimum` → eligible.

Over-memory order: `footprint <= killMb` → `app-main/supervisor` → `daemon` → `agent child` → `class not allowed` → `protected` → `identification failed` → `helper not a direct child of the identified app` → `agent-descendant not under the daemon` → `.app` path → `/System|/Library` path → comm allowlist → eligible.

Protection values port verbatim: `in slp-gc's own process tree` becomes `in the GC's own process tree`; `belongs to the invoking agent`; `in the invoking agent's process subtree`.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/evaluate.test.ts`
Expected: 13/13 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/identity.ts agent-room/server/gc/evaluate.ts agent-room/server/gc/*.test.ts
git commit -m "feat(agent-room): gc identity, protection and per-process decisions"
```

---

### Task 7: Orphan proofs

**Files:**
- Modify: `agent-room/server/gc/evaluate.ts`
- Create: `agent-room/server/gc/orphans.test.ts`

**Interfaces:**
- Consumes: `ProcRow[]`, env map, `LedgerRow[]`, `AgentRec[]`, `ProcTable`, identity.
- Produces: `orphanDecision(input): { entry: OrphanEntry; proof: "ledger" | "env"; stale: Decision; overmem: Decision }`

- [ ] **Step 1: Write the failing tests**

```ts
// agent-room/server/gc/orphans.test.ts
import { describe, expect, it } from "vitest";
import { orphanDecision } from "./evaluate";

const LSTART = "Mon Oct 27 10:00:00 2026";
const NOW = 1_800_000_000;
const row = { pid: 500, ppid: 1, pgid: 500, etime_s: 7200, rss_mb: 40, lstart: LSTART, cmd: "node /repo/build.mjs" };
const ledger = { pid: 500, lstart: LSTART, comm: "node", owner: "9f1c2f0a-1111-4bbb-8ccc-1234567890ab",
  first: NOW - 9000, orphaned: NOW - 8000, exe: "/usr/local/bin/node" };
const ctx = {
  now: NOW, identity: { ok: true, why: "ok", daemonPid: 200, appPid: 100, supervisorPid: 150 },
  killMb: 4096, killComms: ["node"], warnMb: 3072, orphanMinAgeMin: 10,
  agents: [], top: new Map(), invoker: null, invTree: [], selfTree: [],
};

describe("orphanDecision", () => {
  it("proves an orphan from a ledger row and eligible age", () => {
    const d = orphanDecision({ row, env: { agent: null, home: "none", read: false }, ledger, ctx });
    expect(d.proof).toBe("ledger");
    expect(d.stale.eligible).toBe(true);
  });
  it("refuses when the ledger has no real executable path", () => {
    const d = orphanDecision({ row, env: { agent: null, home: "none", read: false }, ledger: { ...ledger, exe: "" }, ctx });
    expect(d.stale.eligible).toBe(false);
  });
  it("refuses when the current env contradicts the ledger owner", () => {
    const env = { agent: "other-owner", home: "match", read: true };
    expect(orphanDecision({ row, env, ledger, ctx }).stale.eligible).toBe(false);
  });
  it("refuses a live owner", () => {
    const agents = [{ id: ledger.owner, archivedAt: null }];
    expect(orphanDecision({ row, env: { agent: null, home: "none", read: false }, ledger, ctx: { ...ctx, agents } }).stale.eligible).toBe(false);
  });
  it("refuses when orphaned-at is not recorded yet", () => {
    const d = orphanDecision({ row, env: { agent: null, home: "none", read: false }, ledger: { ...ledger, orphaned: 0 }, ctx });
    expect(d.stale.why).toContain("not recorded yet");
  });
  it("refuses when an agent-class process has an unreadable env (fail closed)", () => {
    const blind = [{ ...row, pid: 501, cmd: "claude --output-format stream-json --input-format stream-json --permission-prompt-tool x" }];
    const d = orphanDecision({ row, env: { agent: null, home: "none", read: false }, ledger, ctx: { ...ctx, blindAgentPresent: true } });
    expect(d.stale.eligible).toBe(false);
  });
  it("refuses an executable inside an .app bundle", () => {
    const d = orphanDecision({ row, env: { agent: null, home: "none", read: false },
      ledger: { ...ledger, comm: "X", exe: "/Applications/X.app/Contents/MacOS/X" }, ctx });
    expect(d.stale.eligible).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/orphans.test.ts`
Expected: FAIL, `orphanDecision is not exported`.

- [ ] **Step 3: Implement the proof chain**

Port from the `$orph` block (~lines 400–470). The order is the proof: protection → env/ledger owner contradiction → missing real executable → comm allowlist → dead-owner proof (`ldead`) → `orphanedAt == 0` → minimum age → proven. `ldead` fails closed when any agent-class process has an unreadable env.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/orphans.test.ts`
Expected: 7/7 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/evaluate.ts agent-room/server/gc/orphans.test.ts
git commit -m "feat(agent-room): gc orphan proofs with fail-closed owner checks"
```

---

### Task 8: Garbage decisions for agents and schedules

**Files:**
- Modify: `agent-room/server/gc/evaluate.ts`
- Create: `agent-room/server/gc/garbage.test.ts`

**Interfaces:**
- Consumes: `AgentRec[]`, `ScheduleRec[]`, index state, refs (`busyrefs`, `rawrefs`), `now`.
- Produces: `garbageDecisions(input): GarbageCandidate[]` where each candidate is `{ kind: "agent" | "schedule"; id: string; path: string; sig: string; rule: string; refusedBy: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
// agent-room/server/gc/garbage.test.ts
import { describe, expect, it } from "vitest";
import { garbageDecisions } from "./evaluate";

const NOW = 1_800_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const ctx = { now: NOW, minDays: 14, invoker: null, busyRefs: new Set<string>(), rawRefs: new Set<string>(), indexOk: true };

const archivedAgent = {
  id: "a-old", provider: "claude", archivedAt: iso(NOW - 20 * 86400), archivedEpoch: NOW - 20 * 86400,
  status: "idle", cwd: "/tmp/x", internal: false, labels: {}, parent: null, sessionId: null, strict: true,
};

describe("garbageDecisions", () => {
  it("candidates an agent archived beyond the minimum, with the rule named", () => {
    const [c] = garbageDecisions({ ...ctx, agents: [archivedAgent], schedules: [] });
    expect(c).toMatchObject({ kind: "agent", id: "a-old" });
    expect(c.refusedBy).toBeNull();
  });
  it("refuses an agent archived inside the window", () => {
    const fresh = { ...archivedAgent, archivedEpoch: NOW - 86400 };
    expect(garbageDecisions({ ...ctx, agents: [fresh], schedules: [] })[0].refusedBy).toContain("14");
  });
  it("refuses every candidate when the index is incomplete", () => {
    const result = garbageDecisions({ ...ctx, indexOk: false, agents: [archivedAgent], schedules: [] });
    expect(result.every((c) => c.refusedBy !== null)).toBe(true);
  });
  it("refuses a live agent", () => {
    const live = { ...archivedAgent, archivedAt: null, archivedEpoch: null };
    expect(garbageDecisions({ ...ctx, agents: [live], schedules: [] })[0].refusedBy).not.toBeNull();
  });
  it("candidates a completed schedule", () => {
    const schedule = { id: "s1", name: "x", status: "completed", targetType: "agent", targetAgent: "a", lastRunAt: iso(NOW - 7200), nextRunAt: null, runs: 2, runsRunning: 0, fail24h: 0 };
    const [c] = garbageDecisions({ ...ctx, agents: [], schedules: [schedule] });
    expect(c).toMatchObject({ kind: "schedule", id: "s1" });
  });
  it("refuses a schedule another agent holds busy", () => {
    const schedule = { id: "s1", name: "x", status: "completed", targetType: "agent", targetAgent: "a", lastRunAt: iso(NOW - 7200), nextRunAt: null, runs: 2, runsRunning: 0, fail24h: 0 };
    const busy = { ...ctx, busyRefs: new Set(["s1"]) };
    expect(garbageDecisions({ ...busy, agents: [], schedules: [schedule] })[0].refusedBy).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/garbage.test.ts`
Expected: FAIL, `garbageDecisions is not exported`.

- [ ] **Step 3: Implement the garbage rules**

Port from `EVAL_JQ`'s `$garbage` section and its `refusedBy` reasons. Required properties, each asserted above: index incompleteness refuses everything; archived age is measured in seconds against `minDays * 86400`; internal agents, room-owned schedules and busy refs are refused; every reason string names the rule that failed so the screen can show it.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/garbage.test.ts`
Expected: 6/6 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/evaluate.ts agent-room/server/gc/garbage.test.ts
git commit -m "feat(agent-room): gc garbage decisions with index refusal"
```

---

### Task 9: Report assembly, retention, transcripts, daemon metrics, text report

**Files:**
- Create: `agent-room/server/gc/report.ts`
- Create: `agent-room/server/gc/render.ts`
- Create: `agent-room/server/gc/report.test.ts`
- Create: `agent-room/server/gc/render.test.ts`

**Interfaces:**
- Consumes: every piece above.
- Produces: `buildReport(input): GcReport` matching the fixture key order and types; `renderReport(report): string`.

- [ ] **Step 1: Write the failing shape tests**

```ts
// agent-room/server/gc/report.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport } from "./report";

const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__/report-live.json"), "utf8"));

describe("buildReport", () => {
  it("emits exactly the reference top-level keys", () => {
    const report = buildReport({
      now: 1_800_000_000, generated: "2027-01-15T08:00:00Z", home: fixture.home,
      procs: { procs: [], orphans: [], ident: { ok: true, why: "ok" } },
      agents: [], schedules: [], index: { ok: true, why: [] },
      garbage: [], transcripts: [], retention: [], daemonMetrics: [],
      warnMb: 3072, killMb: 4096,
    });
    expect(Object.keys(report).sort()).toEqual(Object.keys(fixture).sort());
  });

  it("keeps procs section keys the fixture uses", () => {
    const report = buildReport({
      now: 1_800_000_000, generated: "2027-01-15T08:00:00Z", home: fixture.home,
      procs: {
        procs: [], orphans: [], ident: { ok: true, why: "ok" },
        totals: [], overall: { n: 0, footprint_mb: 0, rss_mb: 0 },
      },
      agents: [], schedules: [], index: { ok: true, why: [] },
      garbage: [], transcripts: [], retention: [], daemonMetrics: [],
      warnMb: 3072, killMb: 4096,
    });
    for (const key of ["ident", "procs", "orphans", "tree", "totals", "overall", "warnMb", "killMb"]) {
      expect(report.procs).toHaveProperty(key);
    }
  });
});
```

```ts
// agent-room/server/gc/render.test.ts
import { describe, expect, it } from "vitest";
import { renderReport } from "./render";

describe("renderReport", () => {
  it("starts with the reference header lines", () => {
    const text = renderReport({
      version: 1, generated: "2027-01-15T08:00:00Z", home: "/Users/x/.paseo",
      procs: { ident: { ok: true, why: "ok", supervisorPid: 1, daemonPid: 2, listen: "127.0.0.1:6767" },
        procs: [], orphans: [], totals: [], overall: { n: 0, footprint_mb: 0, rss_mb: 0 },
        tree: { totalMb: 0, appMb: 0, orphanMb: 0, orphanN: 0, warnMb: 1, ramMb: 1, over: false, daemon: null, agents: [], tests: { agents: 0, warnAt: 3, over: false, rows: [] } },
        warnMb: 3072, killMb: 4096 } as never,
      agents: [], schedules: [], index: { ok: true, why: [] }, garbage: [],
      transcripts: [], retention: [], daemonMetrics: [],
    });
    expect(text.split("\n")[0]).toContain("slp-gc report  2027-01-15T08:00:00Z");
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("identification: ok");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/report.test.ts server/gc/render.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

Port `ASSEMBLE_JQ` (~line 483) for `buildReport`, `RENDER_JQ` (~line 994) for `renderReport`, and the collectors it depends on: `collect_transcripts` (~795), `collect_metrics` (~811), `collect_retention` (~835), `git_state` (~828). Retention and transcript scans use `execCommand` with the same timeouts (`run_to` values) and must degrade to empty arrays on failure rather than throwing.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/report.test.ts server/gc/render.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/report.ts agent-room/server/gc/render.ts agent-room/server/gc/*.test.ts
git commit -m "feat(agent-room): gc report assembly and text rendering"
```

---

### Task 10: Record, rotation and alerts

**Files:**
- Create: `agent-room/server/gc/record.ts`
- Create: `agent-room/server/gc/record.test.ts`

**Interfaces:**
- Consumes: report, state dir, clock.
- Produces: `recordSample(input): Promise<{ line: unknown; alert: string | null }>`; `rotate(file, maxBytes, incomingBytes)`.

- [ ] **Step 1: Write the failing tests**

```ts
// agent-room/server/gc/record.test.ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordSample, rotate } from "./record";

const report = {
  generated: "2027-01-15T08:00:00Z",
  procs: { procs: [{ pid: 1, class: "daemon", footprint_mb: 500, rss_mb: 400 }], orphans: [],
    tree: { totalMb: 500, over: false, warnMb: 8192 }, totals: [], overall: { n: 1, footprint_mb: 500, rss_mb: 400 } },
} as never;

describe("recordSample", () => {
  it("appends one JSONL line and stays quiet under thresholds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-record-"));
    const result = await recordSample({ stateDir: dir, report, now: 1_800_000_000, alertStampMinutes: 60 });
    expect(result.alert).toBeNull();
    const lines = readFileSync(join(dir, "memory.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toHaveProperty("procs");
  });
});

describe("rotate", () => {
  it("keeps one predecessor when the file would exceed the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-rot-"));
    const file = join(dir, "memory.jsonl");
    writeFileSync(file, "x".repeat(100));
    rotate(file, 120, 30);
    expect(readFileSync(`${file}.1`, "utf8").length).toBe(100);
    expect(existsSync(file)).toBe(false);
  });
  it("leaves the file alone when it fits", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-rot-"));
    const file = join(dir, "memory.jsonl");
    writeFileSync(file, "x".repeat(10));
    rotate(file, 120, 30);
    expect(readFileSync(file, "utf8").length).toBe(10);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/record.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Port `do_record` (~line 1185) and `rotate` (~line 1181): 5 MB cap keeping one predecessor, `.alert-stamp` rate limit, `alerts.log` append, and the notification path — reuse `osascript` as the reference does, behind a setting-free internal function `notify(title, body)` that swallows failures.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/record.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/record.ts agent-room/server/gc/record.test.ts
git commit -m "feat(agent-room): gc memory recording, rotation and alerts"
```

---

### Task 11: Apply and kill, with budget and max kills

**Files:**
- Create: `agent-room/server/gc/apply.ts`
- Create: `agent-room/server/gc/kill.ts`
- Create: `agent-room/server/gc/apply.test.ts`
- Create: `agent-room/server/gc/kill.test.ts`

**Interfaces:**
- Consumes: report candidates, settings, `paseo`, clock.
- Produces:
  - `reclaim(input, deps): Promise<ActionResult[]>` — refuses everything when `index.ok === false`
  - `signalCandidates(input, deps): Promise<ActionResult[]>` — budget, `maxKills`, protected classes, fresh re-evaluation per candidate

- [ ] **Step 1: Write the failing tests**

```ts
// agent-room/server/gc/kill.test.ts
import { describe, expect, it, vi } from "vitest";
import { signalCandidates } from "./kill";

const candidate = {
  pid: 900, class: "agent-descendant", footprint_mb: 9000, protected: null,
  overmem: { eligible: true, why: "ok" }, stale: { eligible: false, why: "no" },
};

describe("signalCandidates", () => {
  it("never signals a protected candidate", async () => {
    const signal = vi.fn();
    const result = await signalCandidates(
      { candidates: [{ ...candidate, protected: "in the GC's own process tree" }], maxKills: 10, budgetS: 45 },
      { signal, reevaluate: () => candidate, now: () => 0, log: vi.fn() },
    );
    expect(signal).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ acted: false });
  });

  it("stops at maxKills", async () => {
    const signal = vi.fn();
    await signalCandidates(
      { candidates: Array.from({ length: 5 }, (_, i) => ({ ...candidate, pid: 900 + i })), maxKills: 2, budgetS: 45 },
      { signal, reevaluate: (c) => c, now: () => 0, log: vi.fn() },
    );
    expect(signal).toHaveBeenCalledTimes(2);
  });

  it("re-evaluates each candidate and skips one that no longer qualifies", async () => {
    const signal = vi.fn();
    await signalCandidates(
      { candidates: [candidate], maxKills: 10, budgetS: 45 },
      { signal, reevaluate: () => ({ ...candidate, overmem: { eligible: false, why: "gone" } }), now: () => 0, log: vi.fn() },
    );
    expect(signal).not.toHaveBeenCalled();
  });

  it("stops when the budget is spent", async () => {
    const signal = vi.fn();
    let clock = 0;
    await signalCandidates(
      { candidates: [candidate, { ...candidate, pid: 901 }], maxKills: 10, budgetS: 1 },
      { signal, reevaluate: (c) => c, now: () => (clock += 2), log: vi.fn() },
    );
    expect(signal).toHaveBeenCalledTimes(1);
  });
});
```

```ts
// agent-room/server/gc/apply.test.ts
import { describe, expect, it, vi } from "vitest";
import { reclaim } from "./apply";

describe("reclaim", () => {
  it("refuses everything when the index failed", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [{ kind: "agent", id: "a1", refusedBy: null }], indexOk: false },
      { deleteAgent, deleteSchedule: vi.fn(), verify: () => true, log: vi.fn() },
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].refusedBy).toContain("index");
  });

  it("deletes a candidate whose signature still matches", async () => {
    const deleteAgent = vi.fn(async () => {});
    const result = await reclaim(
      { candidates: [{ kind: "agent", id: "a1", refusedBy: null, sig: "1:2:3" }], indexOk: true },
      { deleteAgent, deleteSchedule: vi.fn(), verify: () => true, log: vi.fn() },
    );
    expect(deleteAgent).toHaveBeenCalledWith("a1");
    expect(result[0].acted).toBe(true);
  });

  it("skips a candidate whose signature changed", async () => {
    const deleteAgent = vi.fn();
    const result = await reclaim(
      { candidates: [{ kind: "agent", id: "a1", refusedBy: null, sig: "1:2:3" }], indexOk: true },
      { deleteAgent, deleteSchedule: vi.fn(), verify: () => false, log: vi.fn() },
    );
    expect(deleteAgent).not.toHaveBeenCalled();
    expect(result[0].reason).toContain("changed");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/kill.test.ts server/gc/apply.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

Port `do_apply` (~line 1046) onto the API: `paseo.agents.deleteAgent(id)` and `paseo.scheduleDelete({ id })`, with the per-candidate signature check and the "refuse on failed index" gate. Port the kill path (`kill` at ~line 1110) to `process.kill(pid, "SIGTERM")` through an injected `signal` so tests never touch the process table. Both return `ActionResult { kind, id, acted, reason }` for the screen.

Rules to preserve: budget checked before each action, `maxKills` counted per tick, a candidate re-evaluated immediately before acting, and no action at all when its rule's toggle is off.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/kill.test.ts server/gc/apply.test.ts`
Expected: 7/7 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc/apply.ts agent-room/server/gc/kill.ts agent-room/server/gc/*.test.ts
git commit -m "feat(agent-room): gc reclamation and kills behind gates"
```

---

### Task 12: Tick, scheduler, RPC contracts and server wiring

**Files:**
- Create: `agent-room/server/gc/tick.ts`
- Create: `agent-room/server/gc/scheduler.ts`
- Create: `agent-room/server/gc/tick.test.ts`
- Create: `agent-room/server/gc/scheduler.test.ts`
- Modify: `agent-room/shared/rpc.ts`
- Modify: `agent-room/index.server.ts`

**Interfaces:**
- Consumes: every module above, `readSettings`, `paseo`, state dir.
- Produces:
  - `runTick(deps): Promise<TickResult>` — record, report when due, apply/kill per toggles
  - `migrateState({ from, to }): Promise<{ copied: string[]; skipped: string[] }>` — copy-only, idempotent
  - `startScheduler({ intervalMs, runTick }): () => void` — mutex + cleanup
  - RPCs: `gcStatusRpc` (input `{}`, output `GcStatus`), `gcRunRpc` (input `{ mode: "report" | "act" }`, output `ActionResult[]`)

```ts
// agent-room/shared/gc.ts (excerpt) — the screen's one read model
export const gcStatusSchema = z.object({
  ident: z.object({ ok: z.boolean(), why: z.string() }),
  lastTickAt: z.string().nullable(),
  nextReportAt: z.string().nullable(),
  settings: z.object({
    apply: z.boolean(), killStale: z.boolean(), killMemory: z.boolean(),
    memWarnMb: z.number(), memKillMb: z.number(),
  }),
  procs: z.array(z.object({
    pid: z.number(), class: z.string().nullable(), owner: z.string().nullable(),
    footprintMb: z.number(), warn: z.boolean(),
  })),
  candidates: z.array(z.object({
    kind: z.enum(["agent", "schedule"]), id: z.string(),
    rule: z.string().nullable(), refusedBy: z.string().nullable(),
  })),
});
export type GcStatus = z.infer<typeof gcStatusSchema>;
```

- [ ] **Step 1: Write the failing scheduler tests**

```ts
// agent-room/server/gc/scheduler.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { startScheduler } from "./scheduler";

afterEach(() => vi.useRealTimers());

describe("startScheduler", () => {
  it("drops a tick that arrives while one is running", async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxConcurrent = 0;
    const run = vi.fn(async () => {
      running += 1; maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 5000));
      running -= 1;
    });
    const stop = startScheduler({ intervalMs: 1000, runTick: run });
    await vi.advanceTimersByTimeAsync(3500);
    stop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  });

  it("clears its timer when stopped", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const stop = startScheduler({ intervalMs: 1000, runTick: run });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run server/gc/scheduler.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the scheduler, tick and RPCs**

```ts
// agent-room/server/gc/scheduler.ts
export function startScheduler(input: { intervalMs: number; runTick: () => Promise<unknown> }): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void input.runTick().catch(() => {}).finally(() => { running = false; });
  }, input.intervalMs);
  return () => clearInterval(timer);
}
```

`migrateState` copies, never moves: `memory.jsonl`, `memory.jsonl.1`, `lineage.tsv`, `alerts.log`, `.alert-stamp`, `.last-report` and the `reports/` directory from `~/Library/Logs/slp-gc/` into the state dir, preserving modes, skipping any destination that already exists, and doing nothing when the source is absent. It runs once per plugin load before the first tick, and the source directory is never written.

```ts
// agent-room/server/gc/migrate.ts (excerpt)
export async function migrateState(input: { from: string; to: string }): Promise<{ copied: string[]; skipped: string[] }> {
  const entries = ["memory.jsonl", "memory.jsonl.1", "lineage.tsv", "alerts.log", ".alert-stamp", ".last-report"];
  const copied: string[] = [];
  const skipped: string[] = [];
  await mkdir(input.to, { recursive: true, mode: 0o700 });
  for (const name of entries) {
    const source = join(input.from, name);
    const target = join(input.to, name);
    if (!existsSync(source)) continue;
    if (existsSync(target)) { skipped.push(name); continue; }
    await copyFile(source, target);
    copied.push(name);
  }
  if (existsSync(join(input.from, "reports"))) {
    await cp(join(input.from, "reports"), join(input.to, "reports"), { recursive: true, force: false, errorOnExist: false });
    copied.push("reports/");
  }
  return { copied, skipped };
}
```

`runTick` composes the phases in the reference's order and never throws:

```ts
// agent-room/server/gc/tick.ts (excerpt)
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const settings = await deps.readSettings();
  if (!deps.migrated) deps.migrated = await deps.migrate();
  const agents = await deps.snapshotAgents();
  const schedules = await deps.snapshotSchedules();
  const procs = await deps.collectProcs({ wideEnv: true });
  const report = deps.buildReport({ agents, schedules, procs, now: deps.now() });
  const recorded = await deps.record(report);
  if (deps.reportDue()) await deps.writeReport(report);
  const acted: ActionResult[] = [];
  if (settings.apply) acted.push(...await deps.reclaim(report.garbage));
  if (settings.killStale) acted.push(...await deps.signalStale(report));
  if (settings.killMemory) acted.push(...await deps.signalOverMemory(report));
  return { at: deps.now(), recorded: recorded.line !== null, report, acted };
}
```

Each `deps.*` call is individually wrapped by the caller so a failing retention scan or a hung `top` degrades that phase only.

Wire in `index.server.ts`: construct the GC state dir from `resolveDataDir`, create the settings reader, `const stopGc = startScheduler({ intervalMs: 60_000, runTick })`, register `server.handle(gcStatusRpc, ...)` and `server.handle(gcRunRpc, ...)`, and call `stopGc()` in the contribution's cleanup before the room store flush. Settings import must not block room hooks: the scheduler starts even when settings are `invalid`, using defaults, and logs once.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run server/gc/scheduler.test.ts server/gc/tick.test.ts`
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add agent-room/server/gc agent-room/shared/rpc.ts agent-room/index.server.ts
git commit -m "feat(agent-room): gc tick, scheduler and rpc wiring"
```

---

### Task 13: GC screen

**Files:**
- Create: `agent-room/client/gc-screen.tsx`
- Create: `agent-room/client/gc-view-model.ts`
- Create: `agent-room/client/gc-view-model.test.ts`
- Modify: `agent-room/index.client.tsx`

**Interfaces:**
- Consumes: `gcStatusRpc`, `gcRunRpc`.
- Produces: `GcScreen`, `toGcRows(status): { status: StatusRow[]; procs: ProcRowView[]; candidates: CandidateRow[] }`.

- [ ] **Step 1: Write the failing view-model test**

```ts
// agent-room/client/gc-view-model.test.ts
import { describe, expect, it } from "vitest";
import { toGcRows } from "./gc-view-model";

describe("toGcRows", () => {
  it("marks a non-eligible candidate with its refusal", () => {
    const rows = toGcRows({
      ident: { ok: true, why: "ok" }, lastTickAt: "2027-01-15T08:00:00Z", nextReportAt: null,
      settings: { apply: false, killStale: false, killMemory: false, memWarnMb: 3072, memKillMb: 4096 },
      procs: [], candidates: [{ kind: "agent", id: "a1", refusedBy: "archived 3d < 14d" }],
    } as never);
    expect(rows.candidates[0]).toMatchObject({ label: "agent a1", refusal: "archived 3d < 14d", actionable: false });
  });

  it("reports identification failure in the status rows", () => {
    const rows = toGcRows({
      ident: { ok: false, why: "paseo.pid missing" }, lastTickAt: null, nextReportAt: null,
      settings: { apply: false, killStale: false, killMemory: false, memWarnMb: 3072, memKillMb: 4096 },
      procs: [], candidates: [],
    } as never);
    expect(rows.status.find((row) => row.label === "identification")?.value).toContain("paseo.pid missing");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd agent-room && npx vitest run client/gc-view-model.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement the screen**

`gc-screen.tsx`: status block, process list, candidate list with refusal text, three rule toggles each opening a confirm naming what will be signalled, "Run report now", "Reclaim now" (disabled unless `settings.apply`), history from `gcStatusRpc`. Use `useQuery` with a 2 s `refetchInterval` while mounted, `theme.colors` only, `flexDirection: "column"` in compact widths. Register in `index.client.tsx`: `client.addScreen({ id: "gc", title: "Garbage collection", Component: GcScreen })`, a sidebar row with a `Trash2` icon, and a Command Center item — mirroring the Room contributions, and include all disposers in the returned cleanup.

- [ ] **Step 4: Run — expect PASS**

Run: `cd agent-room && npx vitest run client/gc-view-model.test.ts && npm run typecheck`
Expected: 2/2 passing, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add agent-room/client agent-room/index.client.tsx
git commit -m "feat(agent-room): gc screen with rule toggles and candidates"
```

---

### Task 14: Equivalence against the bash, then remove it

**Files:**
- Create: `agent-room/scripts/gc-equivalence.mts`
- Create: `agent-room/docs/acceptance-phase3-2026-10-30.md`
- Modify: `agent-room/OVERVIEW.md`

**Interfaces:**
- Consumes: `docs/gc-port/slp-gc.bash`, the plugin's `runTick` report.
- Produces: a diff report and the acceptance record.

- [ ] **Step 1: Write the equivalence harness**

```ts
// agent-room/scripts/gc-equivalence.mts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const IGNORE = new Set(["generated", "home", "etime_s", "pid", "ppid", "pgid", "lstart", "rss_mb", "mem_mb", "cmprs_mb", "footprint_mb"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !IGNORE.has(key))
      .map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

const bash = JSON.parse(execFileSync("bash", ["docs/gc-port/slp-gc.bash", "report", "--json"], { encoding: "utf8" }));
const plugin = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
const a = JSON.stringify(normalize(bash));
const b = JSON.stringify(normalize(plugin));
console.log(a === b ? "EQUIVALENT" : "DIFFERS");
if (a !== b) process.exitCode = 1;
```

- [ ] **Step 2: Run it against a plugin report — expect a diff, then fix drift**

```bash
cd agent-room && node --experimental-strip-types scripts/gc-equivalence.mts /tmp/gc-plugin-report.json
```

Expected first run: `DIFFERS` with the first mismatching field named by a hand-added `console.log` of the two normalized objects. Fix drift in the modules, never in the harness; re-run until `EQUIVALENT` on this machine with rules in report-only mode.

- [ ] **Step 3: Run the whole gate**

```bash
cd agent-room && npm test && npm run typecheck
paseo plugin ls | grep -E '^agent-room'
paseo logs agent-room 2>/dev/null | tail -20
```

Expected: all tests pass, typecheck 0, plugin `running`, log shows `gc` ticks without errors.

- [ ] **Step 4: Write the acceptance record and update the OVERVIEW**

Create `agent-room/docs/acceptance-phase3-2026-10-30.md` with: settings import evidence, scheduler evidence (tick count over an hour, no overlap), equivalence output, protected-class test names, and the rule-toggle defaults. Update `agent-room/OVERVIEW.md` with a "Garbage collection" section describing the screen, the three rules and their off-by-default posture, the state directory, and the plugin-only watchdog limit.

- [ ] **Step 5: Ask for confirmation, then remove the bash and the launchd job**

Ask in chat, one step at a time: (a) unload and remove `com.paseo-slp.slp-gc`; (b) delete `~/.config/slp-room`; (c) delete `agent-room/docs/gc-port/`. Only after each explicit yes:

```bash
launchctl bootout "gui/$(id -u)/com.paseo-slp.slp-gc" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist
rm -rf ~/.config/slp-room
rm -rf /Users/ultima/Workspace/paseo-plugins/agent-room/docs/gc-port
```

Verify: `launchctl list | grep -c com.paseo-slp.slp-gc` prints `0`; `test -e ~/.config/slp-room` fails; `paseo plugin ls` still shows `agent-room running`.

- [ ] **Step 6: Commit**

```bash
git add agent-room scripts docs
git commit -m "docs(agent-room): phase 3 gc acceptance and bash removal"
```

---

## Rollback notes

- Tasks 1–13 are additive; `git revert` of any commit is safe, and the bash tool keeps running from launchd until Task 14.
- Task 14 is destructive and has no rollback: the launchd job, `~/.config/slp-room`, and the in-repo reference copy are deleted. The archived `~/Library/Logs/slp-gc` history is never touched.
- If equivalence cannot be reached, stop at Task 13: the plugin ships with rules off and the bash stays the acting GC. Record the drift in the acceptance record instead of loosening a rule.
