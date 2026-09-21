---
name: paseo-import-sessions
description: Bulk-import provider session transcripts (pi, omp, codex, opencode, copilot, claude, factory-droid) into Paseo as real agents. Use when setting up a new machine for Paseo, migrating history from CLI-only tools, backfilling after the daemon was installed late, or cleaning up empty/junk agents created by a bad import run.
---

# Paseo Import Sessions

Knowledge from the real 2026-09-18→09-20 import campaign: ~2600 sessions, 974→995 agents after audit,
126 empty agents removed manually. Every number and gotcha below was learned from the real store.

## Core principles

1. **Import = metadata + pointer.** `paseo import` creates only an agent record (~1KB) whose
   `persistence.sessionId` points to the provider's original file — it does NOT copy the transcript.
   The provider file is the real data: **never delete it**; deleting the original file breaks the
   conversation view and leaves only a metadata shell.
2. **General rule: every session WITH content must go into Paseo.** Only the four groups below may be skipped.
3. **An unimported subagent MUST be imported and then archived immediately — do NOT omit it** (user directive 2026-09-19).
   Subagents spawned in the MCP era are already live (they go through `paseo_create_agent` and have
   `subagent.role`/`subagent.parent` labels); only pre-MCP subagents remain on disk — identify them
   by a first user message that is a role prompt (for example, "You are a research specialist...")
   or the delimiter `\n---\nTASK:\n`. Import with `--label subagent.role=<role>`, then archive
   IMMEDIATELY through MCP `paseo_archive_agent`.

## Four-layer policy table (the only skips)

| Layer | Group | Reason to skip | Grows automatically? | Verification |
|---|---|---|---|---|
| 1 | **OM worker** (pi, dir `.memory-*`) | Ephemeral observational-memory worker; its knowledge has been consolidated into `.memory/` topic files | YES — every OM turn | `ls ~/.pi/agent/sessions/ \| grep memory-` |
| 2 | **New judge** (dir `--judge--/` + registry `~/.pi/agent/judge-sessions.jsonl`) | One-shot done-check verifier: reads log → PASS/FAIL → exits; first-class marker since pi-config v1.4.101 | YES — every done check | `tail ~/.pi/agent/judge-sessions.jsonl` |
| 3 | **Empty Copilot row** (sqlite `~/.copilot/session-store.db`) | Zero turns throughout — a handshake/health-check byproduct | YES | `SELECT COUNT(*) FROM turns` per session |
| 4 | **OMP observer-review** (subdir `<ts>_<uuid>/`) | Internal OMP artifact (`observerPlanReview/observerResultReview.jsonl`), not a session; the real omp session is the parent-level `<ts>_<uuid>.jsonl` file | YES | glob `[0-9a-f-]{36}\.jsonl` separately |

**Boundary:** do NOT skip a one-shot probe WITH content — import + archive it as usual
(completed for all: 5 omp stubs, 6 codex, 8+19 pi). OLD judges (pre-v1.4.101) are also
imported + archived; only NEW judges are skipped.

## File sources by provider

| Provider | Session path | Notes |
|---|---|---|
| pi | `~/.pi/agent/sessions/<cwd-slug>/*.jsonl` | exclude `.memory-*`, `--judge--/` |
| omp | `~/.omp/agent/sessions/*.jsonl` + observer-review subdirectory | parent-level uuid.jsonl files only |
| factory-droid | `~/.factory/sessions` | see the ACP shell gotcha |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | recursive glob; runs THROUGH Paseo have no rollout |
| claude | `~/.claude/projects/<slug>/` | |
| opencode | `opencode.db` sqlite | |
| copilot | `~/.copilot/session-store.db` sqlite | only zero-turn rows may be skipped |

## Queue-building process (offline first, RPC second)

1. **Scan files + classify OFFLINE** (isdir/isfile checks in Python, without calling the daemon) —
   every import RPC has a cost; a bad queue costs twice as much to clean up.
2. **Filter for hasConversation/multiple lines when building a queue from a disk scan.** Paseo's
   app picker filters empty sessions, but CLI import by `sessionId` does NOT — a one-line
   abort/auth-crash session becomes an empty agent in the list (the costliest lesson: 126 empty fd agents).
3. **Read cwd from the JSONL itself** (grep `"cwd":"..."` near the file head), then recreate the
   original cwd with `mkdir -p`: `pi import` asks "Fork this session?" interactively when `--cwd`
   differs from the original cwd, then aborts in non-interactive mode.
4. Use a TSV queue `provider<TAB>sessionId<TAB>cwd` → import loop throttled with `sleep 2`,
   log to `~/` (not `/tmp`), and run in the background with `setsid nohup` (CLI `paseo send`/import blocks the terminal).
5. The daemon rejects duplicate imports itself ("already imported") — the loop is safe; no manual deduplication is needed.
6. A successful classifier must grep `AGENT ID` (uppercase table) — grep for 'Agent'/'created' misses it.

## Operational gotchas

- **Transient 503/1006 while the daemon is busy**: do not parallelize; a final retry is enough.
  A 2s throttle is safe (a 1s throttle once broke the container on the 2600-session store).
- **ACP (fd) import creates file shells**: Paseo opens a temporary probe session → droid eagerly
  persists → each run adds 1–2 ~194B `session_start`-only shells. File-count audits MUST filter
  shells (<2KB, one line) to avoid "phantom omissions." (Upstream issue skeleton:
  `learn/fd-shell-leak-issue-proposal-2026-09-20.md`.)
- **Empty agent after a partial import**: CLI `paseo archive` cannot reach a closed agent
  ("Agent not found") — use MCP `paseo_archive_agent`.
- **Codex through Paseo does not write a rollout** (only direct CLI runs do): directly run Codex
  needs import; Codex run through Paseo is already live.

## Reusable assets

- `~/bulk-import/` (source machine): run3.sh (classifier 'AGENT ID', 2s throttle), three-phase fd sequence,
  retry chain, offline pre-classification.
- Full report: `learn/report-import-project-2026-09-20.md` (inventory + §3b + lessons learned).
- SETUP-PASEO.md section "Four-layer import policy" (abridged for new-machine setup).
