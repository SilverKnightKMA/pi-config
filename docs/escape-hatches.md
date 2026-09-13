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
| `SUBAGENT_MAX_CONCURRENT` | 2 | Concurrency cap for spawned subagents (`3a956db`) |
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
