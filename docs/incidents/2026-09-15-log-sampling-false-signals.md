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

## Bug 2 — layer-2 judge cites stale mid-development log slices (OPEN)

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
- **Working hypothesis**: the judge packet reads a bounded/truncated window of
  the session transcript (12h session, 2 compactions) and can land mid-history;
  ordering inside the window is not guaranteed.
- **Mitigation used**: finish every completion with ONE fresh, minimal,
  authoritative probe command in the turn immediately before `task_update`, and
  appeal immediately (do not burn 3 rounds) when the citation names artifacts
  that are already fixed.
- **Open work**: audit the judge subprocess's transcript-slicing (extensions/
  task judge path) — likely needs: tail-biased window, explicit ordering
  guarantees, or passing the evidence text itself instead of re-reading the log.

## Bug 2b — plan-wake counts PARKED step-tasks as actionable open work (OPEN)

- **Symptom**: after 5 plan steps were parked (user-only reopen), the plan
  wake loop kept nudging "continue with task_update on #<parked-id>" — the
  model cannot act on parked tasks by design; each such wake is pure noise.
- **Root cause**: `openStepTasks()` (read-only-mode/index.ts) filters only
  `completed`/`cancelled`; `parked` and `held` both count as open work for the
  wake message AND for the budget. Held is legitimately model-actionable;
  parked is not.
- **Required fix shape** (follow-up task #80, needs the full ship ritual):
  wake-eligibility should exclude `parked` (pending/in_progress/held stay),
  while the AUTO-CLOSE gate must NOT — a plan whose remaining steps are all
  parked must stay open on the panel and wrap up with an "awaiting the user"
  message instead of reconciling closed. Anti-spin already stops the loop at
  streak 3 (one-round lag observed: it fires the wake before counting it),
  so the residual noise is bounded (~1-2 wakes), not unbounded.

## Shared lesson (now in the global lessons tier)

Both bugs are the same shape: a supervision component samples a long log at a
fixed offset, the sample stops representing reality, and the component acts on
the false sample with kill/hold authority. Any such component must sample the
TAIL (where new truth appends), bound its verdict to the sampled window, and
prefer fresh authoritative re-queries over cached reads.
