---
name: harness-eval
description: Standard 3-mode workflow for researching harness extensions and plugins (pi extensions AND paseo plugins) - LANDSCAPE scans a family inside and outside our repos via the registries (pi.dev/packages, paseo.cafe) plus npm/GitHub/other harnesses, EVAL does a code-first assessment of one port candidate, SYNC-UPSTREAM checks whether an already-ported upstream has made progress. Use when the user wants to evaluate/borrow/port a pi extension or paseo plugin, scan what similar things exist outside, or when a dependabot witness PR reports an upstream version bump. (Formerly pi-ext-eval, renamed 2026-09-23.)
source: self-designed (pattern frozen from 5 real evals 2026-09-08→12; broadened to both harnesses 2026-09-23)
packaged_as: original
---

# harness-eval — 3-mode extension/plugin research workflow

Two companion files (same pack, synced to `~/.pi/agent/`):
- `docs/upstream-registry.md` (pi-config) — provenance ledger for every ported piece: extension ↔ upstream ↔ ported ref ↔ last check ↔ tracking mechanism. **The source of truth for mode 3.**
- `docs/ext-eval-index.md` (pi-config) — verdict board of every eval + pointers to the full briefs in the research workspace. **Every new verdict gets one row here.**

Standing principles (distilled from 5 real runs):
1. **Code-first** — every conclusion must be traceable to a REAL tarball/repo (download + read source + diff versions). Judging from README/changelog is forbidden.
2. **Compare against what we already have** — the only question that matters: what's the gap versus our pi-config extensions? Duplicate → DROP, no matter how pretty.
3. **User decides** — the researcher's verdict is only a proposal; port/borrow/drop always waits for the user's pick.
4. **Leave a trail** — briefs go to the research workspace (learn/), verdicts to `ext-eval-index.md`, port provenance to `upstream-registry.md`.

---

## Report template — mandatory for EVERY eval output (user 2026-09-24)

Every report this skill produces (Mode 1 researcher report, Mode 2 brief, Mode 3 mini-brief) follows ONE shape so runs stay comparable:

1. **TIÊU CHÍ** — criteria fixed FIRST; user agrees before evaluating. Wrong criteria = wasted eval.
2. **BẢNG VERDICT** — each row: verdict + criterion + one-line evidence. No row without a criterion.
3. **ĐỀ XUẤT-THIẾT KẾ** — per proposal, both layers:
   - **Lý do**: Vấn đề (observable, evidence) → Vì sao cần (cost of not doing) → Lợi ích (measurable) → Rủi ro (REAL, understandable, or literally `Không có` — never filler) → Công sức.
   - **Kỹ thuật**: Làm gì (files/functions) → Flow trước→sau (runtime path) → Thay đổi hành vi (what stays / what changes) → **Drift-guard** (why it cannot leak into the pi core — evals touch the core: một drift nhỏ làm cả hệ thống sai cách).
   - **NGUỒN** — every concept borrowed from outside gets credit (name + link/spec). No credit → not allowed into the report or the skill.
4. **CẦN USER QUYẾT** — explicit options; verdicts never self-execute.

Self-check before presenting (added after #294 batch slipped through with headings-only): grep for the 5 headings is NOT compliance — verify each block's sub-items (criteria numbered and locked first, verdict rows carry a criterion column, every proposal has BOTH Lý do and Kỹ thuật layers with per-piece drift-guard). The #294 upgrade pass caught a real contradiction this way: one piece's drift-guard contradicted the batch-level blanket claim.

Presentation rules (distilled from the user's own report-rewrite history, researched 2026-09-24): ít chữ, no filler · real evidence, not paraphrase · items lacking data stay listed as `chưa đủ dữ kiện`, never silently skipped · any bypass/exception states its reason · every report has a follow-up (product or user review) · one consistent format every run.

## Backlog rule — this file carries NO state (user 2026-09-24)

- Pending/unbuilt candidates & improvements → `pi-config/BACKLOG.md` (tag `repo: pi-config` / `repo: paseo-plugins`).
- Final verdicts + dates → `docs/ext-eval-index.md`. Decisions needing permanence → `docs/decisions/` ADR records (#288).
- SKILL.md is instructions + pointers only — nothing here can go stale.

## The eval LIFECYCLE — the canonical flow (user 2026-09-24)

Every eval engagement runs this spine; the modes below are the mechanics each phase calls. If an agent runs this skill and does not know whether to teach — the answer is here.

1. **TEACH-IN** (~10 min, quiz-verified) — teach the CURRENT context first so the user holds the model of what we already have. Skip only when this exact topic was already taught (check `eval_log.py query --kind teach --target <x> --last 3`; a stated skip still logs a `note`).
2. **SELF-EVAL** — Mode 2 'với chính nó' on what we own in this family: catch our own bugs before judging the market.
3. **LANDSCAPE** — Mode 1 market scan, GATED by decay (see Decay gate below).
4. **DECIDE** — user picks; the researcher's verdict is a proposal, never self-executes.
5. **TEACH-OUT (R1)** — after a big port (>4h or core-loop-touching): teach the shipped mechanism (~10 min). Small borrows may fold the teach into the DECIDE report.

**Logger duties per phase (mandatory as each phase closes):** teach → `--kind teach` (record gaps found); self-eval / landscape → their kind; decide → `--kind decision` with the user's pick verbatim; port ship → `--kind port` with commit/tag. A phase skipped for a stated reason still appends a `note` saying why — the timeline must show the branch taken, not just the work done.

## Timeline logger — every eval event appends ONE line (user 2026-09-24)

- Ledger: `pi-config/docs/eval-timeline.jsonl` via `eval_log.py` (this dir, stdlib only).
- `append --kind <landscape|deep-eval|self-eval|sync-upstream|teach|port|decision|note> --target <x> --verdict <v> [--task #id] [--report path] [--commit sha]`.
- `query --kind/--target/--since` answers "khi nào eval X, kết quả gì" WITHOUT analyze-sessions transcript mining.
- Append-only for corrections (new `note` events, never rewrites). Backfill uses `--ts` (stamps backfill:true — history honestly marked).

**Growth policy (bounded, user 2026-09-24):** a typical engagement logs 3-5 lines. The `compact` verb rolls events older than 180 days into ONE `note compact` summary line per target, MOVING the raw lines to `docs/eval-timeline.archive.jsonl` (moved, never deleted — audits stay possible). Run `compact` when the live file passes ~2,000 lines. `port` and `decision` events are ALWAYS kept verbatim in the live file (they are the permanent record); compaction only merges scan/eval/teach detail lines.

## Decay gate — two thresholds (user 2026-09-24, refines old R2)

Before phase 3 (LANDSCAPE), check the family's latest scan: `eval_log.py query --kind landscape --target <family> --last 1`.
- **Scan age > 4 weeks (OVER threshold)** → the full task set is REQUIRED: re-run Mode 1 with a fresh registry crawl before any comparison; leaning on the stale scan alone is forbidden.
- **Scan age ≤ 4 weeks (WITHIN threshold)** → reuse the existing scan and SKIP re-scanning — UNLESS the user explicitly demands a refresh.
- Either way the report cites the scan date, so a later reader knows which branch was taken.

---

## Mode 1 — LANDSCAPE (an extension family: "what's out there?")

When the user asks "is there a similar ext / how do others do it", or on a periodic scan.

1. **Identify the family** by function (task/todo, memory, goal/autonomy, subagent, plan, context-compaction...).
2. **Sources — grouped PER HARNESS, extensible** (pick groups by what's being evaluated; cross-check the other group when porting across is plausible):
   - **pi group (3 sources)**: `gh-amos` (GitHub user **amosblomqvist**, ALL repos) · `gh-pify` (GitHub org **pifydev**, ALL repos) · `pidev` (**pi.dev/packages** via npm keyword `pi-package` — pi.dev's own documented discovery mechanism: public npm + keyword + convention dirs/pi manifest → gallery-eligible; no JSON API on pi.dev itself. ~5.2k unique with npm score/metadata vs gallery ~5.7k curated — deep-tail gap, note it in the report)
   - **paseo group (1 source)**: `cafe` (**paseo.cafe** first-class `/api/plugins`: repo, npm downloads, stars, `security` blockingFindings, `health` hasTests/hasTypecheckScript — feeds the checklist directly)
   - **future harnesses**: add a group + a crawler source here when a third harness joins the eval scope.
3. **Outsource the WHOLE research leg to ONE researcher subagent — main agent only absorbs the result.** The main agent never runs the crawler or the searches itself; they cost time and context that must stay in the worker's window. Spawn role `researcher` with a brief like:
   > LANDSCAPE for family `<family>` in harness-eval, groups `<pi|paseo|both>`.
   > (1) CRAWL: run `python3 ~/.pi/agent/skills/harness-eval/crawl.py <sources...>` (stdlib-only, cached per day in `~/workspaces/learn/harness-eval-cache/` — if today's files exist, reuse, do not re-crawl; `--force <src>` only when freshness matters). Ground-truth reading is BOUNDED: `catalog.md` is the primary read; query the `<src>-<date>.json` with capped python/jq only (top-N by score, keyword filter, `[:200]` slices) — NEVER read the pidev JSON wholesale (3.2MB blows your window).
   > (2) SEARCH the angles a crawl cannot replace: npm/GitHub keyword search for the family (catches wrong/missing `pi-package` keyword); other harnesses (Claude Code docs/changelog, Codex, opencode) where the trend starts before pi/paseo ports appear; familiar authors (tintinweb, @arhen...) beyond the two crawled accounts.
   > (3) MERGE crawled + searched into ONE comparison table (name / ★-age / license / one-line mechanism / how it differs from pi-config extensions AND paseo-plugins / proposed verdict — every row tagged source=crawl|search), then answer the 6-question checklist per candidate: clean license · TUI-only · doctrine conflict (single-writer, disk-is-truth, memory-guard, safe_bash, managed-tools) · duplicates something we have · maturity (age/releases/tests/users) · integration cost.
   > (4) Submit as a report following the report template (TIÊU CHÍ → BẢNG VERDICT → ĐỀ XUẤT kèm THIẾT KẾ + NGUỒN → options) — template text: `~/.pi/agent/skills/harness-eval/SKILL.md` § Report template.
   The main agent reviews the report (code-first verification stays with the main for finalists — npm pack/clone and read the source before any port decision), then decides with the user. If the researcher goes idle without submitting — kick it, then escalate to the user.
4. Record the merged landscape in `ext-eval-index.md` (verdicts + where the family is heading).

## Mode 2 — EVAL (one candidate: "is it worth it?")

When the user picks one package for a deep evaluation. Pattern proven across 5 runs (task, workflow, swarm, plan-mode, goal):

1. **Collect for real**: `npm pack <pkg>` or clone the repo → read the whole source. If there is a version diff (`0.6.0 → 0.6.2`): tarball both, diff for real, summarize the changes per version step.
2. **Write the brief** to a fixed template (output ~15-20KB, research workspace `learn/pify-<name>-eval-YYYY-MM-DD.md`).
   The brief uses the 5-block template as its FRAME: TIÊU CHÍ first (criteria locked before evaluating), the sections below fill BẢNG VERDICT (gap table) and ĐỀ XUẤT (proposal + THIẾT KẾ), and the brief ends with CẦN USER QUYẾT — the TL;DR is that final block's one-paragraph opener:
   - **TL;DR** — proposed verdict + 2-3 sentences of reasoning.
   - **The real mechanism** — quoted code: data structures, event hooks used, main flow, safety boundaries. State line/file counts explicitly.
   - **Gap table** — each piece upstream provides VERSUS our system: which overlap (and which are stronger than ours), which are real gaps.
   - **Integration cost + risks** — which extensions it touches, any double-owner issues, daemon/pi version requirements.
   - **Port/borrow/drop proposal** — concretely split into pieces, with the cheapest option when one exists.
   - **Supply-chain pre-filter (P4, deployed 2026-09-24)** — for every finalist with a GitHub repo run `python3 ~/.pi/agent/skills/harness-eval/crawl.py --supply-chain owner/repo` (SECURITY.md + dependabot.yml existence — the cheap derivable subset of OpenSSF Scorecard, github.com/ossf/scorecard; a PRE-FILTER, not a security certificate; requires GITHUB_TOKEN in env — without it the check silently skips with a note: treat that as NOT RUN and say so in the table) and record the result in the gap table.
   - **NGUỒN** — credit every borrowed concept (report template §3).
   - **Source limits** — what could not be verified (no live run, no test suite, versions may have changed).
3. An **independent researcher** writes the brief (spawn a researcher, cheap model + web tools); kick it if it goes idle without submitting.
4. Have the user decide: **PORT** (bring the whole mechanism home, adapt it to our system) / **BORROW** (loose concept pieces) / **DROP** (duplicate/conflict) / **SET ASIDE**.
5. Record the verdict in `ext-eval-index.md`. If port/borrow: add the `upstream-registry.md` row BEFORE merging the code.

## Mode 3 — SYNC-UPSTREAM (already ported: "did upstream make progress?")

When: the `upstream-drift` workflow opens/updates an issue `[upstream-sync] <name>` (label `upstream-sync`),
or a scan finds the upstream SHA changed versus the registry's ref column.
Note: there is NO dependabot witness PR for ported exts — the ported code lives in pi-config,
a version bump installs nothing; the issue is the only signal (user decided 2026-09-12).

**Batch fan-out (N≥2 issues/candidates)**: spawn one researcher subagent per item (`spawn_pool`, concurrency 3-4),
each child gets THIS Mode-3 brief inline (npm view confirm → npm pack both refs → real diff → mini-brief per template,
bounded reads). Main only absorbs mini-briefs → ONE merged report → user decides per package → main updates
registry + index + closes issues. Single issue: main does the diff itself.
(First run: batch #294, 5 issues → 5 researchers, 2026-09-24 — coordination tax ≈5k tokens vs ~75-100k if done in main.)

1. Open `upstream-registry.md`, find the matching row → old ref.
2. **Diff for real** old → new ref (tarball both versions or `git diff` two SHAs). Do NOT read the changelog instead of diffing.

**SYNC-BORROW variant (drift issue on a BORROW row, user 2026-09-24):** a borrow has NO 1:1 artifact to diff — a code diff would be theater. Instead: read the releases/changelog across the gap versions → compare ONLY the borrowed concept region against what we absorbed → verdict per candidate piece (absorb-more / nothing-moved / our-implementation-went-further) → update the registry endpoint ref. Sourcing rule stays code-first: if the changelog hints the concept region changed, open the actual source files to confirm before proposing. Same mini-brief template, same user-decides gate.
3. **Mini-brief ~10 lines**: what changed / the stated reason / does it touch a region we already ported or a region where we have evolved beyond upstream / is there a piece worth bringing home / proposal.
4. Three outcomes:
   - **Not worth it** → update the "last check" column + new ref. Done.
   - **Worth borrowing a piece** → propose to the user → if approved, create the port task (fall back to mode 2 for that piece).
   - **Upstream regressed** (breaking, philosophy change) → record a warning in the registry + index.
5. Mind the regions of "own design beyond upstream" (like the task 3-tier verify): upstream adding something in that region does not automatically win — compare quality, not presence.

## Self-eval (target = one of OUR skills/extensions)

When the candidate is OUR OWN artifact (not an external package), run Mode 2's SHAPE with
the own-asset vocabulary: **KEEP / FIX / MOVE / DROP / SET ASIDE** (PORT/BORROW do not apply —
nothing to bring home). The evidence leg should use the skill's OWN tools where possible
(the "với chính nó" pattern, user 2026-09-24): run its scripts on its own history — that is
how the analyze-sessions self-eval (#302) caught a real false-negative bug that unit probes missed.
Triggers: a major rework shipped, an incident attributed to the artifact, or the user asks.
Output = the 5-block report + decision pair, same as any eval. Vocabulary note recorded after
2 rounds on harness-eval (#283, #295) and 1 on analyze-sessions (#302); user initially declined
the wording (2026-09-24 morning), reversed the same day on evidence.


---

## Verdict vocabulary (use consistently)

| Term | Meaning |
|---|---|
| PORT | bring the mechanism into pi-config, adapted (no package installed) — the piece keeps a 1:1 artifact lineage with a pinned upstream ref (file/function mapping), so drift-issue + Mode 3 SYNC-UPSTREAM have something to diff |
| BORROW / BORROW PIECES | take a concept/loose piece, reimplement in our system's style — source credited in the registry but NO artifact-level correspondence; nothing to sync against upstream later |
| DROP | duplicates something we already have, or conflicts with doctrine/safety |
| SET ASIDE / DEFERRED | worthwhile but not yet time; record in BACKLOG.md (tag repo:) with a re-review trigger; one summary row in the index only when a final verdict lands |
| drift-issue | the upstream-drift workflow opens an issue when upstream ≠ ported-ref; auto-closes when the registry updates — the mechanism for exts ALREADY PORTED **and BORROWED alike** (any row with an endpoint: the workflow watches the endpoint column, port or borrow) |
| borrow-drift | a drift issue firing on a BORROW row: no 1:1 artifact to code-diff — run the SYNC-BORROW variant below (changelog/concept-region re-check), never a fake code diff |
| witness-deps | devDeps pins for the 2 actually-installed externals (pi-mcp-adapter/pi-web-access) — a dependabot bump = a real upgrade; NOT for ported exts |
| own design beyond | a region where we have developed further than upstream (still recorded in the registry for comparison) |

## Known gaps → moved to the repos (2026-09-24, backlog rule above)

Formerly a state-carrying gap list lived here; it kept going stale (goal ext listed "awaiting user" long after it shipped). Pending items now live in `pi-config/BACKLOG.md`; the stale goal row was deleted as resolved (goal extension shipped through v1.4.80+).
