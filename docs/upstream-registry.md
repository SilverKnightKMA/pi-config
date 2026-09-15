# Upstream registry — provenance ledger for every ported/borrowed piece

> Single source of truth for the **SYNC-UPSTREAM** mode of the `pi-ext-eval` skill.
> Each row: our extension ↔ external origin ↔ ported ref ↔ last check ↔ tracking mechanism.
> When upstream moves (dependabot witness PR or a periodic scan) → run the sync mode in the skill
> → record the conclusion in the "last check" column + add a row to `ext-eval-index.md`.

Tracking mechanisms:
- **drift-issue** — the `.github/workflows/upstream-drift.yml` workflow (weekly + manual) reads the endpoint column and compares the ported ref against npm `/latest` + the GitHub HEAD; on drift it opens issue `[upstream-sync] <name>` (label `upstream-sync`, auto-closes when the registry updates the ref). **This is the only mechanism for exts already PORTED/CONVERTED** — the ported code lives in pi-config and installs no external package, so a version bump conveys no upgrade.
- **witness-deps** — ONLY for the 2 externals actually installed (`EXTERNALS` in scripts/install-externals.mjs: pi-mcp-adapter, pi-web-access). Version truth lives in devDependencies → dependabot bump → release → docker pin → host install = a REAL upgrade chain. Does not apply to ported exts.

## Extensions

The **endpoint** column is the machine-readable format for the `upstream-drift` workflow (one cell may hold multiple endpoints separated by spaces). Format: `npm:<package>@<ported-version>` or `gh:<owner>/<repo>@<sha7>`. A `gh:` endpoint tracks the repo's HEAD — on drift, the mini-brief only needs to diff the relevant extension directory.

| Extension (pi-config) | Origin | Ported ref | Last check | Tracking | endpoint |
|---|---|---|---|---|---|
| `task` | `@pify/task` (the tintinweb/pi-tasks line) — concepts: DAG blockedBy, evidence-gate, transient nudges, ledger | npm `@pify/task@0.3.0` (snapshot 2026-09-07, MIT) | 2026-09-14 — diff 0.3.2→0.3.6 (issue #29): the delta is all promptSnippet metadata (pi #2285 changed the default: a tool without a promptSnippet disappears from the system prompt's "Available tools") + README badges → BORROW the 3-line promptSnippet for task_create/update/list, shipped v1.4.57 | drift-issue | `npm:@pify/task@0.3.6` |
| `task` (3-tier verify) | **own design** — layer 0/1/2, PARK, doneCheck guard; NOT present upstream | — | — | — | — |
| `snip` | `amosblomqvist/pi-config` `extensions/prompt-snippets` — backend byte-identical at port time; 3 intentional divergences: persistence (ledger), sticky, control-file bridge | commit `f82da56` (2026-08-24) | 2026-09-12 — upstream unchanged at f82da56 | drift-issue | `gh:amosblomqvist/pi-config@f82da56` |
| `ask-user-question` | RPC-compatible fork of the same-named extension in `amosblomqvist/pi-config` | `f82da56` | 2026-09-12 — unchanged | drift-issue | `gh:amosblomqvist/pi-config@f82da56` |
| `quiz` | fork of `amosblomqvist/learn` `extensions/quiz.ts` | learn `7cfd894` (2026-08-25) | 2026-09-12 — unchanged | drift-issue | `gh:amosblomqvist/learn@7cfd894` |
| `observational-memory` | near-verbatim port of `amosblomqvist/pi-observational-memory` (HANDOFF included at port time); has since evolved on its own through many rounds (status v2, durable cost, stdin fix v1.4.36) | `78a1efc` (2026-08-24) | 2026-09-12 — unchanged | drift-issue | `gh:amosblomqvist/pi-observational-memory@78a1efc` |
| `subagent-types` | fusion: `amosblomqvist/pi-subagents` (spawn base + the scout/researcher/worker roles) + the `learn` repo (mermaid-maker, svg-maker, roles) + **a two-way channel of our own design with no upstream**; auto-ping/main-tool-block/NACK/deferred-kick are all our own design | pi-subagents `1f54189`, learn `7cfd894` | 2026-09-12 — unchanged | drift-issue | `gh:amosblomqvist/pi-subagents@1f54189` |
| `web-fetch` | near-verbatim copy of `amosblomqvist/pi-config` web-fetch | `f82da56` | 2026-09-12 — unchanged | drift-issue | `gh:amosblomqvist/pi-config@f82da56` |
| `md-log` | a rewrite modeled on the `learn` repo's `extensions/md-link.ts` (file since deleted upstream; the header records the origin) | learn `7cfd894` | 2026-09-12 — unchanged | drift-issue | `gh:amosblomqvist/learn@7cfd894` |
| `read-only-mode` | **own design** v1.4.17; v1.4.31 borrowed concepts from `@pify/plan-mode@0.4.2` (plan file + parseSteps + step cursor + control-file approve) | plan-mode 0.4.2 | 2026-09-15 — diff 0.4.9→0.4.10: ONE file (`src/shell.ts`) — operator-split fix (multi-char ops before single-char prefixes, newline/CR as terminators, `&` background vs `2>&1` fd-merge edge cases). Not a region we ported → DROP, ref bumped 0.4.10. Edge-case list recorded as free test cases for #34 bash-guard AST segmentation | drift-issue | `npm:@pify/plan-mode@0.4.10` |
| `subagent-types` (spawn_pool) | borrowed concepts from `@pify/swarm@0.6.0` (queue + expect-gate) + `@pify/workflow` (resume/gate) — child-mechanism swapped to our spawn_subagent | swarm 0.6.0 / workflow 0.10.0 | 2026-09-15 — diff 0.9.0→0.9.2 + 0.11.6→0.11.9: swarm delta = mailbox tool-name constants + consent persist (loop-guard untouched) → DROP. workflow delta = removeIfUnchanged dead-code FIX (the bug #26 knew), settleWorktree, spawnSync 1MiB output-cap fix, ScriptTimeoutError, runGate exported → gate/resume region unchanged → DROP (1MiB lesson noted for our own spawn runners). Refs bumped | drift-issue | `npm:@pify/swarm@0.9.2 npm:@pify/workflow@0.11.9` |
| `subagent-types` (safe_bash) | v1.4.79 (#34): the 16-regex deny-list is REPLACED by AST segmentation — mechanism ported from `opencode-bash-guard` (tarball 0.1.1, MIT): parse bash → walk segments → judge per-segment; nested `$(...)`/backtick/`<(...)` walked recursively; heredoc payload = data (never judged); parse error fails CLOSED. Deny rules + mandatory-deny write list + role write-allowlist + `#43` denial envelope are OUR design (upstream has no rule set of its own — it reuses host `permission.bash`) | `opencode-bash-guard@0.1.1` (mechanism) + `unbash@4.0.11` (ISC, 0-dep parser, runtime dep) | 2026-09-16 — ported at tarball 0.1.1 | drift-issue | `npm:opencode-bash-guard@0.1.1` + `npm:unbash@4.0.11` |
| `zombie-watchdog` | **own design** 2026-09-01 (after chats #3845/#3847) | — | — | — | — |
| `sse-probe` | **own design** (zaicp SSE detector) | — | — | — | — |
| `visual-tools` | **own design** for the Obsidian/teach pipeline | — | — | — | — |
| `lessons` | **own design** (global memory tier #1A, v1.4.75) — pure injector at session_start + session_compact; ideas credited: `@pify/memory` 0.9.2 session_compact re-inject recipe + dedupe insight (MIT), Claude Code auto-memory index-small/on-demand pattern (validated OM's map), 4-tag taxonomy (failure/correction/preference/convention) borrowed from @pify/memory | @pify/memory 0.9.2 (recipe only, no code) | 2026-09-15 | drift-issue | `npm:@pify/memory@0.9.2` |

## Externals actually installed (witness-deps, root package.json devDependencies)

| Package | Pin | Meaning |
|---|---|---|
| `pi-mcp-adapter` | 2.32.1 | actually installed via install-externals.mjs — a dependabot bump = a real upgrade (release → docker pin → host install) |
| `pi-web-access` | 0.28.0 | actually installed via install-externals.mjs — same as above |

No @pify/* or un-ported candidates are pinned in devDependencies (tried and removed 2026-09-12 per the user: nothing reads those pins, so bump PRs were meaningless; ported exts are tracked via drift-issue, and undecided candidates get their version re-checked when their eval is revisited per the skill).

## Rules

1. New port → add the registry row BEFORE the code merges to main (the ref column = the actual release/tarball read).
2. When an `[upstream-sync]` issue (from the upstream-drift workflow) appears → run the sync mode in the `pi-ext-eval` skill; record the conclusion (what diffed / port or drop) in `ext-eval-index.md`; update the "last check" column + the ref in the endpoint → the issue auto-closes on the next workflow run.
3. Periodic scans (landscape) sweep for new repos / new packages — they do not replace drift-issue for repos that already have an endpoint.
4. "Own design" rows are still recorded — so that later we can tell what has an upstream and what does not.
5. devDependencies keep only the 2 actually-installed externals (witness-deps above); the automated signal for ported exts is an upstream-drift issue, not a dependabot PR.
6. The `.github/workflows/upstream-drift.yml` workflow (weekly + manual) reads the endpoint column and compares the ported ref against npm `/latest` + the GitHub HEAD; on drift it opens/updates an issue labeled `upstream-sync` (title `[upstream-sync] <name>`, NO version embedded so it dedupes); once drift is resolved it auto-closes. Sync work driven by these issues uses mode 3 of the `pi-ext-eval` skill.
