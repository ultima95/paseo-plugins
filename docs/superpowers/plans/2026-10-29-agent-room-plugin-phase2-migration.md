# Agent Room Phase 2 (Retire the Old Claude Room) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the old Claude-only room (four seat providers, the `supervisor` skill, and the room-only parts of `~/.config/slp-room`) while keeping `slp-gc` and its launchd job running, then prove a Paseo room still works end to end.

**Architecture:** Four staged tasks against live daemon state: edit `~/.paseo/config.json` and `paseo reload` (no daemon restart), delete the old files in one reviewed group, verify `slp-gc` still ticks, then run a smoke room on the saved seats. A fifth task records evidence and runs the plugin's own checks. Nothing in the plugin's source changes.

**Tech Stack:** `paseo` CLI 0.13.1 (`provider`, `reload`, `run`, `wait`, `ls`, `archive`, `plugin`, `status`), `python3` (JSON edit), `launchctl`, `bash`, `vitest` + `tsc` for the plugin's unchanged checks.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-room-plugin-phase2-migration-design.md`

## Global Constraints

- **No backup exists.** Every deletion is final, including the proxy credentials `ANTHROPIC_BASE_URL=http://gtg.taila97d52.ts.net:3456` and `ANTHROPIC_AUTH_TOKEN=nc-lb-…` and the files `~/.config/slp-room/{anthropic-api-key,anthropic-auth-header,anthropic-base-url,auth-mode}`. Do not create an archive.
- **Never restart the daemon.** `paseo reload` is the only configuration-apply step. A daemon restart is out of bounds.
- **Never touch the live room.** The `minimal-browser` room (`[room:supervisor] start implement task 13`, workspace `~/workspace/minimal-browser`) and its children are actively running and may create new children mid-migration; they must remain listed, unstoppable, unarchived. Only archive agents whose cwd ends in `phase2-smoke`.
- **Confirm each destructive step in chat before running it.** Tasks 1 and 2 are destructive; Task 2's `rm` group is printed and confirmed as one unit.
- **Keep exactly these under `~/.config/slp-room`:** `bin/slp-gc` and `slp-gc.conf`. Nothing else.
- **Leave untouched:** the `claude-worker` provider, all five `agentProfiles`, the `agent-room` and `command-code` plugins, `~/Library/LaunchAgents/com.paseo-slp.slp-gc.plist`, `~/Library/Logs/slp-gc/`.
- **Do not edit any file under `agent-room/` except the new acceptance record in Task 5.**
- Work happens on branch `feat/agent-room`. Never commit to `main`.

## Review Focus

1. **`paseo reload` silently keeps the old config** if the edited file is rejected — after reload, providers must vanish from `paseo provider ls` *and* `paseo status` must still report the same daemon as running; a reload that reports success but changes nothing is a failure.
2. **Stale provider references outside `config.json`** — a saved seat, archived agent, or schedule naming a removed provider. Expect a loud failure at use time, never a silent fallback onto another provider; Task 0 asserts live seats only name `command-code` and `claude`.
3. **`slp-gc` behaviour without `claude-*` directories** — its transcript scan must treat a missing `slp-room/claude-*` as "nothing to scan", not as an error; a non-zero `report` or an error line in `~/Library/Logs/slp-gc/launchd.log` fails Task 3.
4. **launchd job after the delete** — the job runs every 60s with `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin` and `/bin/bash`; it must produce a tick with exit status 0 after the deletions, not just stay loaded.
5. **A room whose seat names a provider id that no longer exists** — creation must fail visibly rather than run the seat on an arbitrary provider; Task 4 asserts the created seats' `provider` and `model` match `seats.json` exactly.

---

### Task 0: Preflight evidence (read-only)

**Files:** none modified. Evidence goes to `$COMMANDCODE_SCRATCHPAD/`.

**Interfaces:**
- Consumes: nothing.
- Produces: `$COMMANDCODE_SCRATCHPAD/phase2-providers-before.txt`, `phase2-delete-list.txt`, `phase2-providers-removed.json` (session-scoped rollback aid, not a backup), `phase2-preflight.md`.

- [ ] **Step 1: Confirm the replacement plugin is running and its seats are saved**

```bash
paseo plugin ls | grep -E '^agent-room'
cat ~/.paseo/plugin-settings/agent-room/seats.json
```

Expected: line starts `agent-room  running`; `seats.json` shows `"supervisor":{"provider":"command-code"`, `"lead":{"provider":"command-code"`, and six `peerTiers` entries.

- [ ] **Step 2: Assert saved seats name only providers that will survive**

```bash
python3 - <<'PY'
import json, pathlib
s = json.loads(pathlib.Path.home().joinpath(".paseo/plugin-settings/agent-room/seats.json").read_text())["values"]
ids = {s["supervisor"]["provider"], s["lead"]["provider"], *(t["provider"] for t in s["peerTiers"])}
print("seat providers:", sorted(ids))
assert ids <= {"command-code", "claude"}, f"stale seat provider: {ids - {'command-code','claude'}}"
print("OK seats reference only surviving providers")
PY
```

Expected: `OK seats reference only surviving providers`.

- [ ] **Step 3: Confirm the launchd job is loaded and the live room exists**

```bash
launchctl list | grep com.paseo-slp.slp-gc
paseo ls | grep -E '^cf391bb|minimal-browser'
```

Expected: `-	0	com.paseo-slp.slp-gc`; the `[room:supervisor] start implement task 13` row and its `minimal-browser` children are listed.

- [ ] **Step 4: Sweep for references outside the config**

```bash
cd ~ && grep -rln "claude-supervisor\|claude-lead\|claude-peer\|codex-peer\|slp-wait\|slp-room" \
  .claude/skills .agents/skills .claude/settings.json .zshrc .zprofile .bashrc .profile \
  .paseo/schedules .paseo/projects 2>/dev/null | grep -v '^\.claude/skills/supervisor'
```

Expected: no output. Any line here is a scope decision — stop and report it, do not delete around it.

- [ ] **Step 5: Record the before-state and the exact delete list**

```bash
cd ~ && paseo provider ls > "$COMMANDCODE_SCRATCHPAD/phase2-providers-before.txt"
{
  for p in .config/slp-room/claude-supervisor .config/slp-room/claude-lead \
           .config/slp-room/claude-peer .config/slp-room/codex-peer \
           .config/slp-room/bin/codex-peer .config/slp-room/bin/slp-wait \
           .config/slp-room/lead.md .config/slp-room/peer.md .config/slp-room/supervisor.md \
           .config/slp-room/room \
           .config/slp-room/anthropic-api-key .config/slp-room/anthropic-auth-header \
           .config/slp-room/anthropic-base-url .config/slp-room/auth-mode \
           .claude/skills/supervisor; do
    if [ -e "$p" ]; then du -sh "$p"; else echo "MISSING $p"; fi
  done
} | tee "$COMMANDCODE_SCRATCHPAD/phase2-delete-list.txt"
```

Expected: fifteen `du -sh` lines, no `MISSING` lines.

- [ ] **Step 6: Capture the four provider blocks as a session-scoped rollback aid**

```bash
cd ~ && python3 - <<'PY'
import json, os, pathlib, stat
src = pathlib.Path.home()/".paseo/config.json"
p = json.loads(src.read_text())
removed = {k: p["agents"]["providers"].pop(k) for k in
           ("claude-supervisor","claude-lead","claude-peer","codex-peer")}
out = pathlib.Path(os.environ["COMMANDCODE_SCRATCHPAD"])/"phase2-providers-removed.json"
out.write_text(json.dumps(removed, indent=2, ensure_ascii=False)+"\n")
out.chmod(stat.S_IRUSR | stat.S_IWUSR)
print("captured", sorted(removed))
PY
```

Expected: `captured ['claude-lead', 'claude-peer', 'claude-supervisor', 'codex-peer']`. This file lives in the session scratchpad and is discarded with the session; it is a rollback aid for config shape only, not a backup of credentials.

---

### Task 1: Remove the four seat providers from `config.json`

**Files:**
- Modify: `~/.paseo/config.json` (`agents.providers`)

**Interfaces:**
- Consumes: `$COMMANDCODE_SCRATCHPAD/phase2-providers-before.txt` from Task 0.
- Produces: a config with 4 fewer providers; `paseo provider ls` without the four ids.

- [ ] **Step 1: Prove the JSON round-trip is byte-identical before editing**

```bash
python3 - <<'PY'
import json, pathlib
path = pathlib.Path.home()/".paseo/config.json"
raw = path.read_text()
out = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)+"\n"
print("IDENTICAL" if out == raw else "DIFFERS — do not proceed")
PY
```

Expected: `IDENTICAL`. If it prints `DIFFERS`, stop: the edit below would reformat unrelated parts of the file.

- [ ] **Step 2: Confirm with the user, then delete the four keys**

Ask in chat: "Deleting 4 provider keys from `~/.paseo/config.json` now — this is the point of no return for the old room's credentials. Go?" Then:

```bash
python3 - <<'PY'
import json, pathlib
path = pathlib.Path.home()/".paseo/config.json"
p = json.loads(path.read_text())
prov = p["agents"]["providers"]
for k in ("claude-supervisor","claude-lead","claude-peer","codex-peer"):
    prov.pop(k)
path.write_text(json.dumps(p, indent=2, ensure_ascii=False)+"\n")
print("remaining providers:", sorted(prov))
PY
```

Expected: `remaining providers: ['antigravity', 'claude', 'claude-worker', 'copilot', 'muse', 'opencode', 'pi']` — 7 ids, the four removed ones gone. (`codex` and `command-code` are built-in providers that never appear in `config.json`; they still show in `paseo provider ls`.)

- [ ] **Step 3: Validate the file parses and the count dropped by exactly four**

```bash
python3 - <<'PY'
import json, pathlib
p = json.loads((pathlib.Path.home()/".paseo/config.json").read_text())
ids = list(p["agents"]["providers"])
assert len(ids) == 7, ids
for gone in ("claude-supervisor","claude-lead","claude-peer","codex-peer"):
    assert gone not in ids, gone
print("OK valid JSON, 7 providers, 4 removed")
PY
```

Expected: `OK valid JSON, 7 providers, 4 removed`.

- [ ] **Step 4: Apply with `paseo reload` and check the daemon survived**

```bash
paseo reload; echo "reload exit: $?"
paseo status
```

Expected: reload succeeds (exit 0) and `paseo status` still reports the same running daemon/listen endpoint (`127.0.0.1:6767`).

- [ ] **Step 5: Verify the provider list changed and nothing else did**

```bash
paseo provider ls | tee "$COMMANDCODE_SCRATCHPAD/phase2-providers-after.txt"
grep -cE 'claude-supervisor|claude-lead|claude-peer|codex-peer' "$COMMANDCODE_SCRATCHPAD/phase2-providers-after.txt"
grep -cE '^(claude|codex|command-code|claude-worker) ' "$COMMANDCODE_SCRATCHPAD/phase2-providers-after.txt"
```

Expected: the `grep -c` for removed ids prints `0`; the surviving-provider count prints `4` (grep exit 1 is fine only for the first check when it prints `0`).

- [ ] **Step 6: Confirm the live room is untouched**

```bash
paseo ls | grep -E 'cf391bb|minimal-browser'
```

Expected: same rows as Task 0 Step 3, all still present.

---

### Task 2: Delete the supervisor skill and the room-only files

**Files:**
- Delete: `~/.claude/skills/supervisor/`
- Delete: `~/.config/slp-room/{claude-supervisor,claude-lead,claude-peer,codex-peer}/`
- Delete: `~/.config/slp-room/bin/{codex-peer,slp-wait}`
- Delete: `~/.config/slp-room/{lead.md,peer.md,supervisor.md,room/}`
- Delete: `~/.config/slp-room/{anthropic-api-key,anthropic-auth-header,anthropic-base-url,auth-mode}`

**Interfaces:**
- Consumes: `$COMMANDCODE_SCRATCHPAD/phase2-delete-list.txt` from Task 0 Step 5.
- Produces: `~/.config/slp-room` containing exactly `bin/slp-gc` and `slp-gc.conf`.

- [ ] **Step 1: Print the resolved delete group and require explicit confirmation**

```bash
cd ~ && paths=(
  .claude/skills/supervisor
  .config/slp-room/claude-supervisor
  .config/slp-room/claude-lead
  .config/slp-room/claude-peer
  .config/slp-room/codex-peer
  .config/slp-room/bin/codex-peer
  .config/slp-room/bin/slp-wait
  .config/slp-room/lead.md
  .config/slp-room/peer.md
  .config/slp-room/supervisor.md
  .config/slp-room/room
  .config/slp-room/anthropic-api-key
  .config/slp-room/anthropic-auth-header
  .config/slp-room/anthropic-base-url
  .config/slp-room/auth-mode
)
for p in "${paths[@]}"; do [ -e "$p" ] && echo "WILL DELETE $p" || echo "MISSING $p"; done
```

Expected: fifteen `WILL DELETE` lines, no `MISSING`. Ask in chat: "Deleting these fifteen paths — final. Go?"

- [ ] **Step 2: Delete the group**

```bash
cd ~ && rm -rf "${paths[@]}" && echo "removed"
```

Note: `paths` must still be set in the shell running Step 2 (same shell session as Step 1). If the shell was restarted, re-run Step 1 first. Expected: `removed`, exit 0.

- [ ] **Step 3: Verify the survivors, and only the survivors**

```bash
ls -A ~/.config/slp-room
ls -A ~/.config/slp-room/bin
test -x ~/.config/slp-room/bin/slp-gc && echo "gc executable OK"
test -f ~/.config/slp-room/slp-gc.conf && echo "gc conf OK"
test -e ~/.claude/skills/supervisor && echo "SKILL STILL THERE" || echo "skill gone"
```

Expected: first listing is `bin` and `slp-gc.conf` only; second is `slp-gc` only; `gc executable OK`, `gc conf OK`, `skill gone`.

- [ ] **Step 4: Confirm no loaded skill is named `supervisor`**

```bash
grep -rl '"name": *"supervisor"\|^name: *supervisor' ~/.claude/skills ~/.agents/skills 2>/dev/null | head
```

Expected: no output.

---

### Task 3: Verify `slp-gc` still ticks

**Files:** none modified.

**Interfaces:**
- Consumes: the survivors from Task 2.
- Produces: `$COMMANDCODE_SCRATCHPAD/phase2-gc-report.txt`, `phase2-gc-launchd.txt`.

- [ ] **Step 1: Run a report manually**

```bash
SLP_GC_CONFIG="$HOME/.config/slp-room/slp-gc.conf" \
  "$HOME/.config/slp-room/bin/slp-gc" report > "$COMMANDCODE_SCRATCHPAD/phase2-gc-report.txt" 2>&1
echo "report exit: $?"
head -20 "$COMMANDCODE_SCRATCHPAD/phase2-gc-report.txt"
```

Expected: `report exit: 0` and a readable report. A non-zero exit or a `claude-` related error line fails this task.

- [ ] **Step 2: Confirm the launchd job is still loaded and how it last exited**

```bash
launchctl list | grep com.paseo-slp.slp-gc
launchctl print "gui/$(id -u)/com.paseo-slp.slp-gc" 2>/dev/null \
  | grep -E 'state|last exit code|runs =' | tee "$COMMANDCODE_SCRATCHPAD/phase2-gc-launchd.txt"
```

Expected: job listed; `last exit code = 0`.

- [ ] **Step 3: Wait for one fresh tick and check its exit status is still 0**

Wait at least 60 seconds after Step 1 (the job's `StartInterval`), then re-run:

```bash
launchctl print "gui/$(id -u)/com.paseo-slp.slp-gc" 2>/dev/null | grep -E 'runs =|last exit code'
```

Expected: `runs` increased by at least one and `last exit code = 0`.

- [ ] **Step 4: Check the job's log for errors since the deletions**

```bash
tail -n 40 ~/Library/Logs/slp-gc/launchd.log 2>/dev/null | grep -iE 'error|no such file|claude-' || echo "no errors in recent log"
```

Expected: `no errors in recent log`, or only lines that predate the deletion.

---

### Task 4: Smoke room end to end

**Files:**
- Create: `/tmp/phase2-smoke/SMOKE.md` (produced by the room, then the directory is removed)

**Interfaces:**
- Consumes: saved seats (`supervisor` and `lead` on `command-code/deepseek/deepseek-v4.1-flash`), removed providers from Task 1.
- Produces: `$COMMANDCODE_SCRATCHPAD/phase2-smoke.md` evidence; archived smoke agents.

- [ ] **Step 1: Prepare a scratch directory and start a Supervisor, deliberately requesting a provider the seat must override**

```bash
mkdir -p /tmp/phase2-smoke
paseo run --no-wait --json --cwd /tmp/phase2-smoke --provider claude \
  --title "[room:supervisor] phase 2 smoke" \
  "Have your Lead launch one Peer that writes SMOKE.md containing exactly the line phase2-ok, then report DONE to me. Keep it to one file." \
  > /tmp/phase2-smoke/run.json
python3 -c "import json;print(json.load(open('/tmp/phase2-smoke/run.json'))['id'])"
```

Expected: a full agent id is printed. The requested `claude` provider must be replaced by the seat's `command-code`. If `--json` does not print an `id` field, fall back to the id shown by `paseo ls | grep 'phase 2 smoke'` (the `shortId` works as the `<id>` argument).

- [ ] **Step 2: Wait for the room to finish**

```bash
paseo wait "$(python3 -c "import json;print(json.load(open('/tmp/phase2-smoke/run.json'))['id'])")"
```

Expected: returns when the Supervisor goes idle; no error output.

- [ ] **Step 3: Verify the seat tree and the seat override**

```bash
paseo ls --json | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if 'phase 2 smoke' in a['name'] or a['cwd'].endswith('phase2-smoke'):
        print(a['shortId'], '|', a['name'], '|', a['provider'], '|', a['status'], '|', a['cwd'])
"
```

Expected: three rows — `[room:supervisor] phase 2 smoke`, `[room:lead] …`, `[room:peer:…] …` — each with provider `command-code/deepseek/deepseek-v4.1-flash`, matching `seats.json` exactly.

- [ ] **Step 4: Verify the file came from a Peer**

```bash
cat /tmp/phase2-smoke/SMOKE.md
```

Expected: `phase2-ok`.

- [ ] **Step 5: Verify the feed recorded the room**

```bash
python3 - <<'PY'
import json, pathlib
d = json.loads(pathlib.Path.home().joinpath(".paseo/plugin-data/agent-room/rooms.json").read_text())
room = next(r for r in d["rooms"] if "phase 2 smoke" in r["task"])
ev = [e for e in d["feed"] if e.get("roomId") == room["id"]]
print("room:", room["task"], "| seats:", len([s for s in d["seats"] if s["roomId"] == room["id"]]), "| events:", len(ev))
assert len([s for s in d["seats"] if s["roomId"] == room["id"]]) >= 2, d["seats"]
assert len(ev) >= 3, ev
print("OK feed has room traffic")
PY
```

Expected: `OK feed has room traffic` with at least 3 events.

- [ ] **Step 6: Archive the smoke agents and remove the scratch directory**

```bash
paseo ls --json | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a['cwd'].endswith('phase2-smoke') or 'phase 2 smoke' in a['name']:
        print(a['id'])
" > /tmp/phase2-smoke/ids.txt
wc -l < /tmp/phase2-smoke/ids.txt
while read -r id; do paseo archive "$id"; done < /tmp/phase2-smoke/ids.txt
rm -rf /tmp/phase2-smoke
```

Expected: the id count is at least 3; each archive succeeds; the directory is removed. Do not archive anything outside `/tmp/phase2-smoke` — in particular, the live `minimal-browser` room agents are never in this list.

---

### Task 5: Record evidence, run plugin checks, commit

**Files:**
- Create: `agent-room/docs/acceptance-phase2-2026-10-29.md`

**Interfaces:**
- Consumes: evidence from Tasks 0–4.
- Produces: the acceptance record and a commit on `feat/agent-room`.

- [ ] **Step 1: Write the acceptance record with the real outputs**

Create `agent-room/docs/acceptance-phase2-2026-10-29.md` with these sections, filled from the actual command output (no paraphrasing of numbers):

```markdown
# Phase 2 migration acceptance — 2026-10-29

## Step 0 — preflight
(plugin state, seats, launchd line, reference sweep result, delete list)

## Step 1 — providers
(before/after provider rows; reload exit, status endpoint, live room intact)

## Step 2 — files
(survivor listing, skill gone, gc executable)

## Step 3 — gc
(report exit, last exit code, runs count, log tail)

## Step 4 — smoke room
(seat rows with provider/model, SMOKE.md contents, feed event count)

## Deviations
(anything that differed from the plan; "none" if none)

## Not done
- slp-gc port (Phase 3)
- claude-worker removal (out of scope)
```

- [ ] **Step 2: Re-read the plan's Global Constraints and confirm none were violated**

Checklist to confirm in chat: no archive created, daemon never restarted, live `minimal-browser` room untouched, `slp-room` reduced to two entries, `claude-worker` and the five profiles still present, no `agent-room/` source file modified.

- [ ] **Step 3: Run the plugin's own checks**

```bash
cd /Users/ultima/Workspace/paseo-plugins/agent-room && npm test && npm run typecheck
```

Expected: vitest passes; `tsc --noEmit` exits 0.

- [ ] **Step 4: Confirm the plugin still runs**

```bash
paseo plugin ls | grep -E '^agent-room'
```

Expected: `agent-room  running`.

- [ ] **Step 5: Commit on the feature branch**

```bash
cd /Users/ultima/Workspace/paseo-plugins
git status --short
git add agent-room/docs/acceptance-phase2-2026-10-29.md
git commit -F - <<'EOF'
docs(agent-room): phase 2 migration acceptance record

Record provider removal, file deletions, the gc tick after the wipe,
and the smoke room that ran on the saved seats.

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>
EOF
```

Expected: commit created on `feat/agent-room`; `git status` clean apart from pre-existing untracked files.

---

## Rollback notes

- **Task 1 only:** re-add the four blocks from `$COMMANDCODE_SCRATCHPAD/phase2-providers-removed.json` into `agents.providers`, then `paseo reload`. Routing shape returns; the old room still cannot run, because the proxy credentials are deleted by design.
- **Task 2 onwards:** no rollback. Files and credentials are gone.
- **After Task 4 fails:** stop. Phase 2 is blocked on an agent-room defect and there is no old room to fall back to; the path upgrades to a Phase 1 fix.
