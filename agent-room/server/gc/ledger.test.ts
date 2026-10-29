// The lineage ledger: the reference's validation, load and write rules
// (`docs/gc-port/slp-gc.bash:379-386`, `:703-715`, `:739-745`, `:452-466`).
//
// Every case builds its own tsv text or its own `mkdtemp` state dir: nothing
// here reads or writes the live `~/Library/Logs/slp-gc/lineage.tsv`, `~/.paseo`
// or the reference tool.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LEDGER_CAP,
  LEDGER_MAX_BYTES,
  ledgerKey,
  nextLedger,
  parseLedgerTsv,
  readLedger,
  validateLedger,
  writeLedger,
  type LedgerRow,
} from "./ledger";

const LSTART = "Mon Oct 27 10:00:00 2026";
const LSTART2 = "Mon Oct 27 11:00:00 2026";
const UUID = "9f1c2f0a-1111-4bbb-8ccc-1234567890ab";
const NOW = 1_800_000_000;
const base: LedgerRow = {
  pid: 42,
  lstart: LSTART,
  comm: "node",
  owner: UUID,
  first: 1_700_000_000,
  orphaned: 0,
  exe: "/usr/bin/node",
};

// --- brief Step 1: the validation table ---------------------------------------

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

// --- the six predicates, edge by edge (slp-gc.bash:380-385) -------------------

describe("validateLedger — the predicates in detail", () => {
  it("pins the lstart shape: five tokens, 2-digit clock, 4-digit year", () => {
    const cases: Array<[string, boolean]> = [
      [LSTART, true],
      ["Mon Oct  7 10:00:00 2026", false], // ps pads the day with a space; the reference wants 1-2 digits
      ["Mon Oct 7 10:00:00 2026", true],
      ["Mon Oct 27 1:00:00 2026", false], // single-digit hour
      ["Mon Oct 27 10:00:00 26", false],
      ["Mon October 27 10:00:00 2026", false],
      [" Mon Oct 27 10:00:00 2026", false],
      ["Mon Oct 27 10:00:00 2026 ", false],
      ["mon oct 27 10:00:00 2026", true], // the reference is case-insensitive: [A-Za-z]
    ];
    for (const [lstart, kept] of cases) {
      const result = validateLedger([{ ...base, lstart }], NOW);
      expect([lstart, result.rows.length], lstart).toEqual([lstart, kept ? 1 : 0]);
    }
  });

  it("pins the comm shape: one character class, no arguments", () => {
    // slp-gc.bash:380 — `^[A-Za-z0-9._+-]+$`.
    const kept = ["node", "bun", "claude", "Python3.12", "a+-._", "A".repeat(200)];
    const dropped = ["", "node --flag", "node\t", "node/child", "node ", "nöde", "node\n"];
    for (const comm of kept) expect(validateLedger([{ ...base, comm }], NOW).dropped, comm).toBe(0);
    for (const comm of dropped) expect(validateLedger([{ ...base, comm }], NOW).dropped, comm).toBe(1);
  });

  it("pins the owner shape: lowercase uuid or pid:<n>@<lstart>", () => {
    // slp-gc.bash:381-382 — the uuid hex class is lowercase only; the pid arm
    // repeats the lstart shape verbatim.
    const kept = [UUID, "00000000-0000-0000-0000-000000000000", `pid:42@${LSTART}`, "pid:0@Mon Oct 7 01:02:03 2026"];
    const dropped = [
      "9F1C2F0A-1111-4BBB-8CCC-1234567890AB",
      "9f1c2f0a11114bbb8ccc1234567890ab",
      "9f1c2f0a-1111-4bbb-8ccc-1234567890a",
      "{9f1c2f0a-1111-4bbb-8ccc-1234567890ab}",
      "pid:42@yesterday",
      "pid:@Mon Oct 27 10:00:00 2026",
      "pid:42",
      `uuid:${UUID}`,
      "",
    ];
    for (const owner of kept) expect(validateLedger([{ ...base, owner }], NOW).dropped, owner).toBe(0);
    for (const owner of dropped) expect(validateLedger([{ ...base, owner }], NOW).dropped, owner).toBe(1);
  });

  it("pins the first-seen window: [1000000000, now + 300]", () => {
    // slp-gc.bash:383.
    const kept = [1_000_000_000, 1_700_000_000, NOW, NOW + 300];
    const dropped = [999_999_999, 0, -1, NOW + 301, Number.NaN];
    for (const first of kept) expect(validateLedger([{ ...base, first }], NOW).dropped, String(first)).toBe(0);
    for (const first of dropped) {
      expect(validateLedger([{ ...base, first, orphaned: 0 }], NOW).dropped, String(first)).toBe(1);
    }
  });

  it("pins the orphaned window: 0, or [first, now + 300]", () => {
    // slp-gc.bash:384 — `(.orphaned // 0) == 0 or (.orphaned >= .first and .orphaned <= now + 300)`.
    const kept = [0, base.first, NOW, NOW + 300];
    const dropped = [base.first - 1, NOW + 301, Number.NaN];
    for (const orphaned of kept) {
      expect(validateLedger([{ ...base, orphaned }], NOW).dropped, String(orphaned)).toBe(0);
    }
    for (const orphaned of dropped) {
      expect(validateLedger([{ ...base, orphaned }], NOW).dropped, String(orphaned)).toBe(1);
    }
    // An `orphaned` above `first` but above the horizon is still dropped: both
    // halves of the window have to hold.
    expect(validateLedger([{ ...base, first: NOW + 10, orphaned: NOW + 10 }], NOW).dropped).toBe(0);
    expect(validateLedger([{ ...base, first: NOW + 10, orphaned: NOW + 400 }], NOW).dropped).toBe(1);
  });

  it("pins the exe rule: empty, or an absolute path shorter than 1024 chars", () => {
    // slp-gc.bash:385 — `((.exe // "") == "") or ((.exe | test("^/")) and (.exe | length) < 1024)`.
    expect(validateLedger([{ ...base, exe: "" }], NOW).dropped).toBe(0);
    expect(validateLedger([{ ...base, exe: "/" }], NOW).dropped).toBe(0);
    expect(validateLedger([{ ...base, exe: "/" + "a".repeat(1022) }], NOW).dropped).toBe(0);
    expect(validateLedger([{ ...base, exe: "/" + "a".repeat(1023) }], NOW).dropped).toBe(1);
    for (const exe of ["node", "./node", "~/node", " node", "\t/usr/bin/node"]) {
      expect(validateLedger([{ ...base, exe }], NOW).dropped, exe).toBe(1);
    }
    // `test("^/")` anchors at the start only: a trailing newline still passes.
    // The reference never writes one (`exe_of` collapses newlines, :720).
    expect(validateLedger([{ ...base, exe: "/usr/bin/node\n" }], NOW).dropped).toBe(0);
  });

  it("counts every drop and keeps the surviving rows in order", () => {
    const rows: LedgerRow[] = [
      { ...base, pid: 1 },
      { ...base, pid: 2, comm: "bad comm" },
      { ...base, pid: 3 },
      { ...base, pid: 4, owner: "nope" },
    ];
    const result = validateLedger(rows, NOW);
    expect(result.dropped).toBe(2);
    expect(result.rows.map((row) => row.pid)).toEqual([1, 3]);
    expect(validateLedger([], NOW)).toEqual({ rows: [], dropped: 0 });
  });
});

// --- tsv parsing (slp-gc.bash:711-712) ---------------------------------------

describe("parseLedgerTsv", () => {
  it("reads the 5-, 6- and 7-field shapes and defaults the optional tail", () => {
    const text = [
      "42\tMon Oct 27 10:00:00 2026\tnode\t" + UUID + "\t1700000000",
      "43\tMon Oct 27 10:00:00 2026\tnode\t" + UUID + "\t1700000000\t0",
      `44\t${LSTART}\tnode\t${UUID}\t1700000000\t1700000100\t/usr/bin/node`,
    ].join("\n");
    expect(parseLedgerTsv(text)).toEqual([
      { ...base, orphaned: 0, exe: "" },
      { ...base, pid: 43, exe: "" },
      { ...base, pid: 44, first: 1_700_000_000, orphaned: 1_700_000_100 },
    ]);
  });

  it("skips what the reference's `select` rejects, without failing the rest", () => {
    // slp-gc.bash:711: 5-7 fields, numeric pid and first, numeric orphaned when present.
    const text = [
      "",
      "only-one-field",
      `42\t${LSTART}\tnode\t${UUID}`,
      `x\t${LSTART}\tnode\t${UUID}\t1700000000`,
      `42\t${LSTART}\tnode\t${UUID}\tx`,
      `42\t${LSTART}\tnode\t${UUID}\t1700000000\tx`,
      `42\t${LSTART}\tnode\t${UUID}\t1700000000\t0\t/usr/bin/node\textra`,
      // `test("^[0-9]+$")`, not `Number(...)`: an exponent, a sign and a decimal
      // point are all numbers to `Number()` and none of them is a tsv field.
      `1e3\t${LSTART}\tnode\t${UUID}\t1700000000`,
      `+42\t${LSTART}\tnode\t${UUID}\t1700000000`,
      `42\t${LSTART}\tnode\t${UUID}\t1.7e9`,
      `42\t${LSTART}\tnode\t${UUID}\t1700000000\t-1`,
      ` 42\t${LSTART}\tnode\t${UUID}\t1700000000`,
      `7\t${LSTART}\tnode\t${UUID}\t1700000000`,
    ].join("\n");
    expect(parseLedgerTsv(text).map((row) => row.pid)).toEqual([7]);
  });

  it("accepts CRLF-free input and a missing trailing newline", () => {
    expect(parseLedgerTsv(`42\t${LSTART}\tnode\t${UUID}\t1700000000`)).toHaveLength(1);
    expect(parseLedgerTsv("")).toEqual([]);
  });
});

// --- load: the refusals of slp-gc.bash:703-715 --------------------------------

const dirs: string[] = [];

function stateDir(mode = 0o700): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-ledger-"));
  chmodSync(dir, mode);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tsv(...rows: LedgerRow[]): string {
  return rows.map((row) => [row.pid, row.lstart, row.comm, row.owner, row.first, row.orphaned, row.exe].join("\t")).join("\n") + "\n";
}

function writeStateFile(dir: string, text: string, mode = 0o600, name = "lineage.tsv"): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

describe("readLedger", () => {
  it("reads a 0600 regular file in a 0700 state dir", async () => {
    const dir = stateDir();
    const file = writeStateFile(dir, tsv(base, { ...base, pid: 43, lstart: LSTART2 }));
    const result = await readLedger(file);
    expect(result.note).toBeNull();
    expect(result.rows).toEqual([base, { ...base, pid: 43, lstart: LSTART2 }]);
  });

  it("treats an absent file as an empty ledger, not a problem", async () => {
    const dir = stateDir();
    // slp-gc.bash:706 — `[ -e "$f" ] || [ -L "$f" ] || return 0` with no note.
    expect(await readLedger(join(dir, "lineage.tsv"))).toEqual({ rows: [], note: null });
  });

  it("refuses a symlink and never reads its target", async () => {
    const dir = stateDir();
    const outside = join(stateDir(), "real.tsv");
    writeFileSync(outside, tsv(base));
    chmodSync(outside, 0o600);
    const link = join(dir, "lineage.tsv");
    symlinkSync(outside, link);

    const result = await readLedger(link);
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/not a regular file/);
    expect(result.note).toMatch(/symlink/);
    // The link survives: the reader must not have replaced or followed it.
    expect(readFileSync(outside, "utf8")).toBe(tsv(base));
  });

  it("refuses a directory where the file belongs", async () => {
    const dir = stateDir();
    mkdirSync(join(dir, "lineage.tsv"));
    const result = await readLedger(join(dir, "lineage.tsv"));
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/not a regular file/);
  });

  it("refuses a file that is not owned by this uid with mode 0600", async () => {
    const dir = stateDir();
    const file = writeStateFile(dir, tsv(base), 0o644);
    const result = await readLedger(file);
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/0600/);
    expect(result.note).toMatch(/\(is \d+:\d+\)/);
  });

  it("refuses a file with another owner, even at mode 0600", async () => {
    const dir = stateDir();
    const file = writeStateFile(dir, tsv(base), 0o600);
    // The uid seam stands in for a file written by another account: there is no
    // way to chown inside a test, and the check must still be provably live.
    const otherUid = typeof process.getuid === "function" ? process.getuid() + 1 : 4242;
    const result = await readLedger(file, { ownerUid: otherUid });
    expect(result.rows).toEqual([]);
    expect(result.note).toContain(`uid ${otherUid}`);
  });

  it("refuses a file over 4 MB without reading it", async () => {
    // The literal, not the constant: a test that reads `LEDGER_MAX_BYTES` would
    // scale with the gate and never notice it changing (slp-gc.bash:710).
    expect(LEDGER_MAX_BYTES).toBe(4_194_304);
    const dir = stateDir();
    const file = writeStateFile(dir, "x".repeat(4_194_304 + 1));
    const result = await readLedger(file);
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/too large/);
    // Exactly at the cap is still acceptable (the reference's `-le 4194304`).
    const atCap = writeStateFile(stateDir(), "x".repeat(4_194_304));
    expect(await readLedger(atCap)).toEqual({ rows: [], note: null });
  });

  it("refuses a state dir that is not 0700", async () => {
    // slp-gc.bash:708 — the dir gate comes before the file gate.
    const dir = stateDir(0o755);
    const file = writeStateFile(dir, tsv(base), 0o600);
    const result = await readLedger(file);
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/0700/);
  });

  it("parses but does not validate: junk rows are left for validateLedger to count", async () => {
    const dir = stateDir();
    const file = writeStateFile(dir, tsv(base, { ...base, pid: 99, comm: "node --flag" }));
    expect((await readLedger(file)).rows).toHaveLength(2);
    const validated = validateLedger((await readLedger(file)).rows, NOW);
    expect(validated.rows).toHaveLength(1);
    expect(validated.dropped).toBe(1);
  });
});

// --- write (slp-gc.bash:739-745) ---------------------------------------------

describe("writeLedger", () => {
  it("writes a 0600 tsv that the reader round-trips", async () => {
    const dir = stateDir();
    const file = join(dir, "lineage.tsv");
    const rows = [base, { ...base, pid: 43, lstart: LSTART2, orphaned: 1_700_000_500 }];
    expect(await writeLedger(file, rows)).toEqual({ ok: true, note: null });
    expect((await readLedger(file)).rows).toEqual(rows);
    // No temp file survives the rename.
    expect(readdirSync(dir)).toEqual(["lineage.tsv"]);
  });

  it("replaces a symlink at the target instead of writing through it", async () => {
    const dir = stateDir();
    const victim = join(dir, "victim.tsv");
    writeFileSync(victim, "do not touch");
    chmodSync(victim, 0o600);
    const link = join(dir, "lineage.tsv");
    symlinkSync(victim, link);

    expect(await writeLedger(link, [base])).toEqual({ ok: true, note: null });
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect((await readLedger(link)).rows).toEqual([base]);
  });

  it("never throws: a directory at the target and a missing dir both answer ok: false", async () => {
    const dir = stateDir();
    mkdirSync(join(dir, "lineage.tsv"));
    const blocked = await writeLedger(join(dir, "lineage.tsv"), [base]);
    expect(blocked.ok).toBe(false);
    expect(blocked.note).toBeTruthy();

    const missing = await writeLedger(join(dir, "nope", "lineage.tsv"), [base]);
    expect(missing.ok).toBe(false);
    expect(missing.note).toBeTruthy();
  });

  it("collapses control characters so the tsv stays seven fields", async () => {
    const dir = stateDir();
    const file = join(dir, "lineage.tsv");
    await writeLedger(file, [{ ...base, exe: "/usr/bin/no\tde\n" }]);
    const parsed = parseLedgerTsv(readFileSync(file, "utf8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.exe).toBe("/usr/bin/no de");
  });
});

// --- next ledger (slp-gc.bash:452-466) ---------------------------------------

const procs = [
  { pid: 10, ppid: 5, lstart: LSTART },
  { pid: 20, ppid: 1, lstart: LSTART },
  { pid: 30, ppid: 1, lstart: LSTART2 },
];

describe("nextLedger", () => {
  it("merges current, kept and env-proven rows", () => {
    // slp-gc.bash:466 — `($curr + $keep + $envrows) | unique_by(...) | sort_by(-.first)`.
    const current: LedgerRow = { ...base, pid: 10, first: 1_700_000_300 };
    const kept = { ...base, pid: 20, first: 1_700_000_100 };
    const env: LedgerRow = { ...base, pid: 30, lstart: LSTART2, first: NOW, orphaned: NOW };
    const result = nextLedger({ ledger: [kept], current: [current], envRows: [env], procs, now: NOW });
    expect(result.rows.map((row) => row.pid)).toEqual([30, 10, 20]);
    // The kept row is live with ppid 1 and no recorded orphaned-at: the tick
    // stamps it with `now` (slp-gc.bash:463).
    expect(result.rows.find((row) => row.pid === 20)?.orphaned).toBe(NOW);
    // An env row is recorded as orphaned now by the caller and is not re-stamped.
    expect(result.rows.find((row) => row.pid === 30)?.orphaned).toBe(NOW);
  });

  it("drops ledger rows that are not live, or that current already covers", () => {
    // slp-gc.bash:462: `$liveSet[key] == true and $curSet[key] == null`.
    const current: LedgerRow = { ...base, pid: 10 };
    const stillLive = { ...base, pid: 20, orphaned: 1_700_000_050 };
    const dead = { ...base, pid: 77 }; // not in the process table
    const recycled: LedgerRow = { ...base, pid: 10, lstart: LSTART2 }; // same pid, start not live
    const result = nextLedger({
      ledger: [stillLive, dead, recycled],
      current: [current],
      procs,
      now: NOW,
    });
    expect(result.rows.map((row) => ledgerKey(row.pid, row.lstart))).toEqual([
      ledgerKey(10, LSTART),
      ledgerKey(20, LSTART),
    ]);
    // A recorded orphaned-at is kept as-is, never moved forward.
    expect(result.rows.find((row) => row.pid === 20)?.orphaned).toBe(1_700_000_050);
    // A kept row that is still live but not ppid 1 gets 0, not `now`.
    const notOrphan = nextLedger({ ledger: [{ ...base, pid: 10 }], procs, now: NOW });
    expect(notOrphan.rows).toHaveLength(1);
    expect(notOrphan.rows[0]?.orphaned).toBe(0);
  });

  it("dedupes by [pid, lstart] in current-over-keep-over-env order", () => {
    const fromCurrent: LedgerRow = { ...base, pid: 20, comm: "from-current" };
    const fromLedger: LedgerRow = { ...base, pid: 20, comm: "from-ledger" };
    const fromEnv: LedgerRow = { ...base, pid: 20, comm: "from-env" };
    const result = nextLedger({
      ledger: [fromLedger],
      current: [fromCurrent],
      envRows: [fromEnv],
      procs,
      now: NOW,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.comm).toBe("from-current");

    // Without a current row the kept row wins over the env row.
    const withoutCurrent = nextLedger({
      ledger: [fromLedger],
      envRows: [fromEnv],
      procs,
      now: NOW,
    });
    expect(withoutCurrent.rows.map((row) => row.comm)).toEqual(["from-ledger"]);
  });

  it("sorts newest-first and is deterministic for equal first-seen stamps", () => {
    const rows: LedgerRow[] = [20, 11, 10, 30].map((pid) => ({ ...base, pid, first: NOW }));
    const result = nextLedger({ current: rows, procs, now: NOW });
    expect(result.rows.map((row) => row.pid)).toEqual([10, 11, 20, 30]);
    expect(nextLedger({ current: [...rows].reverse(), procs, now: NOW }).rows.map((row) => row.pid)).toEqual([
      10, 11, 20, 30,
    ]);
  });

  it("caps at 5000 rows after deduping, and falls back to the cap on a bad value", () => {
    expect(LEDGER_CAP).toBe(5000);
    const many: LedgerRow[] = Array.from({ length: 5_200 }, (_, i) => ({
      ...base,
      pid: 1_000 + i,
      first: 1_700_000_000 + i,
    }));
    const capped = nextLedger({ current: many, procs: [], now: NOW });
    expect(capped.rows).toHaveLength(5000);
    // Newest first: the last 5000 survive.
    expect(capped.rows[0]?.pid).toBe(6_199);
    expect(capped.rows.at(-1)?.pid).toBe(1_200);

    expect(nextLedger({ current: many, procs: [], now: NOW, cap: 3 }).rows.map((row) => row.pid)).toEqual([
      6_199, 6_198, 6_197,
    ]);
    // A non-positive or non-integer cap is the reference's "5000" (`:787`).
    expect(nextLedger({ current: many, procs: [], now: NOW, cap: 0 }).rows).toHaveLength(5000);
    expect(nextLedger({ current: many, procs: [], now: NOW, cap: -5 }).rows).toHaveLength(5000);
    expect(nextLedger({ current: many, procs: [], now: NOW, cap: 2.5 }).rows).toHaveLength(5000);
  });

  it("caps after deduping, so duplicates cannot fill the cap", () => {
    // slp-gc.bash:466 — `unique_by(...) | sort_by(-.first) | .[:$ledgerCap]`.
    const duplicates: LedgerRow[] = Array.from({ length: 10 }, () => ({ ...base, pid: 10 }));
    const others: LedgerRow[] = [11, 12, 13].map((pid) => ({ ...base, pid, first: base.first - pid }));
    const result = nextLedger({ current: [...duplicates, ...others], procs: [], now: NOW, cap: 3 });
    expect(result.rows.map((row) => row.pid)).toEqual([10, 11, 12]);
  });

  it("returns an empty ledger when everything is empty", () => {
    expect(nextLedger({ procs: [], now: NOW })).toEqual({ rows: [] });
  });

  it("does not mutate the rows it was given", () => {
    const kept: LedgerRow = { ...base, pid: 20 };
    const snapshot = { ...kept };
    nextLedger({ ledger: [kept], procs, now: NOW });
    expect(kept).toEqual(snapshot);
  });
});
