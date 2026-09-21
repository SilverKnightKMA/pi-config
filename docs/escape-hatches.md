# Escape hatches — owner, reason, and removal condition

Doctrine rule: a "temporary" escape without a death date is permanent. Every
environment switch below must name its owner, why it exists, and a checkable
removal/review condition. Review this table whenever an entry's condition is
met; delete the row together with the code path it guards.

Last audited: 2026-09-05 (v1.4.10).

## 1. Legacy emission escapes (scheduled to die)

| Env var | Default | Why it exists | Removal condition |
|---|---|---|---|
| `OM_TIMELINE_EMISSION=message` | off (no emission) | Restores pre-v1.2.0 in-chat OM timeline events for sessions running old code | No live session predates v1.2.0. Check: after a daemon restart that respawns all resident sessions, grep chat for `om-event` — zero hits means dead. Review: 2026-10-01 |
| `ZW_TIMELINE_EMISSION=message` | off (no emission) | Same, for zombie-watchdog `zw-warning` events | Same condition (`zw-warning` zero hits). Review: 2026-10-01 |

Both deprecations are pinned by `MARKERS.md` (MARKERS v2 contract) and by
`markers.test.ts`. Removing the env read + the legacy branch must land in the
same commit as the markers update (no dual path).

## 2. Policy switches (standing leases granted by the human)

| Env var | Default | Lease | Boundaries | Review trigger |
|---|---|---|---|---|
| `ZW_AUTO_STOP=false` | ON | Standing lease granted 2026-09-05 08:49 (user directive "code auto-stop when zombie detected") | Fires only for `zombie`, `zombie-repeat`, `b2-settle-lost`; NEVER for `tool-stall`; rate-limited 1/30s; requires `selfAgentId` + endpoint (Paseo-spawned sessions only) | Any wrong auto-stop (cancels a live, healthy turn) → immediate review, default flips pending re-lease |

## 3. Tuning knobs (documented defaults, low risk)

| Env var | Default | Meaning |
|---|---|---|
| `OM_RUNS_SWEEP_DAYS` | 7 | Age at which unconsumed `.runs/result.json` files are swept (GC `80c2683`) |
| `OM_RUNS_COST_TTL_DAYS` | 0 (off) | #32: days after which old `.runs/*.cost.json` files are folded into `.runs/rollup.json` (totals preserved for `sumRunCosts`; transcript stays the source of truth — pre-GC gate is `om_worker_cost.py --verify`). Suggested 7. One sweep per process per day at session_start |
| `SNIP_CONTROL_TTL_DAYS` | 30 | days after which an untouched snip control file gets swept (0 = off); #53 residue 249 chip |
| `AUTO_REPORT_JOIN_MS` | 10000 | #112 (v1.4.99, BORROW #111 group-join @tintinweb/pi-subagents): auto-report batching window — sibling subagents settling within the window wake main with ONE combined `[auto-report]` instead of one ping each (anti turn-shredding for ad-hoc fan-out). 0 disables (legacy immediate send). Pool children never auto-report (pool aggregate owns the wake) |
| `SUBAGENT_MAX_CONCURRENT` | 2 | Concurrency cap for spawned subagents (`3a956db`) |
| `subagentTypes.roleWriteAllowlist` (settings.json) | see `defaultWriteAllowlist` | #34 (v1.4.79): per-role bash WRITE prefixes (redirect targets + `tee`), e.g. `{"researcher": ["~/workspaces/learn", "/tmp"]}`; absent role falls to defaults (researcher/scout: cwd+/tmp; worker/main: unrestricted; unknown: /tmp). Mandatory-deny list (.bashrc/.gitconfig/.git/hooks/.mcp.json/pi settings.json/block devices) applies ALWAYS, on top of any allowlist. `/dev/null` is always allowed (v1.4.81: `2>/dev/null` is a universal idiom that writes nothing — denying it flailed pool researchers into loop-guard kills) |
| `SUBAGENT_WAIT_MS` | 4000 | Settle-wait before deferred kick machinery engages |

## 4. Reserved future flag (implement or delete)

| Env var | Default | Status |
|---|---|---|
| `PI_ZW_MODE` | `detect` | `auto` mode is declared but NOT implemented (source comment: FUTURE). Decision due 2026-10-01: either implement the auto-continuation or delete the flag and the enum branch |

## 5. Internal protocol env (NOT user-facing escapes)

`OM_COST_PATH`, `OM_RESULT_PATH`, `OM_MEMORY_DIR`, `OM_WORKER` — spawner→worker
handoff between the OM extension and its spawned observer/consolidator
processes. Not switches; part of the internal wire. Listed here only so a
future audit does not mistake them for policy knobs.

## 6. Undo — what each hatch changes and how to revert it

Pattern borrowed from `@pify/yolo` (verdict: dropped for safety conflicts, but
its pre-image + recovery-record idea is worth keeping). Before flipping any
hatch: know what state it changes (pre-image), the exact revert steps
(recovery record), and — critically — what is ALREADY SPENT and cannot be
undone. A hatch is only "safe" when all three are written down.

| Env hatch | Flipping it changes… | Revert (works) | NOT revertible (already spent) |
|---|---|---|---|
| `OM_TIMELINE_EMISSION=message` | OM emits timeline events into MODEL CONTEXT on every observer/consolidator run → context balloons fast (the pre-v1.2.0 failure mode) | unset + restart the session (env is read at process start) | context tokens already burned by emitted events stay burned; transcripts keep the chatter |
| `ZW_TIMELINE_EMISSION=message` | same shape for `zw-warning` events | unset + restart session | context tokens already burned |
| `ZW_AUTO_STOP=false` | zombie-class agents (`zombie`, `zombie-repeat`, `b2-settle-lost`) are no longer auto-cancelled → stuck agents live long, burn cost, settle-lost queues hang | unset (default ON) + restart session | agents that got stuck while the hatch was on must be stopped by hand; cost burned is gone |
| `OM_RUNS_SWEEP_DAYS=N` | unconsumed `.runs/result.json` files swept at age N instead of 7 | unset → back to 7 | already-swept result files are gone (harmless: they were consumed); note this does NOT touch `*.cost.json` |
| `SUBAGENT_MAX_CONCURRENT=N` | parallel subagent count; higher N → provider rate limits + cost spikes | unset → back to 2 | cost already burned by the burst |
| `SUBAGENT_WAIT_MS=N` | when deferred-kick machinery engages; too low → kicks may land while a turn is still running | unset → back to 4000 | none (pure timing) |
| `PI_ZW_MODE=auto` | nothing yet — `auto` is declared but NOT implemented (dead branch) | n/a until implemented | n/a — decide by 2026-10-01: implement or delete |

Rule of thumb: env hatches are read once at process start — reverting always
needs a session restart, never just unsetting the variable mid-run.

## Audit procedure

1. `grep -rhoE 'process\.env\.[A-Z_]+' extensions/*/index.ts extensions/*/src --include='*.ts'` (exclude `node_modules`)
2. Classify every hit into one of the five categories above; new entries need
   owner + reason + removal/review condition in the same PR that introduces
   them.
3. Entries whose condition is met are removed in a single hard cut: delete the
   env read, the guarded branch, its tests, and this row in one commit.

## BASH_LONG_RUN_GUARD (v1.4.71, default on)

`extensions/bash-long-run-guard` blocks silent foreground bash calls in the
recurring "Command aborted" class (test suites, installs, sleeps ≥3s, polling
loops) and answers with the background recipe (`setsid nohup … > /tmp/blk-*.log`)
instead. The tool channel intermittently kills such calls a few seconds in —
daemon restarts do not fix it. Set `BASH_LONG_RUN_GUARD=0` to restore raw
behavior.

## LESSONS_INJECT / LESSONS_MAX_LINES / LESSONS_MAX_AGE_DAYS / LESSONS_FILE (v1.4.75, default on)

`extensions/lessons` injects the newest lessons from the global tier
(`~/.pi/agent/lessons.md`, single writer = OM consolidator) at session_start
and after every compaction. Knobs: `LESSONS_INJECT=0` disables all injection;
`LESSONS_MAX_LINES` (default 8, clamp 1–50) is the newest-N recall window;
`LESSONS_MAX_AGE_DAYS` (default 30, clamp 1–365) is the age filter;
`LESSONS_FILE` overrides the path (tests/isolation). Review 2027-01-15:
expected to stay — revisit the caps after real usage data.

## PI_TELEMETRY / PI_TELEMETRY_DIR / PI_TELEMETRY_STALE_MS / PI_TELEMETRY_TOUCH_MS (v1.4.97, default on)

`extensions/telemetry` (O4, #105 — borrow from pi-telemetry 0.1.3) writes one
atomic JSON per pi process at `~/.pi/agent/telemetry/instances/<pid>.json` on
lifecycle events (session_start, turn_start, turn_end, session_compact,
session_shutdown) plus a 30s touch during long turns. Payload: activity
(working/waiting_input/shutdown), turn index, context usage and pressure
(near ≥85%, close ≥95% of the context window) — counts only, never prompt or
log content (SOC on-box rule). Consumers read the directory; a file whose
updatedAt is older than `PI_TELEMETRY_STALE_MS` (default 120000) describes a
dead instance. Stale files with dead pids are swept at session_start.
Knobs: `PI_TELEMETRY=0` disables; `PI_TELEMETRY_DIR` relocates (tests);
`PI_TELEMETRY_STALE_MS` and `PI_TELEMETRY_TOUCH_MS` retune thresholds.

## SUBAGENT_LOOP_GUARD / SUBAGENT_LOOP_REPEAT (v1.4.84, default OFF)

The pool loop-guard (`extensions/subagent-types/loop-guard.ts`, ported from
@pify/swarm in #60) aborts a child that repeats identical output without
acting. Default OFF since v1.4.84 (#91): the parent-poll wiring observes on
`updateCount` growth — which increments on every STREAMING delta — while the
curated tail only mutates when an item completes. A child thinking/generating
for >6s therefore looked exactly like a stalled repeat and was killed
mid-turn (15 productive researchers killed across 3 pools, 0 true
positives). The pure `LoopGuard` class is retained; opt back in explicitly
with `SUBAGENT_LOOP_GUARD=1` once a turn-boundary signal exists (needs
item-level activity events from the daemon). `SUBAGENT_LOOP_REPEAT` (default
3) still tunes the threshold when enabled. Deadline/turn caps keep bounding
runaway cost with the guard off.
