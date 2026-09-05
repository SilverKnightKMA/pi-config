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

## Audit procedure

1. `grep -rhoE 'process\.env\.[A-Z_]+' extensions/*/index.ts extensions/*/src --include='*.ts'` (exclude `node_modules`)
2. Classify every hit into one of the five categories above; new entries need
   owner + reason + removal/review condition in the same PR that introduces
   them.
3. Entries whose condition is met are removed in a single hard cut: delete the
   env read, the guarded branch, its tests, and this row in one commit.
