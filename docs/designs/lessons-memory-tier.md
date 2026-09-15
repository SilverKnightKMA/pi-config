# Design: Lessons — global memory tier (decision #1A, direction 1 hybrid)

Status: DESIGNED (awaiting user plan-mode approval to build) · Date: 2026-09-15
Inputs: `learn/memory-landscape-2026-09-15.md` + 3 landscape briefs + `learn/pify-memory-eval-0.9.2-addendum-2026-09-15.md`

## Problem (why)

- **P1 cross-session**: lessons learned in one session (`.memory/<sessionId>/`) never reach new sessions automatically. Real case: bash-abort lesson recorded 2026-09-05; the 2026-09-15 session repeated the failure and the user complained twice.
- **P2 in-session**: anything injected at `session_start` is lost at the first compaction. Whole industry converged on re-inject from disk after compaction (Claude Code re-reads; @pify/memory 0.9.2 added exactly this hook).
- **P3 (out of scope this phase)**: topic files grow unbounded. OM's memory map is already the industry's winning pattern (terse 1-line/topic + on-demand reads). Only a per-file hard cap (omp sharpshooter friction gate) is missing — separate future item.

## Goal / non-goals

**Goal**: lessons of type failure/correction/preference survive (a) session boundaries and (b) compaction, with $0 additional model calls, OM remaining the single writer.

**Non-goals**: no agent-facing write tool (agent never writes lessons directly), no semantic search (BM25/embedding) — 8-newest deterministic recall is the deliberate first tier; no change to `.memory/<sessionId>/` topic files, footer recall, or memory-guard.

## Architecture (3 components)

```
OM worker (subprocess, single-writer, secret-gated)
   └─ consolidator, when folding topics, also appends 1 line per
      failure/correction/preference lesson to ~/.pi/agent/lessons.md
~/.pi/agent/lessons.md  (global tier, plain text, 1 lesson = 1 line, cap 200)
   └─ read-only for everyone else
new small extension `lessons` (pure injector, no writes, no model calls)
   ├─ session_start   → pi.sendMessage(customType "lessons-context", display:false)
   │                    with the newest N=8 lessons aged ≤30 days
   └─ session_compact → same injection re-sent after EVERY compaction
                        (event exists in pi engine: extensions.md L452)
```

## Data format

```
[2026-09-05][failure] bash silent-abort >2s — run long commands via setsid nohup bg + log file
[2026-09-15][preference] user wants component-level designs before any build
```

- One line per lesson: `[YYYY-MM-DD][tag] text` — tag ∈ {failure, correction, preference, convention} (taxonomy borrowed from @pify/memory, portable idea).
- Cap 200 lines; when full, oldest trimmed at write time (hysteresis: trim only when > 232 lines, batch-drop to 200 — avoids write-time churn).
- File lives at `~/.pi/agent/lessons.md` — deliberately NOT under `.memory/` (memory-guard scope untouched) and NOT under `~/.pi/agent/memory/` (@pify/memory's path — avoids two-writer collision if upstream is ever installed).

## Injector mechanics (`extensions/lessons/`)

- `session_start` handler (all reasons incl. fork): read file (HOME-aware), parse, filter by age ≤ `LESSONS_MAX_AGE_DAYS` (30), take newest `LESSONS_MAX_LINES` (8), render block, `pi.sendMessage({ customType: "lessons-context", display: false })`.
- `session_compact` handler: re-send the same block (re-read from disk — mid-session writes by OM are picked up; recipe proven by @pify/memory 0.9.2). No dedupe needed: compaction removes the previous injected block, and the handler fires exactly once per compaction.
- Empty/missing file → no injection, zero noise. Injection text ≤ ~1.2KB typical (8 lines).
- Pure core in `src/lessons-core.ts` (parse/filter/render/trim — plain functions, unit-testable without pi); wire-up in `index.ts` (goal/task extension pattern).

## OM consolidator change (`extensions/observational-memory/`)

- Consolidation instructions gain one clause: when a folded lesson is a failure/correction/preference, append it as one tagged line to the global tier path.
- Append path: `appendFileSync` single-line (POSIX-atomic for small writes). Trim path: read → drop oldest → tmp+rename (HOME-aware atomic pattern already used by goal extension). Two sessions' workers trimming concurrently worst-case duplicate a trim — accepted, noted.
- Secret gate: each candidate line passes the OM worker's existing secret scan; a hit drops the line and logs to the OM status file (never written to the global tier).
- OM stays the ONLY writer; the agent itself has no tool that writes this file.

## Escape hatches (docs/escape-hatches.md rows, with review dates)

| Env | Default | Effect | Review |
|---|---|---|---|
| `LESSONS_INJECT` | `1` | `0` disables all injection | 2027-01-15 |
| `LESSONS_MAX_LINES` | `8` | newest-N injected | 2027-01-15 |
| `LESSONS_MAX_AGE_DAYS` | `30` | age filter | 2027-01-15 |
| `LESSONS_FILE` | `~/.pi/agent/lessons.md` | path override (tests) | — |

## Testing

1. `lessons-core.test.ts` — parse roundtrip, malformed lines dropped, age filter boundary (30d ±1), newest-N order, trim hysteresis 232→200, render block format, secret-pattern line rejected.
2. `lessons/index.test.ts` — session_start injects (fake pi harness, goal-extension wire-up pattern), empty file → no message; session_compact re-injects; `LESSONS_INJECT=0` → no-op.
3. OM test — consolidator global-tier append + trim + secret-drop unit tests.
4. `extension-smoke` picks the new extension up automatically (smoke-extensions.mjs lists the dir).

## Build order (each part lands green: tests + tsc + suite + smoke)

1. **Part ①** `extensions/lessons/` injector (`session_start` only) + core + tests + upstream-registry row (own-design + credited ideas).
2. **Part ②** `session_compact` re-inject + test.
3. **Part ③** OM consolidator global-tier write + secret gate + trim + docs (escape-hatches rows) + ext-eval-index verdict row.

Estimated: ① ~180 lines + tests; ② ~25 lines; ③ ~90 lines inside OM.

## Credit (registry rows on merge)

- `@pify/memory` 0.9.2 — session_compact re-inject recipe + dedupe insight (MIT).
- Claude Code auto memory — index-small + on-demand pattern (validated OM's existing map).
- omp sharpshooter — friction-gate idea, deferred to V3 future item.

## Cost analysis

$0 new model calls: injection is pure code; tagging rides the existing consolidation call. Injection block ~1.2KB per session start + per compaction — negligible vs context budget.
