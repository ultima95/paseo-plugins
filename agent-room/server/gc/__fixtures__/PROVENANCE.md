# Fixture provenance

Every file here is either captured from the live reference tool or explicitly
marked synthetic. Nothing is hand-authored from memory. If a fixture is
re-captured, the redaction steps below are mandatory: `server/gc/fixtures.test.ts`
fails the build if an MCP bearer header, an `--mcp-config` payload, an
`Authorization` field or the operator's home path (`/Users/<user>`) ever
reappears in any of these files. (The file names of those patterns appear in this
document and in the test's regex; no captured value does.)

Capture machine: macOS (darwin), 2026-10-29, reference tool
`agent-room/docs/gc-port/slp-gc.bash` (byte-identical to
`~/.config/slp-room/bin/slp-gc`, sha256
`ac7a4c5071ebbd2f5a94fd9dcd5dc8606858804d9d297bbb45bfdd55b8e53a28`).

## `report-live.json` — captured, then redacted

```bash
cd "$HOME/Workspace/paseo-plugins/agent-room"   # = /Users/<user>/Workspace/paseo-plugins/agent-room
mkdir -p server/gc/__fixtures__/state && chmod 700 server/gc/__fixtures__/state
SLP_GC_STATE_DIR="$PWD/server/gc/__fixtures__/state" \
  bash docs/gc-port/slp-gc.bash report --json > server/gc/__fixtures__/report-live.json
```

`report --json` is the only reference subcommand ever run for this fixture;
`tick`, `record`, `--apply` and the kill flags were never invoked and the live
state dir `~/Library/Logs/slp-gc` was never targeted.

Redaction applied (JSON re-serialised compactly, key order and value types kept;
all eleven top-level keys and `version: 1` are unchanged):

- The operator's home path `/Users/<name>` → `/Users/<user>` (342 occurrences,
  including `home`).
- Its dashed slug encoding `Users-<name>-…` → `Users-<user>-…` (290 occurrences,
  e.g. `~/.paseo/agents/Users-<user>-Workspace-foo/…` and
  `~/.claude/projects/-Users-<user>-Workspace-foo/…`), so the operator's user
  name does not survive in any encoding.
- Dropped the `retention` row whose path is `…/.paseo/local-credential`: it
  exposed a private credential path and carried no data of its own
  (`{"kb":4,"count":0}`). `retention` went 42 → 41 rows; every other row is
  untouched.

Not redacted, deliberately: pids, session/agent UUIDs, and workspace directory
names inside the capture. They are the values the port has to classify, and a
later task may assert on their cross-references (`schedules[].targetAgent` ↔
`transcripts[].agent.id`), which a rewrite would silently break.

## `ps.txt` — captured, then filtered and redacted

```bash
cd "$HOME/Workspace/paseo-plugins/agent-room"   # = /Users/<user>/Workspace/paseo-plugins/agent-room
ps -axww -o pid=,ppid=,pgid=,etime=,rss=,lstart=,command= > server/gc/__fixtures__/ps.txt
```

The same field list as `collect_ps` (`slp-gc.bash:563`): `pid ppid pgid etime
rss lstart command`. `lstart` is five whitespace-separated tokens, so the rows
must be parsed positionally, not with `NF`.

The first capture was committed verbatim and leaked: three `claude` rows carried
`--mcp-config {…}` with a live MCP `Authorization` bearer token and payload
UUIDs, 48 rows carried the operator's home path, and the table included unrelated
GUI apps. The committed file is therefore a **filtered + redacted subset** of that
capture:

- Dropped every `--mcp-config` argument in full (flag *and* JSON payload,
  brace-matched), so no payload field, token or payload UUID survives.
- The operator's home path → `/Users/<user>` (paths keep their structure and depth).
- Every UUID (e.g. `--resume=<uuid>`, `… wait <uuid>`) replaced by a stable
  synthetic one of the same shape: `00000000-0000-4000-8000-00000000000N`,
  allocated per distinct original so cross-row identity is preserved.
- Dropped all rows belonging to unrelated GUI apps (`/Applications/*`,
  `/System/Applications/*`, `*.app/Contents/MacOS/*` other than Paseo) —
  Teams, Messages, Photos, Passwords, Tailscale, Docker, browsers.
- Kept every row the reference `classify` (`slp-gc.bash:262-276`) recognises:
  `app-main`, `supervisor`, `daemon`, `terminal-worker`, `renderer`, `gpu`,
  `utility`, `helper-other`, `claude-child`, `paseo-wait`. No `codex-child` and
  no `slp-wait` process was running at capture time, so those classes have no
  row. `helper-other` appears five times, `utility` three, `claude-child` three.
- Kept pid 1, one `<defunct>` zombie row, the three longest argv rows (up to 90
  tokens) and one row per helper runtime (`node`, `npm`, `*-mcp`,
  `command-code`) for positional/edge parsing.
- Result: 48 rows (from 830), 14 KB (from 156 KB). Lines keep their original
  column spacing; only the redactions above were applied.

## `top.txt` — captured, then filtered

```bash
top -l 1 -stats pid,mem,cmprs 2>/dev/null | awk 'NR>12 && NF>=3 {print $1" "$2" "$3}' \
  > server/gc/__fixtures__/top.txt
```

`pid mem cmprs` after the 12-line header, exactly what `top_parse`
(`slp-gc.bash:605-612`) consumes. Raw unit suffixes (`K`/`M`/`G`) are preserved:
converting them is the port's job. The 15 rows whose value was `0B` were dropped
so every committed line is `pid <num><K|M|G> <num><K|M|G>`; 815 rows remain.

## `top-synthetic.txt` — synthetic, not captured

The live capture produced no `G` value and no `+`/`-` state marker, so those
branches of `top_parse` cannot be captured on this machine. Three hand-written
rows cover `2G`, `512K+` and `7M-`. File header lines start with `#`; the parser
skips them because `top_parse` only accepts rows whose first field is numeric.
This file is the only synthetic fixture in the directory — no report, agent or
schedule fixture was invented.

## `state/`

Scratch state dir passed to the reference as `SLP_GC_STATE_DIR` (mode `0700`,
which is what `load_ledger` requires). It is empty on purpose; `.gitkeep` keeps
it in the tree and `agent-room/.gitignore` ignores everything else in it, so a
captured ledger can never be committed.
