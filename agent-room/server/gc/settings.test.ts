// GC settings import: the reference's `read_config` + `norm_thresholds`
// (slp-gc.bash:1240-1269, 80-97) ported to a typed, non-throwing reader.
//
// The live conf lives at ~/.config/slp-room/slp-gc.conf. These tests never touch
// it: they use inline strings, an injected `readFile`, or the byte-identical copy
// captured in `docs/gc-port/slp-gc.conf` (Task 1).
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_KILL_COMMS, gcSettings } from "../../shared/gc";
import { createGcSettingsReader, DEFAULT_GC_SETTINGS, parseConf } from "./settings";

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

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

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
    // slp-gc.bash:83-84: kill=1024 fails the `>= warn` test, so it is RESET to
    // 4096 — not clamped up to warn — and 4096 is already above warn.
    const { values } = parseConf(conf, vi.fn());
    expect(values.memKillMb).toBe(4096);
  });

  it("raises the 4096 fallback to warn when warn is the larger", () => {
    // warn=8192, kill=1024: reset to 4096, then raised to warn (slp-gc.bash:84).
    const { values } = parseConf("SLP_GC_MEM_WARN_MB=8192\nSLP_GC_MEM_KILL_MB=1024\n", vi.fn());
    expect(values.memKillMb).toBe(8192);
  });

  it("keeps a kill that clears both the floor and warn", () => {
    const { values } = parseConf("SLP_GC_MEM_WARN_MB=2048\nSLP_GC_MEM_KILL_MB=6144\n", vi.fn());
    expect(values.memKillMb).toBe(6144);
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

describe("gc settings defaults parity with the reference", () => {
  it("carries every reference default, kill comms in reference order", () => {
    expect(DEFAULT_GC_SETTINGS.treeWarnMb).toBeNull();
    expect(DEFAULT_GC_SETTINGS.testConcurrencyWarn).toBe(3);
    expect(DEFAULT_GC_SETTINGS.cliTimeoutS).toBe(30);
    // slp-gc.bash:79 DEF_KILL_COMMS, in order.
    expect(DEFAULT_GC_SETTINGS.killComms).toEqual(DEFAULT_KILL_COMMS);
    expect(DEFAULT_KILL_COMMS).toEqual([
      "node",
      "bun",
      "deno",
      "npm",
      "npx",
      "pnpm",
      "yarn",
      "esbuild",
      "tsc",
      "vitest",
      "jest",
      "python",
      "python3",
      "uv",
      "pytest",
      "ruby",
      "java",
      "gradle",
      "go",
      "cargo",
    ]);
  });

  it("does not hand callers the shared default kill-comm array", () => {
    expect(DEFAULT_GC_SETTINGS.killComms).not.toBe(DEFAULT_KILL_COMMS);
  });

  it("the schema accepts the defaults it ships with and rejects impossible knobs", () => {
    expect(gcSettings.parse(DEFAULT_GC_SETTINGS)).toEqual(DEFAULT_GC_SETTINGS);
    // `treeWarnMb: null` means "half of physical RAM", resolved by a later task.
    expect(gcSettings.safeParse({ ...DEFAULT_GC_SETTINGS, treeWarnMb: null }).success).toBe(true);
    // Below the reference's 1024 MB floor, and below 1 for a threshold.
    expect(gcSettings.safeParse({ ...DEFAULT_GC_SETTINGS, memKillMb: 512 }).success).toBe(false);
    expect(gcSettings.safeParse({ ...DEFAULT_GC_SETTINGS, memWarnMb: 0 }).success).toBe(false);
  });
});

describe("gc conf parsing details", () => {
  it("reads every knob, including the comma/quote forms and the legacy alias", () => {
    const { values, problems } = parseConf(
      [
        'SLP_GC_KILL_STALE=1',
        "SLP_GC_KILL_MEMORY=yes",
        "SLP_GC_TREE_WARN_MB=8192",
        'SLP_GC_ORPHAN_COMMS="node,cargo"',
        "SLP_GC_TEST_CONCURRENCY_WARN=0",
        "SLP_GC_CLI_TIMEOUT=12",
        "  SLP_GC_MAX_KILLS = 20 ",
      ].join("\r\n"),
      quietLog(),
    );
    expect(problems).toEqual([]);
    expect(values).toMatchObject({
      killStale: true,
      killMemory: false,
      treeWarnMb: 8192,
      killComms: ["node", "cargo"],
      testConcurrencyWarn: 0,
      cliTimeoutS: 12,
      maxKills: 20,
    });
  });

  it("rejects zero and out-of-range numbers but keeps the rest of the file", () => {
    const log = quietLog();
    const { values, problems } = parseConf(
      "SLP_GC_MEM_WARN_MB=0\nSLP_GC_MAX_KILLS=9999999999999\nSLP_GC_ORPHAN_MIN_AGE_MIN=7\n",
      log,
    );
    expect(values).toEqual({ orphanMinAgeMin: 7 });
    expect(problems.join("\n")).toContain("SLP_GC_MEM_WARN_MB");
    expect(problems.join("\n")).toContain("SLP_GC_MAX_KILLS");
    expect(log.warn).toHaveBeenCalled();
  });

  it("an empty kill-comm list falls back to the reference default list", () => {
    const { values, problems } = parseConf("SLP_GC_KILL_COMMS=\n", quietLog());
    expect(values.killComms).toBeUndefined();
    expect(problems.join("\n")).toContain("SLP_GC_KILL_COMMS");
  });

  it("resets the whole list when any kill-comm token is not a legal process name", () => {
    // slp-gc.bash:92-95: each token must be `[A-Za-z0-9._+-]`; one bad token sets
    // `bad=1` and the whole list becomes `DEF_KILL_COMMS`, not the good tokens.
    const log = quietLog();
    const { values, problems } = parseConf('SLP_GC_KILL_COMMS=node "bad token"\n', log);
    expect(values.killComms).toBeUndefined();
    expect({ ...DEFAULT_GC_SETTINGS, ...values }.killComms).toEqual(DEFAULT_KILL_COMMS);
    expect(problems.join("\n")).toContain("SLP_GC_KILL_COMMS");
    expect(log.warn).toHaveBeenCalled();
  });

  it("keeps a clean custom kill-comm list, punctuation and all", () => {
    const { values, problems } = parseConf("SLP_GC_KILL_COMMS=node my-app.node_1+v2\n", quietLog());
    expect(problems).toEqual([]);
    expect(values.killComms).toEqual(["node", "my-app.node_1+v2"]);
  });

  it("survives unparseable lines and a bare newline-only file", () => {
    expect(parseConf("\n\n", vi.fn()).problems).toEqual([]);
    const { problems } = parseConf("JUST_A_WORD\n=5\n", quietLog());
    expect(problems).toHaveLength(2);
  });

  it("raises an absent kill to the default when only warn is set", () => {
    expect(parseConf("SLP_GC_MEM_WARN_MB=2048\n", quietLog()).values).toEqual({
      memWarnMb: 2048,
      memKillMb: 4096,
    });
    expect(parseConf("SLP_GC_MEM_WARN_MB=8192\n", quietLog()).values).toEqual({
      memWarnMb: 8192,
      memKillMb: 8192,
    });
  });
});

describe("createGcSettingsReader", () => {
  const path = (name: string) => `/nonexistent/slp-gc/${name}.conf`;

  it("merges the imported values over the defaults", async () => {
    const settings = await createGcSettingsReader({
      confPath: path("merge"),
      log: quietLog(),
      readFile: async () => "SLP_GC_APPLY=1\nSLP_GC_MAX_KILLS=4\n",
    });
    expect(settings).toEqual({ ...DEFAULT_GC_SETTINGS, apply: true, maxKills: 4 });
    // Whatever the importer returns must satisfy the schema Task 12 validates
    // the plugin's settings document against.
    expect(gcSettings.safeParse(settings).success).toBe(true);
  });

  it("reads the conf once per path and memoises the promise", async () => {
    const readFile = vi.fn(async () => "SLP_GC_MAX_KILLS=7\n");
    const confPath = path("memo");
    const first = await createGcSettingsReader({ confPath, log: quietLog(), readFile });
    const second = await createGcSettingsReader({ confPath, log: quietLog(), readFile });

    // Re-reading would either bump the counter or hand back a fresh object.
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.maxKills).toBe(7);
  });

  it("a missing conf logs once and falls back to defaults without throwing", async () => {
    const log = quietLog();
    const settings = await createGcSettingsReader({
      confPath: path("absent"),
      log,
      readFile: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(settings).toEqual(DEFAULT_GC_SETTINGS);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("an unreadable or malformed conf never throws into the plugin load path", async () => {
    const malformed = await createGcSettingsReader({
      confPath: path("malformed"),
      log: quietLog(),
      readFile: async () => "total garbage\nSLP_GC_MEM_WARN_MB=nope\n",
    });
    expect(malformed).toEqual(DEFAULT_GC_SETTINGS);

    const denied = await createGcSettingsReader({
      confPath: path("denied"),
      log: quietLog(),
      readFile: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(denied).toEqual(DEFAULT_GC_SETTINGS);
  });

  it("a conf the parser itself chokes on still yields defaults", async () => {
    const log = quietLog();
    const settings = await createGcSettingsReader({
      confPath: path("hostile"),
      log,
      // A Buffer (or any non-string) is what a caller-leaned-on fs seam can hand
      // back; `parseConf` throws on it, and the reader must still resolve.
      readFile: async () => Buffer.from("SLP_GC_APPLY=1") as never,
    });
    expect(settings).toEqual(DEFAULT_GC_SETTINGS);
    expect(log.warn).toHaveBeenCalled();
  });

  it("hands back defaults a caller cannot use to mutate the shared constant", async () => {
    const settings = await createGcSettingsReader({
      confPath: path("copy"),
      log: quietLog(),
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(settings.killComms).not.toBe(DEFAULT_GC_SETTINGS.killComms);
    settings.killComms.push("evil");
    expect(DEFAULT_GC_SETTINGS.killComms).not.toContain("evil");
  });

  it("logs the imported key count and the problem count", async () => {
    const log = quietLog();
    await createGcSettingsReader({
      confPath: path("log"),
      log,
      readFile: async () => "SLP_GC_MAX_KILLS=4\nSLP_GC_NOPE=1\n",
    });
    expect(log.info).toHaveBeenCalledWith("gc conf imported", { keys: 1, problems: 1 });
  });

  it("imports the captured reference conf through the real fs reader", async () => {
    const settings = await createGcSettingsReader({
      confPath: join(__dirname, "../../docs/gc-port/slp-gc.conf"),
      log: quietLog(),
    });
    // Every tunable in the shipped conf is commented out; only the three flags
    // are live, all off.
    expect(settings).toEqual(DEFAULT_GC_SETTINGS);
    expect(settings.apply).toBe(false);
    expect(readFileSync(join(__dirname, "../../docs/gc-port/slp-gc.conf"), "utf8")).toContain(
      "SLP_GC_APPLY=0",
    );
  });
});

describe("a symlinked conf is refused", () => {
  // slp-gc.bash:1245 — `[ -f "$file" ] && [ ! -L "$file" ] || return 0`: a
  // symlinked conf silently yields the defaults and its target is never read.
  const dir = mkdtempSync(join(tmpdir(), "gc-conf-symlink-"));
  const target = join(dir, "slp-gc.conf");
  writeFileSync(
    target,
    "# settings that WOULD apply if the link were followed\nSLP_GC_APPLY=1\nSLP_GC_MAX_KILLS=4\n",
  );
  const linkNamed = (name: string) => {
    const link = join(dir, name);
    symlinkSync(target, link);
    return link;
  };
  // Distinct link paths: the reader memoises per confPath.
  const viaSeam = linkNamed("seam.conf");
  const viaFs = linkNamed("fs.conf");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the defaults and never reads the link target", async () => {
    const log = quietLog();
    const readFile = vi.fn(async () => readFileSync(target, "utf8"));
    const settings = await createGcSettingsReader({ confPath: viaSeam, log, readFile });

    expect(settings).toEqual(DEFAULT_GC_SETTINGS);
    // The target was never read: not through the seam, not through the defaults.
    expect(readFile).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("gc conf is a symlink; using defaults", {
      path: viaSeam,
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does not follow the link through the real fs reader either", async () => {
    const settings = await createGcSettingsReader({ confPath: viaFs, log: quietLog() });
    // The target would flip `apply` and `maxKills` if it were read, so equality
    // with the defaults is itself the proof that it was not.
    expect(settings).toEqual(DEFAULT_GC_SETTINGS);
    expect(readFileSync(target, "utf8")).toContain("SLP_GC_MAX_KILLS=4");
  });
});
