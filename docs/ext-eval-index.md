# Ext-eval index — verdict board for every pi ext evaluation

> Single source of truth for verdicts (together with `docs/upstream-registry.md`, the provenance ledger).
> Full briefs (15-20KB) live in the `learn/` research workspace; each row here keeps only the
> verdict + a one-line reason + a pointer. Run process: the `pi-ext-eval` skill (3 modes:
> landscape / eval / sync-upstream).

## Master table of the 15 @pify packages (scanned 2026-09-07, frozen)

| Package (verdict at scan time) | Final verdict | Short note |
|---|---|---|
| task 0.3.0 | **PORTED** v1.4.19-24 | DAG + evidence-gate; the 3-tier verify is our own design beyond upstream |
| plan-mode 0.4.2 | **BORROWED** v1.4.31 | concepts into read-only-mode: plan file, parseSteps, control-file approve |
| workflow 0.9/0.10 | **BORROWED PIECES** v1.4.30 | resume/gate/pending → spawn_pool + queue |
| swarm 0.6.0 | **BORROWED (mechanism swapped)** v1.4.30 | queue + expect-gate; child-mechanism keeps spawn_subagent |
| goal 0.6.2 | **PORT (selective) — NOT built** (eval 2026-09-12) | continuation driver only; completion-gate weaker than the 3-tier verify → not ported |
| memory | **SET ASIDE** (user, 2026-09-10) | "lessons that stop a repeat" worth revisiting later; separate brief in learn/ |
| worktree 0.3.0 | **DEFERRED indefinitely** | worthless under single-writer until real parallel agents exist |
| subagent 0.10.0 | DROP — duplicate | subagent-types is a superset (channel, NACK, deferred-kick, auto-ping) |
| ask-question 0.3.0 | DROP — duplicate | the pi harness has native ask_user_question |
| todo 0.2.0 | DROP — duplicate | duplicates built-in todo (note: vanilla pi does NOT have todo — that comes from the Paseo/omp layer) |
| usage 0.5.0 | DROP — duplicate | covered by the om-status panel + .runs/*.cost.json |
| btw 0.3.0 | DROP — TUI-only | no widget surface in the daemon |
| pretty 0.4.0 | DROP — TUI-only | the Paseo app renders the timeline itself |
| cli 0.4.0 | DROP — conflict | pi self-update inside the container = violates the 3-tier managed-tools design |
| yolo 0.8.0 | DROP — safety conflict; **BORROW 1 piece** | pre-image NOTE + recovery-record undo → item #25 (doc, not done yet) |

## Deep evaluations (code-first briefs, independent researchers)

| Date | Topic | Brief | Verdict |
|---|---|---|---|
| 2026-09-08 | task ext + ancestors (tintinweb 199★ / eleqtrizit / nczz / pi-goal-x / mjasnikovs-AGPL) | pify-pending Part 1 | port as-is; answer the user's 6 open questions in pending |
| 2026-09-09 | @pify/workflow 0.9/0.10 | `learn/pify-workflow-eval-2026-09-09.md` (19.4KB) | (b) BORROW PIECES → shipped v1.4.30 |
| 2026-09-09 | @pify/swarm 0.6.0 | `learn/pify-swarm-eval-2026-09-09.md` (16.1KB) | (b) BORROW with child-mechanism swapped → shipped v1.4.30 |
| 2026-09-09 | @pify/plan-mode 0.4.2 | `learn/pify-planmode-eval-2026-09-09.md` (17.5KB) | 3-stage BORROW → shipped v1.4.31 |
| 2026-09-09 | @pify/memory + LLM-as-judge | `learn/pify-memory-research-2026-09-09.txt` (55KB) | set aside; direction D = Agent-as-a-Judge → basis for the layer-2 judge |
| 2026-09-12 | @pify/goal 0.6.2 (diff 0.6.0→0.6.2) | `learn/pify-goal-eval-2026-09-12.md` (17.5KB) | selective PORT (4 pieces) or a cheap 20-line borrow — AWAITING USER |
| 2026-09-12 | @pify/task 0.3.0→0.3.2 (sync issue #22, the first three modes) | diff in the session mini-brief | NO PORT CALL — just extract the sweepStep pure-function + docs polish, truth table unchanged |
| 2026-09-14 | SYNC of 4 packages (issues #23 #24 #25 #29): task 0.3.2→0.3.6 · plan-mode 0.4.2→0.4.9 · swarm 0.6.0→0.9.0 · workflow 0.10.0→0.11.6 | real tarball diff (4-scout pool + /tmp/sync-* briefs) | task: BORROW the 3-line promptSnippet (pi #2285, shipped v1.4.57); swarm: BORROW the ~80-line loop-guard (task #60 → v1.4.58), the DAG needs SETTING ASIDE; plan-mode DROP (the 4 borrowed regions are byte-identical, the delta is all TUI); workflow DROP (gate/resume byte-identical, the delta is all consent/TUI) — user approved 2026-09-14 |

## Background research beyond @pify

| Date | Topic | Verdict |
|---|---|---|
| 2026-08-30 → 09-06 | Author Eero Alvar (amosblomqvist): 6 repos, 6 design viewpoints, transcript ~150KB | origin of snip/OM/subagent; snip backend byte-identical; divergence audit of 3 intentional divergences |
| 2026-09-05 | compared the snip port vs upstream prompt-snippets at f82da56 | byte-identical + 3 intentional divergences (persistence, sticky, control-file) |
| 2026-09-08 | the 3-branch pi-tasks line + unusual npm exts (pi-goal-x, @arhen needs-edges, mjasnikovs AGPL⚠) | landscape of the task family; license disqualifier noted |
| 2026-09-12 | **anthropics/sandbox-runtime** (the bash-safety family, user-designated) — first run in LANDSCAPE mode; **verdict revised the same day per user: the runtime is not tied to the pack** | `learn/sandbox-runtime-eval-2026-09-12.md` — BORROW CONCEPTS + ADOPT srt as a PORTABLE OPTIONAL TIER: 3 text-level pieces for safe_bash on every environment (mandatory-deny write list + per-role write-allowlist + deniedDomainReasons-style messaging) + piece 4 detect-delegate-fallback `bashSandbox: auto\|srt\|off` — current container auto→text-guard, non-container Windows/Linux/macOS hosts auto→OS-sandbox |

| 2026-09-12 | **LANDSCAPE of the bash-safety family beyond srt** (4-researcher spawn_pool) | `learn/landscape-bash-safety-2026-09-12.md` — 13 candidates: **PORT 1** (opencode-bash-guard — text-tier AST segmentation + nested substitution + fail-closed + redirect-path, a direct upgrade replacing 16 regexes) · BORROW/DROP the rest · side notes: tree-sitter guards, adjacent LlamaFirewall classifier |
| 2026-09-12 | **LANDSCAPE of the memory family beyond @pify** | `learn/landscape-memory-2026-09-12.md` — 13 npm packages + 4 harnesses + 3 architectural axes: **PORT 0 · CANDIDATE 2** (pi-hermes-memory: 2-layer regex correction-detector + content-scanner + failure target; @fradser/pi-memory: plan→validate→apply with receipt/hash) · BORROW 2 (pi-memory recovery/undo; @samfp not-extract policy) · Claude Code auto-memory converges on exactly our 3-layer design |
| 2026-09-12 | **LANDSCAPE of the goal family beyond @pify** | `learn/landscape-goal-2026-09-12.md` — **PORT 0 · CANDIDATE 1** (pi-goal-x 0.31.2 MIT: checkpoint-marker + disk-persist restart-resume + 5→80s backoff ladder + delegated-guard — 4 pieces OUTSIDE @pify/goal) · BORROW 3 (Claude Code stop_hook_active+hard-cap 8+quota_auto_resume; Codex paused-stays-paused; opencode loop-break abort+resume) · DROP 7 (2 because AGPL bans porting the code) |
| 2026-09-12 | **LANDSCAPE of third-party Paseo plugins** | `learn/landscape-paseo-plugins-2026-09-12.md` — a young but alive market: ~40 repos/~50 plugins in ~3 weeks, mostly MIT; the standard pattern is a personal monorepo + `plugin add --path`; risk is source-only unsandboxed code running next to the daemon |

## Landscape scans complete (2026-09-12)

The 4 families owed in the old section were fully scanned with a 4-researcher spawn_pool
(briefs in learn/, detailed verdicts in the table above): bash-safety beyond srt · memory
beyond @pify · goal beyond @pify · third-party Paseo plugins.

Deep-evals still owed (mode 2, waiting on the user's pick):
- pi-goal-x (CANDIDATE — deep-eval the 4 pieces beyond @pify/goal; run side by side with
  the still-pending @pify/goal decision)
- pi-hermes-memory + @fradser/pi-memory (CANDIDATE — interleave with the @pify/memory
  part 2 the user set aside; hermes is only worth evaluating for the handler piece since
  the MEMORY/USER.md store overlaps)
- opencode-bash-guard (PORT already decided in the brief — awaiting the build order along
  with the 4 sandbox-runtime pieces: mandatory-deny + role allowlist + messaging + the
  optional srt tier)

Never scanned yet (open if needed):
- the plan/todo family beyond @pify (plan-mode was borrowed but its neighbors have not been scanned)
- the context-compaction family beyond our own OM
- plugins/hooks for other harnesses as a source of borrowable patterns (already touched via separate briefs)

## Memory landscape 360° 2026-09-15 (background research, feeds decision #1A)

- Full-industry memory-layer scan (4 harness native + omp 5 backends + service layer + pi ecosystem delta) run as 3 parallel
  researchers; master synthesis `learn/memory-landscape-2026-09-15.md` + 3 briefs (`learn/landscape-harness-memory-2026-09-15.md`,
  `learn/landscape-omp-service-memory-2026-09-15.md`, `learn/landscape-pi-memory-refresh-2026-09-15.md`).
- Verdicts: Claude Code BORROW (index-small + on-demand), Codex REFERENCE (port gating/redaction only), opencode REFERENCE,
  Cursor DROP (they removed Memories); omp local/learn BORROW + sharpshooter PORT (friction gate, 120-line caps);
  mem0 borrow-ideas, Letta/Zep drop, claude-mem PORT-pattern; pi delta: hermes 0.9.9 REFRESH, @aiwayds/pi-topic-memory
  NEW + borrow 3 pieces (zero-LLM inject, hit-rate log, git-traceable store), OpenViking concept-only (needs server).
- Key finding: nobody combines deterministic + survive-compaction + headless + no-server — that gap is ours; hybrid (#1A option 1)
  remains the recommendation, now with 3 concrete port pieces.
- **DECISION CLOSED 2026-09-15 (user approved hybrid): built as `extensions/lessons` (own design) + OM consolidator `record_lesson`
  global-tier write — v1.4.75. Design: docs/designs/lessons-memory-tier.md. Verdict: SHIPPED.**

## Sync log 2026-09-15 (mode 3, npm drift after 2026-09-14 sync)

- **@pify/plan-mode 0.4.9→0.4.10** — DROP (shell.ts operator-split fix; region never ported; edge cases gifted to #34)
- **@pify/swarm 0.9.0→0.9.2** — DROP (mailbox constants + consent persist; loop-guard untouched)
- **@pify/workflow 0.11.6→0.11.9** — DROP (removeIfUnchanged dead-code fix confirms #26's known bug; spawnSync 1MiB cap lesson noted)
- **@pify/memory 0.6.0→0.9.2** — RE-EVAL INPUT for the pending #1 decision (diffed 621 lines): the
  session_start-only injection gap (our "lỗ hổng 1") is FIXED upstream — new `session_compact` hook
  re-injects deterministically ("only put the user's own bytes back in front of it", no model call);
  dedupe now checks `buildContextEntries()` not raw branch; NEW opt-in LLM observer (off by default,
  consent-scoped `PIFY_MEMORY_OBSERVE`) storing notes in the session branch ledger with coverage
  markers — convergence toward our OM, but notes stay session-scoped (no cross-session store without
  the still-UI-gated consolidate). Headless `/memory` + consolidate-confirm limitation appears
  unchanged. The 4-direction decision (#1A) should be re-presented with these facts.
- **re-eval input COMPLETE 2026-09-15**: delta brief written to
  `learn/pify-memory-eval-0.9.2-addendum-2026-09-15.md` (mode-2 addendum on the delta, template
  sections, deviations declared: main-agent diff not researcher). Recommendation unchanged
  (hybrid direction 1, now cheaper with upstream's exact session_compact + buildContextEntries
  dedupe recipe). Awaiting user decision on #1A.
- GitHub repos of amosblomqvist: all 4 tracked repos frozen at registry refs (ls-remote 2026-09-15);
  1 untracked repo seen: `pi-dictate` (pushed 2026-08-31, dictation ext — not ported, no eval needed)

## Landscape sweep #48 — 6 families (2026-09-16, pool #5 + salvage)

| Date | Topic | Brief | Verdict |
|---|---|---|---|
| 2026-09-16 | **watchdog/supervisor delta** (vs 09-13 brief) | `learn/landscape-watchdog-2026-09-16.md` (18.9KB) | user chốt theo từng ứng viên trong brief |
| 2026-09-16 | **subagent channel/messaging** | `learn/landscape-channel-2026-09-16.md` (14.8KB) | user chốt theo từng ứng viên |
| 2026-09-16 | **observability** (session analytics/cost/journaling) | `learn/landscape-observability-2026-09-16.md` (17.9KB) | user chốt theo từng ứng viên |
| 2026-09-16 | **OM compaction** (topic-nén/retention) | `learn/landscape-om-compaction-2026-09-16.md` (17.9KB) | user chốt theo từng ứng viên |
| 2026-09-16 | **interactive/approval-gate** (npm vòng pi-*, lấp gap brief 09-13) | `learn/landscape-interactive-2026-09-16.md` (13.0KB) | **PORT 0 · MƯỢN 5 mảnh** (3-trạng-thái ask/allow/deny + shadow telemetry của pi-verdict; private-data path list của pi-approval-guardian; git-aware destructive check của @spences10; tách approve-scope/authorize-impl + clean-session handoff của @janvitos/pi-plan-build) **· CANDIDATE 1** (@whfzgyx/pi-approval ordered-flow semantics) · BO ~20 (permission-gate subfamily trùng safe_bash hoặc model-in-loop; @ayulab/pi-checkpoint GPL-3.0⚠) — user chốt |
| 2026-09-15 | web-access delta | `learn/landscape-web-access-2026-09-15.md` | 0 PORT wholesale; 9 MƯỢN / 7 BO / 2 CANDIDATE (đã chốt trước đó) |

| 2026-09-16 | **pi-crew** (EVAL mode-2: @melihmucuk/pi-crew 1.0.34 + npm pi-crew 0.11.0 phát hiện là project khác của baphuongna) | `learn/pi-crew-eval-2026-09-16.md` (14.5KB) | Đề xuất **DROP cả 2 + BORROW 2 mảnh**: (1) reminder-once khi child xong task không nộp report (bổ trợ research_report), (2) structured task schema {goal,context,instructions} cho spawn_pool/subagent task text. Trùng ~90% subagent-types; in-process + RAM state vs disk-is-truth/daemon-owns-children. **Chờ user chốt** |
