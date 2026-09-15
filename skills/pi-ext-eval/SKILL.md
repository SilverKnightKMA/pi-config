---
name: pi-ext-eval
description: Standard 3-mode workflow for researching pi extensions - LANDSCAPE scans an extension family inside and outside @pify, EVAL does a code-first assessment of one port candidate, SYNC-UPSTREAM checks whether an already-ported upstream has made progress. Use when the user wants to evaluate/borrow/port a pi extension, scan what similar things exist outside, or when a dependabot witness PR reports an upstream version bump.
source: self-designed (pattern frozen from 5 real evals 2026-09-08→12)
packaged_as: original
---

# pi-ext-eval — 3-mode extension research workflow

Two companion files (same pack, synced to `~/.pi/agent/`):
- `docs/upstream-registry.md` (pi-config) — provenance ledger for every ported piece: extension ↔ upstream ↔ ported ref ↔ last check ↔ tracking mechanism. **The source of truth for mode 3.**
- `docs/ext-eval-index.md` (pi-config) — verdict board of every eval + pointers to the full briefs in the research workspace. **Every new verdict gets one row here.**

Standing principles (distilled from 5 real runs):
1. **Code-first** — every conclusion must be traceable to a REAL tarball/repo (download + read source + diff versions). Judging from README/changelog is forbidden.
2. **Compare against what we already have** — the only question that matters: what's the gap versus our pi-config extensions? Duplicate → DROP, no matter how pretty.
3. **User decides** — the researcher's verdict is only a proposal; port/borrow/drop always waits for the user's pick.
4. **Leave a trail** — briefs go to the research workspace (learn/), verdicts to `ext-eval-index.md`, port provenance to `upstream-registry.md`.

---

## Mode 1 — LANDSCAPE (an extension family: "what's out there?")

When the user asks "is there a similar ext / how do others do it", or on a periodic scan.

1. **Identify the family** by function (task/todo, memory, goal/autonomy, subagent, plan, context-compaction...).
2. **Scan 3 rounds**:
   - npm: `npm search` / web_search `pi extension <family> npm`, scope `@pify/*`, names `pi-*`, familiar authors (amosblomqvist, pifydev, tintinweb, @arhen...).
   - GitHub: search `<family> pi extension`, check the pifydev + amosblomqvist orgs + fresh results.
   - **Other harnesses** (trends start here before pi ports appear): Claude Code docs/changelog, Codex, opencode — what do they do for this family, with what mechanism.
3. **Comparison table**: one row per candidate — name / ★-age / license / one-line mechanism / how it differs from ours / proposed verdict.
4. **6-question judging checklist** (every candidate):
   - Clean license? (AGPL⚠, no-license⚠ = excluded when porting)
   - TUI-only? (widget/surface that the Paseo daemon does not have → useless unless we borrow the concept)
   - Doctrine conflict? (single-writer, disk-is-truth, memory-guard, safe_bash, managed-tools — like pify/cli self-update)
   - Duplicates something we already have? (compare against pi-config extensions/ + the ext-eval-index table)
   - Maturity? (age, release count, test suite, who uses it)
   - Integration cost? (what it depends on, which extensions it touches, required daemon version)
5. Propose a verdict per candidate + an overview of where the family is heading. Record it in the landscape section of `ext-eval-index.md`.

## Mode 2 — EVAL (one candidate: "is it worth it?")

When the user picks one package for a deep evaluation. Pattern proven across 5 runs (task, workflow, swarm, plan-mode, goal):

1. **Collect for real**: `npm pack <pkg>` or clone the repo → read the whole source. If there is a version diff (`0.6.0 → 0.6.2`): tarball both, diff for real, summarize the changes per version step.
2. **Write the brief** to a fixed template (output ~15-20KB, research workspace `learn/pify-<name>-eval-YYYY-MM-DD.md`):
   - **TL;DR** — proposed verdict + 2-3 sentences of reasoning.
   - **The real mechanism** — quoted code: data structures, event hooks used, main flow, safety boundaries. State line/file counts explicitly.
   - **Gap table** — each piece upstream provides VERSUS our system: which overlap (and which are stronger than ours), which are real gaps.
   - **Integration cost + risks** — which extensions it touches, any double-owner issues, daemon/pi version requirements.
   - **Port/borrow/drop proposal** — concretely split into pieces, with the cheapest option when one exists.
   - **Source limits** — what could not be verified (no live run, no test suite, versions may have changed).
3. An **independent researcher** writes the brief (spawn a researcher, cheap model + web tools); kick it if it goes idle without submitting.
4. Have the user decide: **PORT** (bring the whole mechanism home, adapt it to our system) / **BORROW** (loose concept pieces) / **DROP** (duplicate/conflict) / **SET ASIDE**.
5. Record the verdict in `ext-eval-index.md`. If port/borrow: add the `upstream-registry.md` row BEFORE merging the code.

## Mode 3 — SYNC-UPSTREAM (already ported: "did upstream make progress?")

When: the `upstream-drift` workflow opens/updates an issue `[upstream-sync] <name>` (label `upstream-sync`),
or a scan finds the upstream SHA changed versus the registry's ref column.
Note: there is NO dependabot witness PR for ported exts — the ported code lives in pi-config,
a version bump installs nothing; the issue is the only signal (user decided 2026-09-12).

1. Open `upstream-registry.md`, find the matching row → old ref.
2. **Diff for real** old → new ref (tarball both versions or `git diff` two SHAs). Do NOT read the changelog instead of diffing.
3. **Mini-brief ~10 lines**: what changed / the stated reason / does it touch a region we already ported or a region where we have evolved beyond upstream / is there a piece worth bringing home / proposal.
4. Three outcomes:
   - **Not worth it** → update the "last check" column + new ref. Done.
   - **Worth borrowing a piece** → propose to the user → if approved, create the port task (fall back to mode 2 for that piece).
   - **Upstream regressed** (breaking, philosophy change) → record a warning in the registry + index.
5. Mind the regions of "own design beyond upstream" (like the task 3-tier verify): upstream adding something in that region does not automatically win — compare quality, not presence.

---

## Verdict vocabulary (use consistently)

| Term | Meaning |
|---|---|
| PORT | bring the mechanism into pi-config, adapted (no package installed) |
| BORROW / BORROW PIECES | take a concept/loose piece, reimplement in our system's style |
| DROP | duplicates something we already have, or conflicts with doctrine/safety |
| SET ASIDE / DEFERRED | worthwhile but not yet time; record in the index with a date |
| drift-issue | the upstream-drift workflow opens an issue when upstream ≠ ported-ref; auto-closes when the registry updates — the mechanism for exts ALREADY PORTED |
| witness-deps | devDeps pins for the 2 actually-installed externals (pi-mcp-adapter/pi-web-access) — a dependabot bump = a real upgrade; NOT for ported exts |
| own design beyond | a region where we have developed further than upstream (still recorded in the registry for comparison) |

## Known gap map (update on each new landscape)

- Directed continuation (goal anchor across compaction) — @pify/goal evaluated, awaiting user
- "Lessons that stop a repeat" (explicit memory) — @pify/memory set aside
- pre-image NOTE + recovery-record undo (yolo) — item #25
- Cross-session file-lock task scope (tintinweb) — deferred with swarm part 5
