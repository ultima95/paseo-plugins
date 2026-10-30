// The process-collection phase of the GC port: `ps` rows, `top` rows, classing.
//
// Every rule here is the reference tool's (`docs/gc-port/slp-gc.bash`), and the
// cases come from two places only: the brief's table (one row per reference
// regex) and the captured fixtures in `__fixtures__/`. Nothing reads the live
// process table, so the suite cannot drift with the machine it runs on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classify, parseEtime, parsePs, parseTop } from "./procs";

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

// The two classes no fixture row covers, and the flag-count constraints the
// fixtures cannot exercise: `slp-wait` and `codex-child` were not running at
// capture time, and every captured `claude` row carries all three flags. These
// are the binding cases — each one is what a `&&` -> `||` or a dropped anchor
// in `procs.ts` turns green into red.
describe("classify — binding rules the fixtures cannot cover", () => {
  const cases: Array<[string, string | null]> = [
    // slp-gc.bash:273 — anchored `sh (.*/)?slp-wait <uuid> <digits>`.
    ["/bin/bash /usr/local/bin/slp-wait 3f1c2f0a-1111-4bbb-8ccc-1234567890ab 42", "slp-wait"],
    ["/bin/bash /usr/local/bin/slp-wait 3f1c2f0a-1111-4bbb-8ccc-1234567890ab", null],
    // slp-gc.bash:274 — an agent child needs all three flags, not two.
    ["claude --output-format stream-json --input-format stream-json", null],
    // slp-gc.bash:275 — a bare `codex` is not a codex child.
    ["codex exec hi", null],
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

// ---------------------------------------------------------------------------
// The rest is against the captured fixtures (`__fixtures__/PROVENANCE.md`).
// ---------------------------------------------------------------------------
const DIR = join(__dirname, "__fixtures__");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

const CAPTURED_PS = read("ps.txt");
const CAPTURED_TOP = read("top.txt");
const SYNTHETIC_TOP = read("top-synthetic.txt");

describe("classify — against the captured ps table", () => {
  const parsed = parsePs(CAPTURED_PS);

  it("parses every row of the capture, with no bad row and no duplicate pid", () => {
    expect(parsed.rows).toHaveLength(48);
    expect(parsed.badRows).toBe(0);
    expect(parsed.dupes).toBe(0);
  });

  it("classifies the capture exactly as PROVENANCE.md documents it", () => {
    // One row per class the reference `classify` (slp-gc.bash:262-276) emits for
    // this machine. `codex-child` and `slp-wait` were not running at capture
    // time, so those classes have no captured row here; they are covered by the
    // inline `classify — binding rules the fixtures cannot cover` block.
    const tally = new Map<string, number>();
    for (const row of parsed.rows) {
      const key = classify(row.cmd) ?? "null";
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries([...tally].sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      "app-main": 1,
      "claude-child": 3,
      daemon: 1,
      gpu: 1,
      "helper-other": 5,
      null: 30,
      "paseo-wait": 1,
      renderer: 1,
      supervisor: 1,
      "terminal-worker": 1,
      utility: 3,
    });
  });

  it("keeps a long argv intact behind the five-token lstart", () => {
    // 90 tokens of Electron argv, the widest row in the capture.
    const renderer = parsed.rows.find((row) => row.pid === 1286);
    expect(renderer).toBeDefined();
    expect(renderer?.lstart).toBe("Thu Oct 29 11:43:21 2026");
    expect(renderer?.etime_s).toBe(24280);
    expect(renderer?.rss_mb).toBe(709.9);
    expect(renderer?.cmd.startsWith(
      "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper (Renderer).app" +
        "/Contents/MacOS/Paseo Helper (Renderer) --type=renderer --user-data-dir=/Users/<user>",
    )).toBe(true);
    expect(renderer?.cmd.endsWith("--paseo-window-chrome-mode=native-mac --seatbelt-client=51")).toBe(true);
    // 39 fields in the capture = 10 fixed columns + a 29-token command: the
    // five-token lstart took exactly five, not the whole tail.
    expect(renderer?.cmd.split(/\s+/)).toHaveLength(29);
  });

  it("keeps the escaping a real argv carries", () => {
    // A `/bin/zsh -c` row: embedded `\012` escapes and shell quoting survive as
    // literal text (the command is never unescaped or re-split).
    const shell = parsed.rows.find((row) => row.pid === 41837);
    expect(shell).toBeDefined();
    expect(shell?.cmd).toContain("\\012");
    expect(shell?.cmd).toContain("'" + '"' + "'" + '"' + "'");
    expect(classify(shell?.cmd ?? "")).toBeNull();
    // 100 fields in the capture = 10 fixed columns + a 90-token command.
    expect(shell?.cmd.split(/\s+/)).toHaveLength(90);
  });
});

describe("parsePs — dupes and partial rows", () => {
  const ROW = "  101   1  101 05:12 20480 Mon Oct 27 10:00:00 2026 Paseo Supervisor";

  it("reports a pid that appears twice", () => {
    const parsed = parsePs([ROW, ROW].join("\n"));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.dupes).toBe(1);
  });

  it("skips a row whose lstart is not five tokens", () => {
    const parsed = parsePs(
      [ROW, "  102   1  102 05:12 20480 Mon Oct 10:00:00 2026 Paseo Daemon"].join("\n"),
    );
    expect(parsed.rows.map((row) => row.pid)).toEqual([101]);
    expect(parsed.badRows).toBe(1);
  });

  it("skips a row with no command field", () => {
    const parsed = parsePs(["  101   1  101 05:12 20480 Mon Oct 27 10:00:00 2026"].join("\n"));
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.badRows).toBe(1);
  });

  it("ignores empty lines and never throws on junk", () => {
    // A blank line is dropped, but a whitespace-only or junk line is counted as
    // unreadable (the reference keeps every line of length > 0 and then fails it).
    const parsed = parsePs([ROW, "", "   ", "\t", "</html>"].join("\n"));
    expect(parsed.rows.map((row) => row.pid)).toEqual([101]);
    expect(parsed.badRows).toBe(3);
  });
});

describe("parseEtime — never throws", () => {
  it("reports unreadable etime as -1", () => {
    expect(parseEtime("")).toBe(-1);
    expect(parseEtime("nonsense")).toBe(-1);
    expect(parseEtime("1:2:3:4")).toBe(-1);
  });
});

describe("parseTop", () => {
  it("converts the captured pid/mem/cmprs table", () => {
    const top = parseTop(CAPTURED_TOP);
    expect(top.size).toBe(815);
    expect(top.get(92271)).toEqual({ mem: 8, cmprs: 7.3 });
    expect(top.get(83255)).toEqual({ mem: 1.8, cmprs: 1.5 });
    // 8448K = 8.25 MB exactly: `printf "%.1f"` rounds that tie to 8.2, so the
    // port has to round the same way or its footprints drift by 0.1 MB.
    expect(top.get(59567)).toEqual({ mem: 8.2, cmprs: 8 });
  });

  it("converts G, K and B, tolerates a +/- marker and skips the # header", () => {
    const top = parseTop(SYNTHETIC_TOP);
    expect(top.size).toBe(3);
    expect(top.get(9001)).toEqual({ mem: 2048, cmprs: 3072 }); // 2G, 3G
    expect(top.get(9002)).toEqual({ mem: 0.5, cmprs: 1 }); // 512K+, 1M-
    expect(top.get(9003)).toEqual({ mem: 7, cmprs: 2 }); // 7M-, 2048K+
  });

  it("treats a value with no unit as bytes", () => {
    expect(parseTop("123 1048576 2048").get(123)).toEqual({ mem: 1, cmprs: 0 });
  });
});
