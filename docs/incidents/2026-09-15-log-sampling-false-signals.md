# Incident: long-session log-sampling false signals — 2026-09-15

Two same-family bugs in one day: a watchdog fingerprinting a FROZEN slice of a
long activity log, and a completion judge citing a STALE slice of a long session
log. Both produced false verdicts on healthy work.

## Bug 1 — loop-guard killed healthy silent pool children (FIXED, v1.4.74)

- **Symptom**: pool-mu2rbzuq aborted all 3 researchers ~40s in with "[stopped: no
  progress] repeated the same output for 3 turns without acting".
- **Root cause**: `getActivityDigest` fingerprinted `content.slice(0, 4000)` —
  the HEAD of the daemon's curated activity. The head opens with the frozen task
  prompt (3.4KB+); children working silently (thinking + tool calls, no narrated
  text) mutate only the TAIL. Fingerprint never changed → guard fired at exactly
  repeat=3 growth ticks. Explains why the 09-14 sync scouts (short tasks, whole
  content under the cap) survived while long-task researchers died.
- **Fix**: `content.slice(-4000)` (paseo-channel.ts) + regression test with a
  Bun.serve fake daemon (SSE frame, structuredContent) asserting the head is cut
  away and appended activity changes the fingerprint.
- **Follow-up adopted**: pool-item tasks now carry a standing instruction to
  narrate a status line with each tool batch (belt under suspenders).

## Bug 2 — layer-2 judge cites stale mid-development log slices (FIXED, v1.4.76)

- **Symptom**: 5 plan step-tasks (#68/#71/#72/#73/#75, 2026-09-15 evening) held
  or parked while citing artifacts fixed several turns earlier ("1 fail dispatch
  test", "RecordLessonSchema TS error", "prompt.ts has no record_lesson") —
  verifiably false at judge time, with fresh counter-probes in the immediately
  preceding turn.
- **Pass pattern observed**: judges PASS when the decisive output is the LAST
  thing in the run log (single small command, e.g. a direct `gh pr view` state
  query, a minimal grep -c) and FAIL when evidence spans turns or sits behind
  older large outputs. Ordering confusion also observed (judge claimed a seed
  ran after the probe it preceded; filesystem mtimes disproved it).
- **Root cause (found 2026-09-16 from the judge session packets, NOT a
  transcript-window issue — the judge never reads the session transcript; it
  sees only the pickLogSlice packet of ≤20 entries)**: (A) mixed ordering —
  relevant hits chronological + rest reverse-chronological in one numbered
  list with no labels/timestamps, so the judge read packet order as time order;
  (B) head-truncation — first 3 lines/300 chars shown while suite verdict lines
  live at the END (same shape as Bug 1's head-window); (C) mid-development
  failing runs matched the same probe pattern as the final green run and always
  rode along; (D) write/edit tool calls never entered the run log (bash only),
  so file-creation evidence was invisible.
- **Fix (v1.4.76, commit 4449951)**: slice is pure NEWEST-FIRST with HH:MM:SSZ
  timestamps + explicit header label; outputs render the TAIL (last 3 lines /
  300 chars); new PATTERN HISTORY section reports older matching runs the cap
  cut with the superseded-by-newest rule; write/edit tool calls are recorded as
  runLog entries and are probe-matchable. 4 incident-regression tests in
  judge.test.ts reproduce the exact #75 packet; 1 wiring test covers write/edit
  capture.
- **Mitigation used**: finish every completion with ONE fresh, minimal,
  authoritative probe command in the turn immediately before `task_update`, and
  appeal immediately (do not burn 3 rounds) when the citation names artifacts
  that are already fixed.
- **Postmortem note**: all 5 parked steps were completed later the same night
  under the OLD judge by shaping evidence as short, last-in-log outputs —
  confirming the diagnosis mechanically (short heads pass, long/mixed tails
  fail). The evidence-shaping workaround is no longer needed from v1.4.76 on.

## Bug 2b — plan-wake counts PARKED step-tasks as actionable open work (FIXED v1.4.77)

- **Symptom**: after 5 plan steps were parked (user-only reopen), the plan
  wake loop kept nudging "continue with task_update on #<parked-id>" — the
  model cannot act on parked tasks by design; each such wake is pure noise.
- **Root cause**: `openStepTasks()` (read-only-mode/index.ts) filtered only
  `completed`/`cancelled` — ONE set served two different questions: "unfinished
  for auto-close" (parked belongs) and "actionable for waking" (parked never
  belongs; a pending step blocked by an open task doesn't either).
- **Fix shipped (v1.4.77, task #80; design confirmed by an independent Codex
  advisor 2026-09-16 — skip-and-continue, hard-pause rejected)**: pure
  `actionableSteps()` in plan.ts splits the sets — parked never actionable,
  pending-with-open-blocker not ready, in_progress/held stay. `planSettle`
  drives ONLY the actionable set (budget, signature, nudge target). When
  unresolved>0 but actionable=0 the loop goes QUIESCENT: no timer, no budget,
  ONE transition message naming parked ids + dependency-blocked ids; resume
  (user reopen) starts a FRESH episode (wakeRounds/anti-spin reset). The
  status projection gains `quiescent` and `planWakeActive()`
  (subagent-types) treats quiescent plans as inactive so the task auto-ping
  owns the cadence again — without that, a reopen would have had NO waker.
  Auto-close still requires every step resolved (parked keeps the plan open).
- **Companion (#86, same ship)**: plans gained an OPTIONAL `(after N[,M])`
  step marker — never forced, benefit-framed guidance in the approve prompt
  and write_plan description — wired by the bridge to task `blockedBy`, so
  the dependency rules above have real edges to work with.

## Shared lesson (now in the global lessons tier)

Both bugs are the same shape: a supervision component samples a long log at a
fixed offset, the sample stops representing reality, and the component acts on
the false sample with kill/hold authority. Any such component must sample the
TAIL (where new truth appends), bound its verdict to the sampled window, and
prefer fresh authoritative re-queries over cached reads.
