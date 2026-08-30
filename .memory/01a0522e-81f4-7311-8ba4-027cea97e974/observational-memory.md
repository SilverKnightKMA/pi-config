---
id: observational-memory
title: Observational-memory (OM) extension: models, settings, lifecycle, current state
summary: Configuration of the OM extension (observer/consolidator models, pool thresholds), how the .memory directory is populated by consolidation, observer stats, cost breakdown, INDEX.md refresh bug (FIXED end-to-end), and consolidator nesting bug (FIXED end-to-end).
updated: 2026-08-30 15:36
---

## Installation status

Installed near-original per handoff recommendation. Only deviations: `/om:status` output is replaced with `sendMessage`; per-widget gauges are merged into one timeline message; the cost footer is merged. OM observer model is mapped to `glm-5.3-flash`; consolidator to `glm-5.3`.

**First production run (10:43):** 3 observer runs, 52 observations, cost $0.0032, cost tracking $0.0067 across 5 runs by 10:43. Timeline notifications via `sendMessage` channel. Sessions split `om-observer` / `om-consolidator`. 214/235 unit tests in `OM` all pass.

## `settings.json` namespace (`observational-memory`)

- `observer.provider`: `cli-openai`, `observer.id`: `fci/deepseek-v4-flash`, thinking `medium`
- `consolidator.provider`: `cli-openai`, `consolidator.id`: `mmcp/MiniMax-M3`, thinking `high`
- `passive`: `false`

(Note: the runtime effective models seen during this session were `cli-openai/zaicp/glm-5.3` and `glm-5.3-flash`, matching the mapping above.)

## Lifecycle

- Observations buffer in the pi session ledger at `~/.pi/agent/sessions/` (NOT in `.memory` files).
- `.memory/` directory only gets durable topic files / `JOURNEY.md` AFTER consolidation fires.
- `om:status` numbers seen this session:
  - Initial (10:20): observers 0/4, active observations 0, next observer 7,287/10,000 tok, pool 0 tok (target 10,000, consolidate at 15,000), consolidator idle, 0 topic files, no journey, session cost $0.0000, pipeline alive.
  - Mid (10:40): observers 0/4, active observations 52, next observer 7,032/10,000 tok, pool 3,169 tok, consolidator idle, 0 topic files, no journey, session cost $0.0032 (3 runs), no errors, 37.3k raw timeline, 0 compactions.
  - Later (11:00): observer run `obs-20260830105940-1493876-6` completed with ~19 obs; cumulative cost $0.0079 across 6 runs.
  - Mid-batch (12:00): cumulative cost $0.0405 across **15 runs total**, **106 observations** promoted by consolidator.
  - During Phase 2 implementation: observer started at ~10,261 tokens tracked in this run (second compaction noted).
  - Mid-final-audit (13:26): observer ~10,022 tokens, +17 observations at $0.1108 across 25 runs.
  - Late-audit (13:27): observer ~22,258 tokens, $0.1123 across 26 runs (note: jump from 10k to 22k tokens indicates mid-session second compaction context expansion; observer also gained +7 tokens in this step).
  - Live `/om:status` (14:14): observers in flight 0/4, active observations 256, next observer 8,193/10,000 tok, pool 14,443 tok (consolidate at 15,000), consolidator idle, last compaction wait skipped, topic files 7, journey ~1,903/1,000 tok, context 128,638/150,000 tok, session cost $0.1561 (32 runs), last error none, 2 compactions.
  - Live `/om:status` (14:06): 239 active observations, 7 topic files, session cost $0.1550 (31 runs).
- This session did NOT reach the 10k consolidation threshold by natural OM means for most of the run — pool topped at 14,443/15,000 by 14:14, with a 3rd compaction imminent.
- Topic files and `JOURNEY.md` were produced by both OM consolidation passes AND by the manual consolidation agent.
- OM observer subprocess activity (observer-started events at 10:43:16 and 10:59:48) is one candidate contributor to the `message_main` parent-appearing-busy state — the observer's own authenticated POSTs to the daemon keep the activity window alive. See `message-main-bug.md`.
- Observer run layout: each run writes `result.json` + `cost.json` under `.runs/` inside the session dir (e.g. `obs-20260830102125-1493876-1.result.json`). 12 observer-run JSONs found across session dirs `01a0521d`, `01a0521e`, `01a0522e`.
- OM `paseo_cost.py --by kind` breakdown: `main` (6 agents, 1534 msgs, $20.5690), `om-observer` (15 agents, $0.0041), `subagent` (4 agents, $0.0033), `om-consolidator` (2 agents, $0.0000).
- 2 om-consolidator agents seen in cost came from earlier OM port-test sessions (`01a0521d`/`e`, ~10:01-10:02) and were no-op runs that never hit the pool threshold.

## Consolidator subprocess architecture (verified by code read)

- `spawnWorker` at `consolidator-trigger.ts:122` runs the consolidator subprocess with `cwd = runtime.memoryRoot` (sandbox root for the consolidator's scoped file tools, design risk 6).
- `buildWorkerEnv` in `src/spawn/launch.ts` sets `OM_MEMORY_DIR` to `memoryRoot`, plus `OM_WORKER` (role), `OM_RUN_ID`, `OM_RESULT_PATH`, `OM_COST_PATH`.
- `agent/index.ts` reads `OM_WORKER` env var; Phase A implements only the `'observer'` role, `'consolidator'` arrives later; consolidator worker requires `OM_MEMORY_DIR` set and its output is its `.memory/` edits (no result file).
- Consolidator worker prompt at `agent/consolidator/prompt.ts` instructs the model to fold observations into topic files under `.memory/`, has scoped `read`/`write`/`edit`/`ls`/`grep` tools confined to `.memory/`, must NOT create/edit `INDEX.md` (generated automatically), maintains `JOURNEY.md` as APPEND-MOSTLY dated segments, forbids end-of-session framing phrases like `'by session end'`.
- `buildConsolidatorPrompt` (`consolidator-trigger.ts`) injects current time, rendered index, journey text (read via `readJourney(memoryRoot)`), and observations as `<timestamp-id>  <content>` lines.
- The consolidator is deliberately NOT tracked in `observerTasks` (design R5) so compaction waits only for in-flight observers, never the consolidator; `consolidatorInFlight` flag enforces one-at-a-time; on clean exit it trusts the consolidator and re-folds against the current branch to avoid tombstoning observations committed during the run.
- INDEX.md is written by `renderIndexFile` in `src/memory/index-render.ts`; re-rendered after consolidation at `consolidator-trigger.ts:144`; `listTopics` in `src/memory/paths.ts` lists `.md` files except `INDEX.md`/`JOURNEY.md`.

## INDEX.md refresh bug + consolidator-nesting bug — FIXED end-to-end (14:00)

### Symptom

`INDEX.md` at the session-dir root reads literally `Memory index\n_No topics yet._` despite 8 topic files + `JOURNEY.md` having been written at 12:42-12:43. User directed "fix now" at 13:47.

### Root cause (two-layer)

1. **Consolidator nesting bug**: `spawnWorker` runs with `cwd = runtime.memoryRoot`, and the consolidator prompt says "write durable topic files under `.memory/`". The child resolves `.memory/` relative to its own cwd and writes one level too deep at `.memory/<sessionId>/.memory/`. Confirmed via `paseo_list_agents` showing nested `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/.memory/<topic>.md` (topic files were nested one level deeper than `INDEX.md` which sits at the session-dir top level).
2. **Scoping bug in `agent/consolidator/tools.ts`** (the deeper cause): `scoped(root, '.memory/auth.md')` nested one level deeper than `'auth.md'` (`root/.memory/auth.md` vs `root/auth.md`), even though tool descriptions promised both spellings work. The consolidator prompt's `'under .memory/'` wording made the model write `.memory/foo.md`, so topic files landed nested and INDEX (read from root top level) showed `'No topics yet'`.

### Fix

- Edited `agent/consolidator/tools.ts` `scoped()` to strip leading `'./'` and `'.memory/'` prefix before resolving, so `.memory/auth.md == auth.md`. Added a doc comment citing the 2026-08-30 `'No topics yet'` bug.
- Regression test added in `tests/consolidator.test.ts`: `'.memory/auth.md'` prefix write resolves to `memoryRoot/auth.md` (not nested) and `'./.memory/auth.md'` reads back the same file.

### Live data repair + INDEX re-render

- Synced fixed files to live `.pi/extensions/observational-memory/`.
- Moved 8 topic files + `JOURNEY.md` from `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/.memory/` up one level to `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/` and removed the empty nested `.memory` dir.
- Re-rendered live `INDEX.md` via a `bun` one-liner using `renderIndexFile` + `listTopics` + `atomicWrite` + `indexPath` from the live extension; resulting `INDEX.md` correctly lists all 8 topic files with summaries (extension-provenance, message-main-bug, observational-memory, paseo-bugs, tool-test-results, user-preferences, workspace-and-environment).
- Verified post-fix disk state at 14:19: outer level has `INDEX.md`, `JOURNEY.md` + 7 topic files, no nested `.memory` dir; consolidator ran at 14:16 on fixed code writing 6/9 topic files correctly at top level with INDEX re-rendered.

### Tests

- `bun test` passed **108/108 across 15 files in 905ms with 205 expect calls** post-fix.
- `bunx tsc -p tsconfig.json --noEmit` reported TSC_CLEAN.

### Memory path layout clarification (14:20)

- `.memory/<sessionId>/INDEX.md`, `JOURNEY.md`, and topic files is the INTENDED per-session layout (2 levels deep from project root), not "files moved". `find` across the whole tree showed no nested `.memory` remained.
- Two older session dirs (`01a0521d`, `01a0521e` from morning pre-fix runs) each contain only a hidden subdir (likely `.runs` artifacts), no nested topic dirs.

## Cross-session observation behavior

- OM produced English summaries of the assistant's turns (timestamped `2026-08-30T10:19`, accurate to the workspace survey and user request). Source chunks labeled `INERT DATA` in the observer prompt.
- `message_subagent` → `message_main` round-trip worked at child side (toolResult: `Main agent is busy — message queued, will be delivered when it goes idle.`) but parent-side delivery was NOT observed in this session's main ledger across 4+ idle transitions. Diagnosed in `message-main-bug.md` as a real queue-flush self-deadlock in `paseo-channel.ts:flushWhenIdle`.

## Compaction events

- Context was compacted once during the Phase 1 implementation task. OM observer started at ~9,863 tokens and compaction completed; assistant recapped ongoing Phase 1 work in Vietnamese noting it continues where left off.
- Second compaction noted during the index.test.ts / researcher merge phase: observer started at ~10,261 tokens tracked in this run (continuing the trend of frequent compactions during heavy implementation work).
- Third compaction during the final verification audit (13:26); assistant resumed execution exactly where it left off after compaction, demonstrating graceful context survival.
- 2 compactions total reported in `/om:status` by 14:14; a 3rd expected soon given context at 128,638/150,000 (86%).
