# SDD ledger — plan: docs/superpowers/plans/2026-09-30-schedule-sending.md

Setup: Ruling: dir is not a git repo and user did not ask for one, so no worktree, no commits, no sdd scripts (need git); ledger kept by hand, task-done = run tests + append line — cost if wrong: no git history to recover from after compaction; ledger is only record.
Setup: spec read (docs/superpowers/specs/2026-09-30-schedule-sending-design.md), plan read.

Pre-flight:
- T2->T3: model constants MIN_LEAD_MS/MAX_HORIZON_MS/MAX_ATTEMPTS + ScheduledMessage consumed by parse-when/view-model; names match. ok
- T2->T4: queueFileSchema/HISTORY_RETENTION_MS consumed by store; match. ok
- T2->T5: BACKOFF_MS/MAX_ATTEMPTS consumed by scheduler; match. ok
- T4->T5: QueueStore (list/get/update/prune/add) used by scheduler; match. ok
- T5->T6: AgentGateway/AgentState consumed by gateway/handlers; match. ok
- T6+T4+T5->T7: PaseoLike vs SDK PaseoApi structural compat unverified until typecheck; T7 Step 2 covers. ok
- T1->T6: probe P3/P5 may change NOT_FOUND regex / archived field; T6 reads notes. ok
- T2,T3->T8: rpc contracts + view-model helpers; SDK button types verified against 0.10.2 d.ts. ok
Task 1: complete (probes P1-P6 recorded in docs/superpowers/notes/2026-09-30-probe-results.md; no STOP condition; probe plugin removed)
Task 1: finding: scaffold tsconfig types=["react"] lacks node; Task 2 must add @types/node and "node" to types (plan Step 3 installs @types/node but does not edit tsconfig) — carried to Task 2
Task 2: Ruling: scaffold tsconfig lacked node types — added "node" to compilerOptions.types (project-wide; scaffold has no per-runtime tsconfig) and installed @types/node; client DOM safety is enforced by the rg audit instead — cost if wrong: node globals type-check in client code, audit catches misuse
Task 2: Ruling: paseo plugin init refused non-empty dir — used plan fallback (scaffold in /tmp, cp -R) — cost if wrong: none
Task 2: complete (no commits; tests: npm run typecheck && npm test → 9/9 pass, typecheck clean)
Task 3: complete (no commits; tests: npm run typecheck && npm test → 71/71 pass; client 62/62 also under TZ=America/Los_Angeles, Pacific/Auckland, Asia/Kolkata; DOM audit empty)
Task 4: complete (no commits; tests: npm run typecheck && npm test → 84/84 pass, store 13/13 incl. 4 corrupt-file variants)
Task 5: complete (no commits; tests: npm run typecheck && npm test → 104/104 pass, scheduler 20/20; mutation checks: dropping cancel re-check fails 1 test, dropping one-per-agent head selection fails 3 tests)
Task 6: complete (no commits; tests: npm run typecheck && npm test → 128/128 pass; gateway+handlers 24/24; probe P3/P5 needed no change to NOT_FOUND regex or archivedAt check)
Task 7: complete (no commits; tests: npm test → 128/128; typecheck clean, no SDK-type friction; plugin installed, paseo plugin ls = running, logs show '[schedule-sending] started' dir=/Users/ultima/.paseo/plugin-data/schedule-sending pending=0)
Task 8: complete (no commits; tests: npm run typecheck && npm test → 128/128, typecheck clean; DOM audit only hit 'Promise<unknown>' generic in schedule-form.tsx:15 (false positive); plugin reloaded, running, started pending=0; pill/popover visual check deferred to Task 9)
Task 9: Ruling: no CLI/web way to call plugin RPCs or drive the Paseo Electron UI, so engine e2e was done by seeding ~/.paseo/plugin-data/schedule-sending/queue.json + plugin reload + paseo CLI; UI steps (pill, form, preview, cancel, error state, themes, layout) were done by the user via AskUserQuestion — cost if wrong: RPC add path was only exercised by the user's manual run
Task 9: e2e results on real daemon: (B) due item stayed pending while agent busy, delivered right after turn end, chat order note-then-DELIVERED, agent replied; (C) restart gap CONFIRMED: after reload, due item stayed pending 26s+ with no agent activity, delivered within 12s of a new agent's creation (agent.created/turn_started hook); (D) archived agent -> failed "Agent archived", text never in chat; user UI check: all pass. Live proof: user's own item 'test scheduler from pill' targets this Paseo session (busy) and waits, correct wait-for-idle.
Task 9: Ruling: seed helper overwrote queue.json on each seed so E1 'Sent' history rows were gone before the user's UI check; user reported all pass anyway — cost if wrong: checklist item 1 (2 Sent rows) not actually exercised; list rendering of sent rows still not visually confirmed
Task 9: complete (no commits; tests: npm run typecheck && npm test → 128/128, plugin running; E1 archived, temp files removed; queue.json left intact: contains user's data)
Task 10: Ruling: skipped optional badge — plan says do it only if the user wants it after Task 9, spec §5.1 allows shipping without — cost if wrong: no pending-count on pill; one small task to add later
Final: review by fresh reviewer (Fable, whole tree, no git package) → 0 Critical, 4 Important, 13 Minor, verdict "With fixes"
Final: re-grade: I1 pill remove+re-add on every agent upsert (can close open popover + lose draft) stands Important; I2 pills only cover first agents.list page stands Important; I3 inspect() transport errors burn 5-attempt budget → failed in ~43 min stands Important; I4 gateway liveness only probed 60 s → verification gap, not a code defect
Final: Ruling: I3 fix — inspect() errors no longer consume attempts (item stays pending, lastError updated when it changes, retried each tick) and an item fails only once now - fireAt > 12h; send() throws keep the 5-attempt budget per spec §3 "send attempts that threw" — why: overnight bridge blip must not turn into Failed before the daemon is back — cost if wrong: a permanently broken inspect() retries every 10 s for 12 h before showing Failed
Final: Ruling: I2 fix — pass page {limit: 200} (protocol max is 200); more than 200 agents still only get pills on upsert — why: 5 agents here, cursor loop not worth it now — cost if wrong: chats beyond 200 lack a pill until they emit an update
Final: Ruling: I4 — run a 15-minute background probe (saved hook paseo, timers 5 and 15 min) now; overnight-length liveness stays unverified and is reported to the user; fix I3 removes the "fails within 43 min" failure mode — cost if wrong: after hours of silence a stale handle keeps items pending (retry until 12 h wall), then Failed
Final: Ruling: declined-to-judge lines all stand as-is: spec §7 known limits (restart gap, sleep, at-least-once on crash, blocked agent waits) and non-goals; plaintext queue file (same trust boundary as ~/.paseo); agent status error/closed treated as idle (send throws into retry path); whole-file quarantine (spec §4.1) — cost if wrong: see spec §7
Final: minor (deferred): duplicate on send timeout — pass messageId: item.id to send() as dedupe key (scheduler.ts:83, gateway.ts:38)
Final: minor (deferred): wire remaining lifecycle events (agent.archived, permission_requested/resolved, workspace.*) to wake; agent.archived could fail pending items fast
Final: minor (deferred): double-submit window in schedule-form (two taps before isPending re-render) — add submitting ref
Final: minor (deferred): previewText can split a UTF-16 surrogate pair at the 120-char cut
Final: minor (deferred): Cancel hit target is bare Text with no padding/hitSlop (mobile)
Final: minor (deferred): stale queue.json.<pid>.tmp not swept on load after a crash
Final: minor (deferred): quarantine drops individually valid items when one item is invalid (spec §4.1 mandates whole-file)
Final: minor (deferred): cancelMutation.error never clears until next cancel
Final: minor (deferred): "Due · waiting to send" hides why (agent busy vs no gateway)
Final: minor (deferred): dead scaffold: client/web.ts unused, package.json files lists nonexistent index.client.ts/index.server.tsx
Final: minor (deferred): test gaps: store.update persist failure, scheduler "delivery crashed" branch, load() non-ENOENT rethrow, pills logic
Final: minor (deferred): grammar misses "at 3am", "5h", "noon"
Final: minor (deferred): spec §3 mentions shared/schedule.ts, §6 says model.ts+rpc.ts (spec inconsistency; code follows §6)
Final: fixed I1 pill re-registration — client/pill-registry.test.ts (8 tests, incl. "keeps the mounted pill when the same agent is upserted again" and replaceAll) RED→GREEN, mutation (always remove+add) fails 2 tests, suite 136/136; pills.ts now uses createPillRegistry
Final: fixed I3 lookup outages — scheduler.test.ts "keeps an item pending through an outage…", "clears the lookup error…", "fails an item only after… retry window" + view-model.test.ts "shows why an overdue item is still waiting…" RED→GREEN, suite 140/140; spec §4.2 amended
Final: fixed I2 first-page-only pills — pills.ts passes page {limit: 200}; NOT covered by a failing test (list call needs the SDK client, pills.ts imports the React Native popover) — verified only by typecheck + protocol schema max(200); Ruling: accepted without a RED test — cost if wrong: if the daemon rejects page on a subscribed list the pills would not register (check: Schedule pill still shows after reload)
Final: Ruling: keep .superpowers/ workspace (contains this ledger) instead of deleting it — dir is not a git repo, so there is no history to be the record — cost if wrong: one git-ignorable scratch dir left in the project
Final: Ruling: skipped superpowers:finishing-a-development-branch — no git repo/branch/PR exists — cost if wrong: none
Final: I4 probe result: hook-saved paseo refreshed ok at +1m, +5m, +15m (notes file updated); hours-long silence unverified
Final: complete (tests: npm run typecheck && npm test → 140/140; plugin running with fixes; probe plugin removed, probe agent archived)
Final: I2 paging fix confirmed by user after reload: Schedule pill still shows (closes the no-RED-test risk in the I2 ruling)
