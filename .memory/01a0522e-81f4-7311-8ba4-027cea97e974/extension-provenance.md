---
id: extension-provenance
title: Extension provenance, upstream repos, role pins, and scope-audit findings
summary: Per-extension fork attribution, upstream repos for pi-subagents vs interactive-subagents, full 14-component scope-audit, port decisions, visual-tools/researcher/web-fetch collision findings, model audit verdict, and vision model recommendations.
updated: 2026-08-30 15:36
---

## Extension provenance headers (grep summary)

| Extension | Provenance | Notes |
|---|---|---|
| `ask-user-question` | RPC-compatible fork of `amosblomqvist/pi-config` extension | Deliberate differences from upstream; clean fork |
| `quiz` | RPC-compatible fork of `amosblomqvist/learn` quiz extension | Same grading semantics; clean fork |
| `snip` | RPC-compatible port of `amosblomqvist/pi-config` prompt-snippets | Single index.ts, 25/25 unit tests |
| `subagent-types` | Fusion port: `pi-subagents` (spawn base) + `learn` repo pieces (mermaid-maker, svg-maker, learn-researcher roles, visual-tools, visualize skill, quiz, md-log) + self-designed channel code with no upstream reference | Scope-confusion case; 2-way channel is a port invention, not from upstream `pi-subagents` |
| `web-fetch` | Imports from `@mariozechner/pi-coding-agent`; near-verbatim copy of upstream pi-config web-fetch | Requires `npm install`; lives only in `.pi/extensions/` (no dev twin in `extensions/`) |
| `md-log` | Modeled-on rewrite of the `.md-link` extension (header note cites amosblomqvist/learn extensions/md-log.ts as immediate parent) | `.md-link` no longer exists upstream; mild lineage risk; needs a "rewrite, no upstream" header note; lives only in `.pi/extensions/` (no dev twin) |
| `visual-tools` | Custom for the Obsidian/teach pipeline (no lineage marker) | Pair with `visualize` skill; stale host header pointing at interactive-subagents; lives only in `.pi/extensions/` (no dev twin) |
| `observational-memory` | Near-verbatim port per `HANDOFF-observational-memory.md` | Only deviation is `/om:status` text replacement; INDEX.md nesting bug FIXED end-to-end |

## Skill provenance

| Skill | Provenance | Notes |
|---|---|---|
| `analyze-sessions` | Rebuilt for Paseo (`paseo_*.py` scripts) | Old native-pi scripts kept as leftovers inside `skills/analyze-sessions/disabled-pi-scripts/` |
| `pdf-reader` | Clean upstream copy | Requires python3 venv at `~/.pi/agent/skills/pdf-reader/.venv` with `requirements.txt` installed |
| `youtube-transcript` | Clean upstream copy | Requires `yt-dlp` and `ffmpeg` system tools (config `--js-runtimes node` now in `/home/coder/.config/yt-dlp/config`) |
| `teach` | Custom based on user's personally verified principles | Goal: understanding/compression into a dependency graph; aim for the "click" |
| `visualize` | Custom pairing with `visual-tools` extension | Spawns a maker subagent that renders and vision-verifies a correct minimal visual |

Deprecated/ in the upstream `pi-config` repo holds extensions and skills no longer in active use.

## pi-config repo layout (from upstream GitHub fetch)

`https://github.com/amosblomqvist/pi-config` lists separate repos:
- `pi-interactive-subagents`
- `pi-observational-memory`
- `pi-dictate`
- `learn` (user's AI learning system)

Extensions in pi-config: `ask-user-question`, `bash-guard`, `browser`, `custom-header`, `interactive-subagents` stub, `observational-memory` stub, `prompt-snippets`, `web-fetch`, `web-search`.

Skills in pi-config: `analyze-sessions`, `pdf-reader`, `web-debug`, `youtube-transcript`.

## Amo's 6 repos (verified via GitHub API)

- `learn` — "My AI learning system"
- `pi-config` — "My personal pi config"
- `pi-dictate` — "Dictation extension for pi"
- `pi-interactive-subagents` — "Interactive subagents running in tmux panes"
- `pi-observational-memory` — "Memory system for pi"
- `pi-subagents` — "Simple subagents for pi"

All 6 repos are cloned at depth-1 under `/tmp/ext-audit-2` for inspection.

## learn repo mapping (where this workspace's pieces originated)

`learn/extensions/` contains: `ask-user-question.ts`, `md-log.ts`, `quiz.ts`, `visual-tools/`.
`learn/agents/` contains: `mermaid-maker.md`, `svg-maker.md`, `researcher.md`.
`learn/skills/` contains: `visualize`.

The workspace `learn-researcher.md` is a verbatim copy of `learn/agents/researcher.md` (renamed to avoid collision with `pi-subagents`'s `researcher`), with `model` remapped to `cli-openai/zaicp/glm-5.3-flash`, `thinking` set to `high`, and the same `safe_bash` + system-prompt append + `auto-exit: true` flags.

## Upstream pi-subagents architecture (verified via GitHub fetch)

`github.com/amosblomqvist/pi-subagents` — has NO 2-way channel.

- **Single tool** (`subagent`) with three registered agents:
  - `scout` — tools `read`/`grep`/`find`/`ls`, model `claude-haiku-4-5`, role: fast codebase recon.
  - `researcher` — tools `web_search`/`web_fetch`, model `claude-sonnet-4-6`, role: web research.
  - `worker` — tools `read`/`write`/`edit`/`safe_bash`/`web_search`/`web_fetch`/`subagent`, model `claude-sonnet-4-6`, role: code changes. Restricted via `subagent_agents` frontmatter to spawn only `scout`/`researcher`. Depth capped at 2.
- **Per-process semaphore** `maxConcurrency` (default 4) caps simultaneous subagents.
- `safe_bash` ships in the upstream repo at `tools/safe-bash.ts`.
- `web_search` + `web_fetch` come from `amosblomqvist/pi-config`.
- **Frontmatter fields**: `name`, `description`, `tools`, `model`, `thinking` (off/low/medium/high, default medium). `subagent_agents` enforced via `PI_SUBAGENT_ALLOWED` env on the child.
- **Global bridge** `globalThis.__pi_subagents` for extensions to register/unregister agents at runtime. Justification: `jiti` creates separate module instances, so direct imports won't reference the same `agents` array.
- **Communication model**: each subagent runs as an isolated pi process. One tool call = one subagent. Result returns as tool result when done (text only, no file handoff, no notification).

## Upstream pi-interactive-subagents — the real 2-way source

`amosblomqvist/pi-interactive-subagents` README (verified from `/tmp/ext-audit-2`):

- Sub-agents run async in **tmux panes** (tmux-only fork of upstream `HazAT/pi-interactive-subagents`, supporting cmux/zellij/WezTerm).
- `subagent()` returns immediately; results steered back as notification triggering new turn.
- Tools exposed:
  - `subagent` — spawn a sub-agent by name.
  - `subagent_message` — address sub-agent by name; if pane is live, message is typed in and picked up at next turn boundary; if session has finished, the message resumes that session.
  - `subagents_list` — enumerate live sub-agents.
  - `ask_question` — only usable from sub-agent sessions; parks the child as `waiting`; the parent replies via `subagent_message`; reply is absorbed into the current turn if mid-turn.
- Every spawn records the name to artifact `subagent-registry.json`, persisting across restarts.
- Resume replays the sandbox from `<session>.loadout.json` snapshot.
- Bundled agents: `scout` (`openrouter/z-ai/glm-5.3`, tools `read`/`grep`/`find`/`ls`) and `researcher` (`openrouter/z-ai/glm-5.3`, tools `web_search`/`web_fetch`/`safe_bash`) — matches the learn-researcher origin.

**Convergence with Paseo fix design**: the main-to-child pickup semantics ("picked up at next turn boundary, not interrupt-and-replace") match the assistant's proposed 3-event drain (`turn_end` + `before_agent_start` + `agent_settled`) — validates the fix direction toward interactive-subagents philosophy on Paseo infrastructure.

**User statement (11:41)**: "mình port nhầm từ interactive-subagents rồi, bản mình muốn port phải là interactive-subagents" — "I ported from the wrong source; the version I wanted to port should have been interactive-subagents." User's framing: the port should target the interactive-subagents philosophy, but adapted for Paseo infrastructure (not a wholesale tmux-pane port, since tmux children would not be Paseo agents).

**Port recommendation**: do NOT port `interactive-subagents` wholesale (its tmux-pane core is TUI-centric). Instead port its **semantics** — `ask_question` parking, name registry, resume-by-name, turn-boundary pickup — onto existing Paseo infra, matching the user's principle of porting for Paseo not preserving original design.

## Author videos

- Simple Pi Subagents — YouTube `KRVYUkM16hE`.
- Pi to Pi: Two-Way Agent Orchestration with the Pi Coding Agent — YouTube `PIdETjcXNIk`.
- Author X post: "subagent interactivity two ways — between me and subagents, and between orchestrator and subagents."

## 14-component scope audit (completed)

User requested audit of all 14 workspace components for out-of-scope ports. Findings:

**Clean (deliberate forks / upstream copies):**
- `ask-user-question`, `quiz`, `snip` — clean documented forks with deliberate differences.
- `observational-memory` — near-verbatim port per HANDOFF.
- `pdf-reader`, `youtube-transcript` — clean upstream copies.

**Custom by design:**
- `teach` — based on user's personally verified teaching principles.
- `visualize` — custom pairing with `visual-tools`.

**Analyzed-but-different:**
- `md-log` — modeled-on rewrite with no upstream to track fixes against (`md-link` no longer exists upstream); mild lineage risk; needs a "rewrite, no upstream" header note.
- `visual-tools` — no lineage marker; custom for the Obsidian/teach pipeline; STALE HOST (see below).
- `web-fetch` — near-verbatim copy of upstream pi-config web-fetch; NO NAME COLLISION with pi built-in (verified: grep of `pi-coding-agent/dist` returns zero hits for `web_fetch`).

**Rebuilt for Paseo:**
- `analyze-sessions` — deliberately rebuilt for Paseo (`paseo_*.py`); old native-pi scripts kept as leftovers inside `skills/analyze-sessions/disabled-pi-scripts/`.

**Scope-confusion case:**
- `subagent-types` — the 2-way channel design has no upstream reference.

## Three new audit findings beyond known subagent-types scope

1. **`visual-tools` stale host**: documented host is `interactive-subagents` extension (tmux-based, via `globalThis.__pi_interactive_subagents.registerToolExtension`), but the workspace actually loads `subagent-types` (ported from `pi-subagents`). The bridge silently no-ops via `if (!api?.registerToolExtension) return` guard on line 53. The `web-fetch/index.ts:548` file (different extension) registers `pi.registerTool` with name `web_fetch`, label `Web Fetch`, description about Readability + Turndown HTML to markdown; handles PDFs, plain text, falls back to Jina Reader for JS-rendered pages; no `ui.*` RPC-unsafe usage found.

2. **Duplicate `researcher` / `learn-researcher` roles**: diff shows both are "Web researcher — searches the web and synthesizes findings" with same description, same model `cli-openai/zaicp/glm-5.3-flash`, same thinking `high`. `learn-researcher` adds `safe_bash` to tools, sets `system-prompt: append` and `auto-exit: true`, with a short body versus researcher's long 40-plus-line body. Confirmed near-duplicate role functionality.

3. **`web-fetch` name collision (initially flagged, later corrected)**: the extension registers a tool literally named `web_fetch`. Initially described as shadowing pi's built-in `web_fetch`. **Corrected**: pi has no built-in `web_fetch` (grep of `pi-coding-agent` dist returns zero hits). The actual conflict is functional overlap with `fetch_content` from the `pi-web-access` npm package.

## Tool-level overlaps (resolved)

- `web_fetch` (self-dev extension copied from `amosblomqvist/pi-config`) vs `fetch_content` (`pi-web-access` package): both convert URL to markdown; `pi-web-access` exposes raw/answer modes. No actual name collision (only one `web_fetch` exists).
- `quiz` vs `ask_user_question`: functional cousins already cross-contaminated by known Paseo bug #3 (title-heuristic placeholder).
- `researcher` vs `learn-researcher`: near-duplicate roles, merged (see below).

## User-driven port decisions

- **Researcher merge (11:41, verbatim Vietnamese)**: "bỏ cái thừa đi, để tên researcher và có safe_bash là xong" — "drop the redundant one, keep the name `researcher` with `safe_bash`, done." Merged `agents/researcher.md` = name `researcher` + tools `web_search`/`web_fetch`/`safe_bash` + system-prompt append + `auto-exit: true` + keep the current rich body. `learn-researcher.md` is deleted.
- **Port scope (11:41)**: port is for use with Paseo, NOT to reproduce the extension's original design faithfully; user reminded twice to consult the build session transcripts proactively (files live in `~/.pi/agent/sessions/`).
- **Web-fetch evaluation (11:41)**: user asked to evaluate the two web-fetch implementations comparing ease of use and resource consumption. Resolution: keep the self-dev `web_fetch` extension (full Readability/Turndown pipeline) and the `pi-web-access` package as complementary (latter provides `fetch_content` raw/answer modes and `source_check`/`get_search_content` for search-backed answers).
- **md-log header note (11:33)**: add a "rewrite, no upstream" header note to `md-log`.
- **Phase 2 deferred frontmatter (11:58)**: drop dead frontmatter fields `system-prompt: append` and `auto-exit: true` from roles (subagent-types does not implement them yet) — marked as Phase 2.

## Session ledger archaeology

Grep of `test-log.md` for `interactive` / `tmux` / `2-way-chiều` / `message_main` / `steer` returned empty — design discussions live in the build session transcripts at `~/.pi/agent/sessions/--home-coder-workspaces-learn--/`, not in `test-log.md`.

Design vocabulary ("Urgency over continuity", "2-way channel", "interactive-subagents", "tmux", "message_main", "steer") appeared only in code comments; the design discussion itself only appears in build session `2026-08-30T00-06-06-262Z_01a04ffc-dab6-72fc-8dfa-2f0574c97f7e.jsonl` and the assistant's own test session `00-06-08:40`. Channel test sessions (08-12-16, 10-19, 10-59) tested `message_main` via `subagent_message` but did NOT discuss the design.

Build session `00:06-06` excerpts:
- Early system prompt: assistant is a "pure high-level orchestrator session that must outsource mechanical work to subagents and keep context lean; ask questions until 100% sure; do not act until user confirms shared understanding; verify rather than guess."
- 05:32: user asked to list tool names and confirm presence of `bash`/`write`/`quiz`/`spawn_subagent`/`safe_bash`.
- 05:36: user asked to call subagent `glm-5.3-flash` to test (model has vision).

Assistant's main test session `00-06-08:40`: user (Vietnamese) discussed updating passed tests, said `web-debug` extension was deleted and to remove it, and that `web_fetch`/`websearch` issues would be handled later.

Conclusion: the subagent-types channel was designed from scratch in the port session with no upstream reference; the "design agreed with the user" comment refers to that port-session user, not an upstream design.

## Role pins for `subagent-types/agents/*.md` (this workspace)

5 roles exist in this project (after merge); upstream `pi-subagents` has only 3 — two extra were added during the port (`mermaid-maker`, `svg-maker`).

| Role | Model | Thinking | Tools | Notes |
|---|---|---|---|---|
| `scout` | `cli-openai/mmcp/MiniMax-M3` | high | (read/grep/find/ls) | upgraded from upstream's haiku; **RECOMMENDED SWITCH to `cli-openai/zaicp/glm-5.3-flash`** (clean format, same `[V]` vision, cheaper) due to MiniMax-M3 think-leak format bug |
| `researcher` (merged) | `cli-openai/zaicp/glm-5.3-flash` | high | `web_search`/`web_fetch`/`safe_bash`, system-prompt append, `auto-exit: true` | was `learn-researcher`; merged with researcher's rich body |
| ~~`learn-researcher`~~ | — | — | — | DELETED per user merge directive; file `agents/learn-researcher.md` removed from both dev and live trees |
| `mermaid-maker` | `cli-openai/zaicp/glm-5.3-flash` | max | `write_mermaid`/`edit_mermaid`/`render_mermaid`/`read` | NEW (from learn repo) |
| `svg-maker` | `cli-openai/zaicp/glm-5.3-flash` | max | (write/edit/read/render_svg) | NEW (from learn repo) |
| `worker` | `cli-openai/zaicp/glm-5.3-flash` | — | (read/write/edit/safe_bash + subagent-tools) | upstream's worker |

After merge: `index.test.ts` updated to `role inventory (5 roles)` / `all five roles load`; `index.ts:277` `spawn_subagent` description updated to five roles (scout, researcher, worker, mermaid-maker, svg-maker). Final test count: 52 pass / 0 fail across 2 files.

## Model audit verdict (151 session files, 14:00)

Worker `3108961a-a28d-4edf-97e7-35ebc690613c` named `model-audit` running the `analyze-sessions` skill returned:

| Model | Calls | Errors | Verdict |
|---|---|---|---|
| `glm-5.3` | 437 | 8 (mostly intentional STOP/PoC) | BEST — excellent thinking, diagnosed root causes; main agent |
| `glm-5.3-flash` | — | 4 (recovers cleanly) | Good but wanders when ambiguous; cheap; HAS vision; recommended scout replacement |
| `MiniMax-M3` | — | 0 API errors, 0 aborts | Stable API but **FORMAT BUG** — leaks raw `'thinking'` into the text channel ~80% of calls causing Paseo double-parse garbage (the "not stable" symptom the user saw); matches stray fragments like text block `151c7540` ending with `'contents.'` |
| `deepseek-v4-flash` | — | 4+5 (self-recovers) | Reliable budget worker; good for cheap observer/probe roles |
| `glm-5.2` | — | — | Idle today, no fresh evidence |

**Audit conclusion**: MiniMax-M3 instability is an output-format defect, not API instability. Recommendation: switch scout role model from `MiniMax-M3` to `glm-5.3-flash` (clean format + same `[V]` + cheaper). One-line change in `scout.md` awaiting user approval.

## Vision model tags (verified via `paseo_list_models provider='pi'`)

- `glm-5.3` (main) — `[T][XL]`, NO `[V]` (no vision)
- `glm-5.3-flash` — `[T][V][XL]` (vision capable)
- `MiniMax-M3` — `[T][V][L]` (vision capable)
- `deepseek-v4-flash` — `[T]`, no `[V]`
- `glm-5.2` — `[T]`, no `[V]`

Main model `glm-5.3` cannot receive images via this provider; any vision task must delegate to a vision-capable subagent (typically `glm-5.3-flash`). The recommendation to switch scout from `MiniMax-M3` to `glm-5.3-flash` is NOT a vision issue (both have `[V]`) — it's the think-leak format defect.

## Diagnosis scout IDs (for record)

- `f5971b2f-52c2-478a-8c51-a22a5375feb9` — named "Diagnose message_main queue flush", READ-ONLY investigation of `subagent-types` extension.
- `c3c263a0-de60-4410-bd68-be0e555fcb51` — vision verification of the bug-vs-fix Mermaid diagram (assistant model has no direct vision; scout ran on `glm-5.3-flash` with vision enabled).
- `3ef0e69e-debe-4808-8eb7-7bc3de51165f` — Phase 1 E2E scout ("Queue E2E child-side") that pushed `QUEUE-E2E-CHANTEST` to main; message drained at 12:35 after Paseo restart.
- `906c451c-4785-40a7-bfa7-49ad12870de6` — Phase 2 asker scout for the `PINEAPPLE-42` round-trip via `ask_question`.
- `345f36ad-7477-46ba-96b4-5c55cfa7725f` — Phase 2 registry E2E scout (`name="registry-check"`) that pushed `REG-E2E-OK` and verified resume-by-name.
- `5cd46180-4927-4087-8371-1e3db85a8b0b` — `asker-park` scout for park-timeout PoC (`MANGO-77`).
- `151c7540-793c-4a8b-9a0d-f63202216ab3` — `slow-counter` scout (interrupt PoC; finished too fast to interrupt).
- `9ab5f31f-abb6-4ed6-8d3d-ea52b8b7da16` — `sleeper` worker for interrupt PoC (`INTERRUPTED-OK`); in-flight `sleep 90` aborted mid-turn, replacement prompt ran.
- `b95b0d16-9c18-4ac3-8848-d88fe7bc16b3` — depth-2 worker that spawned `d2-scout` (`a20980ef-7471-4f78-bb1f-c105e0166105`).
- `a20980ef-7471-4f78-bb1f-c105e0166105` — `d2-scout` (depth-2 child); read `/tmp/gap-test/case.txt` and reported the two lines verbatim.
- `3108961a-a28d-4edf-97e7-35ebc690613c` — `model-audit` worker (analyze-sessions skill); 151 session files analyzed; verdict: glm-5.3 best, MiniMax-M3 think-leak.
- `fa19ce57-1733-425d-85a9-67008064ec67` — `scan-vision` scout; ran MiniMax-M3 (override ignored); transcribed fake invoice PNG.
- `6aab2ec6-0264-4b0b-bf4e-08b0324f54ea` — `guided-choice-test` worker; replied `GUIDED-OK` (guided-choice path unreachable-by-design).

All PoC agents archived via `paseo_archive_agent` (24 of 24 test/probe agents at 13:14; PoC trio at 13:22; depth-2 pair at 13:44; `model-audit`+`scan-vision`+`guided-choice-test` at 14:01; re-archive of `scan-vision` at 14:06 because the first returned success but record still showed `archivedAt null`).

## Two-tier extension layout (extensions/README.md, 1934 bytes)

Documented at 13:22:
- **Tier 1** (dev copies in `extensions/`, synced to `.pi/extensions/` via `cp` after `bun test`): `subagent-types`, `snip`, `quiz`, `ask-user-question`, `observational-memory`.
- **Tier 2** (live-only packages at `.pi/extensions/`, edited in place; no dev copy because each carries its own `node_modules`, `package.json`, and lockfile): `visual-tools` (depends on `@mermaid-js/mermaid-cli` which pulls `aws-sdk`), `web-fetch` (depends on `readability`/`linkedom`/`turndown`), `md-log` (standalone dependency-free file).
- Every extension traces to an upstream repo; none "born from thin air". Origin is noted in each file's header comment.

## Session ledger path

`~/.pi/agent/sessions/--home-coder-workspaces-learn--/2026-08-30T10-19-34-772Z_01a0522e-81f4-7311-8ba4-027cea97e974.jsonl`. Session `01a0522e` started `2026-08-30T10:19:34.772Z` in cwd `/home/coder/workspaces/learn`, model `zaicp/glm-5.3` via `cli-openai`, thinking level high.
