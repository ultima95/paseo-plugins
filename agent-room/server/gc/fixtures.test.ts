// Golden-fixture guard for the bash -> TypeScript GC port.
//
// `__fixtures__/report-live.json` is the stdout of
//   SLP_GC_STATE_DIR=server/gc/__fixtures__/state \
//     bash agent-room/docs/gc-port/slp-gc.bash report --json
// captured against the live reference tool, then path-redacted (see
// `__fixtures__/PROVENANCE.md`). Every later task's parser is written against
// this shape, so this test pins it: if the reference (or a re-capture) drifts,
// fail here rather than silently in a ported unit test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "__fixtures__");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");
const rows = (name: string) => read(name).split("\n").filter((l) => l.trim().length > 0);

// `ps -axww -o pid=,ppid=,pgid=,etime=,rss=,lstart=,command=` (slp-gc.bash:563).
// Positional, not NF-based: `lstart` is five whitespace-separated tokens and
// `command` keeps its own spaces.
const PS_SHAPE =
  /^\s*\d+\s+\d+\s+\d+\s+\S+\s+\d+\s+\S+ \S+ \d+ \d+:\d+:\d+ \d{4} .+/;

// `top -l 1 -stats pid,mem,cmprs` after the 12-line header is stripped
// (slp-gc.bash:605-612). Raw unit suffixes are preserved on purpose: the port
// must do the K/M/G/B conversion itself.
const TOP_SHAPE = /^\d+ \d+[KMG] \d+[KMG]$/;
// The live capture on this machine never emitted a `+`/`-` suffix, so those
// cases live in the separate synthetic file (see top-synthetic.txt).
const TOP_SYNTHETIC_SHAPE = /^\d+ \d+[KMG][+-]? \d+[KMG][+-]?$/;

// A re-capture must never reintroduce the credentials and personal paths that
// the first capture leaked (MCP bearer token, `--mcp-config` payloads, the
// operator's home directory).
const LEAK = /Bearer |--mcp-config|Authorization|\/Users\/ultima/;

const FIXTURE_TEXT = ["ps.txt", "top.txt", "top-synthetic.txt", "report-live.json"];

describe("gc fixtures", () => {
  it("captured report keeps the reference shape", () => {
    const report = JSON.parse(read("report-live.json"));
    expect(report.version).toBe(1);
    expect(Object.keys(report).sort()).toEqual([
      "agents",
      "daemonMetrics",
      "garbage",
      "generated",
      "home",
      "index",
      "procs",
      "retention",
      "schedules",
      "transcripts",
      "version",
    ]);
    expect(report.procs).toHaveProperty("ident.ok");
    expect(Array.isArray(report.procs.procs)).toBe(true);
  });

  it("captured process sample is a real, class-covering ps table", () => {
    const lines = rows("ps.txt");
    expect(lines.length).toBeGreaterThanOrEqual(40);
    for (const line of lines) {
      expect(line).toMatch(PS_SHAPE);
    }
    // One row per class the reference `classify` (slp-gc.bash:262-276) can emit
    // for this machine; codex-child / slp-wait were not running at capture time.
    const text = read("ps.txt");
    expect(lines.some((l) => /\/Paseo\.app\/Contents\/MacOS\/Paseo$/.test(l))).toBe(true); // app-main
    expect(text).toMatch(/^ *\d+ +\d+ +\d+ +\S+ +\d+ +\S+ \S+ \d+ \S+ \d{4} +Paseo Supervisor$/m);
    expect(text).toMatch(/^ *\d+ +\d+ +\d+ +\S+ +\d+ +\S+ \S+ \d+ \S+ \d{4} +Paseo Daemon$/m);
    expect(text).toMatch(/--type=renderer/); // renderer
    expect(text).toMatch(/--type=utility/); // utility
    expect(text).toMatch(/--type=gpu-process/); // gpu
    expect(text).toMatch(/Paseo Helper \/.*/); // helper-other / terminal-worker
    expect(text).toMatch(/\/claude --output-format stream-json/); // claude-child
  });

  it("captured top sample is a real pid/mem/cmprs table", () => {
    const lines = rows("top.txt");
    expect(lines.length).toBeGreaterThanOrEqual(40);
    for (const line of lines) {
      expect(line).toMatch(TOP_SHAPE);
    }
  });

  it("synthetic top cases cover the G suffix and the +/- markers", () => {
    const lines = rows("top-synthetic.txt");
    // The parser skips the `#` header lines (top_parse keys on `$1 ~ /^[0-9]+$/`).
    const body = lines.filter((l) => !l.startsWith("#"));
    expect(lines.length - body.length).toBeGreaterThan(0);
    for (const line of body) {
      expect(line).toMatch(TOP_SYNTHETIC_SHAPE);
    }
    const text = body.join("\n");
    expect(text).toMatch(/ \d+G /); // 2G  -> 2048 MB
    expect(text).toMatch(/ \d+K\+ /); // 512K+ -> 0.5 MB, trailing marker stripped
    expect(text).toMatch(/ \d+M- /); // 7M- -> 7.0 MB
  });

  it("fixtures carry no credentials or personal paths", () => {
    for (const name of FIXTURE_TEXT) {
      expect(read(name), name).not.toMatch(LEAK);
    }
  });
});
