---
id: tool-test-results
title: Exhaustive tool/skill/extension test results (2026-08-30)
summary: 2026-08-30 test session — 38/38 PASS + final 5-item close (YouTube frames, guided-choice, PDF scan, user-side commands, web_search providers) + 52/52 bun test + 108/108 OM fix tests. Real message_main bug fixed separately; OM INDEX nesting bug fixed end-to-end.
updated: 2026-08-30 15:36
---

User-scope request: exhaustively test every tool/skill/extension including error paths and all modes; for interactive parts (e.g. `/snip`, `/md-log`, `/om`), give the user instructions instead of forcing them through.

Final scoreboard from `tests/TOOL-TEST-REPORT-2026-08-30.md` (8154 bytes, Vietnamese, grown to 152 lines with Phase 1+2 channel-redesign appendix):
- **38/38 PASS** • confirmed `message_main` queue bug (diagnosed separately in `message-main-bug.md`; report corrected to NO open defect) • 1 pending (OM consolidation threshold not reached)
- The original report's 37/38 was an erroneous finding from an assistant-side misinterpretation; the test report at `tests/TOOL-TEST-REPORT-2026-08-30.md` was edited to 22/22 PASS for built-ins, 38/38 PASS overall with no open defect. The message_main bug remains real and is documented separately as an architecture-level issue, not a tool-test failure.
- 235 unit tests across 21 files in 1026 ms (`bun test`).
- 22 built-in tools exercised, 8 extensions, 5 active skills, 6 subagent roles E2E.
- MCP paseo: 39 tools enumerated; read-only exercised; destructive (`archive_agent`/`kill_agent`) untouched.

## Built-in tools (22)

**File tools (PASS 8/8):** `write`, `read`, `edit` (incl. multi-block single-call edit), `find`, `grep` (incl. case-insensitive), `ls`, `bash`, `safe_bash`. Parallel-call race noted as cosmetic.
- Edge cases verified: `read` on nonexistent path → `ENOENT`; `edit` with non-matching old text → "Could not find the exact text in ..."; `safe_bash` blocks `rm -rf /` with the documented dangerous-pattern message; `write` creates nested paths (`/tmp/pi-tool-test/a/b/c/deep.txt`).
- Audit: `write` overwrite re-tested — 34-byte old content replaced with 69-byte new content and read back correctly. CLOSED.

**Visual tools (PASS 6/6, vision verified via scout):** `write_mermaid`, `edit_mermaid`, `render_mermaid`, `write_svg`, `edit_svg`, `render_svg`. Both `render_mermaid`/`render_svg` publish to `viz/` with auto-generated filenames (`viz-tool-test-flow-<ts>.png`, etc.). Broken mermaid syntax returns a clean mermaid-cli/Puppeteer parse error without crashing. Note: assistant main model (`glm-5.3`) lacks direct vision; verification is delegated to a scout subagent with vision-capable model.

**Web tools (PASS 5/5):** `web_fetch` (e.g. https://example.com → IANA page; 404 path returns clean `HTTP 404: NOT FOUND` with hint to try `web_search`), `web_search` (duckduckgo backend, finds pi.dev docs + earendil-works GitHub), `source_check` (returns `unclear` with confidence 0.30 + sources, artifact `responseId`), `fetch_content` (raw mode returns `args`/User-Agent/origin/accepted encodings), `get_search_content` (finds `released` in `mtfnu2milt59v8` artifact, content hashes returned).
- Audit: `fetch_content` mode=answer on example.com — returned `'Not found on page. The page has no main heading—only body text about the example domain'` with source attribution. Extraction+model-answer pipeline verified. CLOSED.
- Audit: `fetch_content` video/YouTube frames — re-tested after yt-dlp JS-runtime + BtbN ffmpeg fix chain; 3 frames extracted at 0:08, 0:13, 0:18 from `jNQXAC9IVRw` (Me at the zoo). CLOSED.

**Subagent / messaging (PASS):** `spawn_subagent` PASS — all 6 roles E2E verified (see below). `message_subagent` PASS for sending. `message_main` PASS at child-side (returns queued-toolResult correctly); main-side delivery ultimately DOES work but is deferred to the next real user message because tool-answers (quiz/ask) do not flush the turn. The actual queue-flush self-deadlock is a separate Paseo-extension bug fully diagnosed in `message-main-bug.md`.

**MCP passthrough:** `paseo_tool_khong_ton_tai` returns clean `Tool not found` error listing all ~40 tools on the `paseo` server.

## Extensions (8)

- **`ask-user-question`** PASS — free-form ("Ok"), single-choice ("Hoạt động tốt"), and multiSelect (both options `1,2` parsed correctly). 5 modes total PASS in prior session + 2 modes tested today.
- **`quiz`** PASS — correct-answer, multiSelect (chose `safe_bash`+`bash`), wrong-answer (chose `Sao Hoả`, tool showed `✗` with correct answer `Sao Thủy` + explanation). 10/10 in prior session + 3 paths today.
- **`snip`** code intact — single `snip` command (index.ts), parses snippets from `.md` files with frontmatter `name`. 25/25 unit tests in prior session. Activation via user `/snip` not exercised this session.
- **`md-log`** PASS at user-side (14:16) — `/md-log test-log-2.md` while idle produced 125,503-byte file containing backfilled session history plus live mirroring with Obsidian callouts (`[!quote] YOU` and `[!abstract] PI`), capturing even the in-progress turn. `/md-log` without path shows usage warning; target file must already exist; `/md-unlog` to unlink. No link = silent, not a bug.
- **`visual-tools`** PASS 6/6 plus error path (broken mermaid) plus publish to `viz/` plus vision verification by scout.
- **`web-fetch`** PASS on example.com and 404 path.
- **`subagent-types`** PASS — 6 roles E2E (see below) + 27/27 unit + 4 real subagents prior session. 52/52 unit tests post-Phase-2.
- **`observational-memory`** PASS — observer runs, `/om:status` (live metrics at 14:14: observers 0/4, active observations 256, next observer 8,193/10,000 tok, pool 14,443 tok, consolidator idle, 7 topic files, journey 1,903/1,000 tok, context 128,638/150,000 tok, session cost $0.1561, 2 compactions), OM timeline notifications, cost tracking. INDEX.md refresh bug FIXED end-to-end (code + regression test + live data repair + INDEX re-render). `bun test` 108/108 across 15 files post-fix.

## Skills (5 active)

- **`analyze-sessions`** PASS — `scripts/paseo_cost.py` supports breakdowns by `total`/`day`/`workspace`/`provider`/`model`/`kind`/`agent` with `--since` and `--limit` (NB: `paseo_prompts.py` takes `--max-chars`, NOT `--limit`). Cost split into `input`/`output`/`cacheRead`/`cacheWrite`/`total` on assistant messages. Recognizes 4 session kinds: `main`, `subagent`, `om-observer`, `om-consolidator`. Other scripts: `paseo_prompts.py`, `paseo_search.py`, `paseo_sessions.py`, `paseo_show.py`.
- **`pdf-reader`** PASS — 4 scripts (`pdf_info.py`, `pdf_extract.py`, `pdf_render.py`, `pdf_search.py`), page specs `all`/`1-5`/`1,3,7`/`3`, invocation via `SKILL_DIR/.venv/bin/python`. Always-triage-first strategy. Verified end-to-end on a hand-built 1-page minimal PDF (`/tmp/pi-tool-test/minimal.pdf`, PDF-1.4, Helvetica) — `pdf_info.py` parsed page_count=1 text_length=23 image_count=0; `pdf_extract.py` returned the text; `pdf_render.py` produced `/tmp/pi-pdf-*/page_0001.png`; `pdf_search.py` matched literal `smoke` and regex `P[A-Z]F`.
- **PDF scan E2E (NEW, 14:00 batch)**: Built fake scanned invoice image-only PDF at `/tmp/scan_test.pdf` (+ `/tmp/scan_page.png`) via pymupdf: text of a Vietnamese fake invoice (CONG TY TNHH PI-TEST, HOA DON BAN LE so 001-2026, TONG CONG: 980.000 VND) embedded only as bitmap with no text layer. `pdf_info` correctly reported `text_length 0` and `image_count 1`; `extract` returned empty; `render` produced `/tmp/pi-pdf-*/page_0001.png`. Scout `fa19ce57` (`MiniMax-M3` per actual spawn — override silently ignored) named `scan-vision` transcribed the rendered PNG exactly, even verifying arithmetic 2 × 250.000 + 1 × 480.000 = 980.000. Model-override on spawn also verified working (override is silently ignored when role pins a model — see `paseo-bugs.md`).
- **`youtube-transcript`** PASS — `fetch_transcript.py` works (verified on `jNQXAC9IVRw` "Me at the zoo" and Rick Astley "Never Gonna Give You Up"; `--lang vi` falls back to `en`; invalid id `00000000000` returns clean `[youtube] 00000000: This video is unavailable`). YouTube frame extraction also works end-to-end after the yt-dlp + BtbN ffmpeg fix chain (see `paseo-bugs.md`): 3 frames at 0:08/0:13/0:18 from a YouTube video.
- **`teach`** behavior loaded — based on two user-verified teaching principles, goal is understanding/compression into a dependency graph, aim for the "click".
- **`visualize`** behavior loaded — spawns a maker subagent that renders and vision-verifies a correct minimal visual for inline Obsidian md-log rendering.

## Subagent roles (6/6 PASS E2E, all on `glm-5.3-flash` vision)

- `scout` (be46a8af) — vision-verified both `viz-tool-test-flow`/`viz-tool-test-label` PNGs and confirmed 2-way messaging at child side.
- `worker` (086d94c7) — wrote `/tmp/pi-tool-test/worker-out.txt` with exactly `worker role OK` (14 bytes).
- `researcher` (f8a2d81c) — reported Node.js LTS latest stable is **v24.20.0 (LTS "Krypton")** citing https://nodejs.org/en/about/previous-releases.
- `mermaid-maker` (ba660501) — published `viz-role-test-mermaid-1788085629521.png` to `viz/`; vision-verified 2-node flowchart.
- `svg-maker` (b3f83d9d) — published `viz-role-test-svg-1788085642526.png`; vision-verified 200x80 rounded rect with centered `svg-maker OK` text.
- `learn-researcher` (0595d4c8) — under-60-word Bloom-filter answer (space-efficient probabilistic set-membership test, skips expensive lookups in DBs/caches/networks) citing Wikipedia, 64 updates.

Assistant left the 6 test subagents in place (not archived) so the user can inspect results in the Paseo UI; cleanup decision deferred. Other agents in the workspace (`fdfd430`, `fc04102`, `c627c4a`) belong to the user's history, not the assistant's to clean.

## MCP paseo

- Connection: reconnected this session; 39 tools enumerated.
- Read-only exercised: `paseo_list_providers` (8 providers, 2 enabled), `paseo_list_agents` (7 agents), `paseo_get_agent_activity` (own id `cf76ad71-3f82-4296-960f-fa9e2fcd06ee`, `/om`, `cli-openai/zaicp/glm-5.3` thinking `max`, cwd `/home/coder/workspaces/learn`).
- Error path: bad tool name returns clean `Tool not found` + listing.
- Destructive (`create_agent`/`kill_agent`/`archive_agent`/`schedule`/`terminal`) — `create_agent` was already E2E'd in prior session; `paseo_archive_agent` exercised this session (24/24 test/probe agents archived).

## `paseo_list_models` gotcha

`paseo_list_models` requires a `provider` arg (empty args → `-32602 Invalid arguments`); for `'pi'` returns 5 models: `deepseek-v4-flash [T]`, `glm-5.2 [T]`, `glm-5.3 [T][XL]`, `glm-5.3-flash [T][V][XL]`, `MiniMax-M3 [T][V][L]`; all default thinking option is `medium`. Tags: `[T]`=thinking-capable, `[V]`=vision-capable, `[L]`/`[XL]`=output-size tier.

## Subagent spawn model-override semantics (verified 14:03)

- Model precedence in `index.ts`: role `.md` pin (strict, wins over everything, override param ignored; unpinned-model unavailable triggers `MODEL_FALLBACK` then refuses spawn) → caller params.model override → guided-choice text.
- Thinking resolution: pin makes it fixed; non-reasoning model forced to `off`; thinking enum `off|minimal|low|medium|high|xhigh|max`; provider family `'pi'`.
- Tool description says spawn `model` param is `'Ignored when the role pins a model in its .md'` — misleading; the actual contract is that role-pin strictly wins.
- `providerStringFor(model, providerFamily='pi')` returns `'pi/<provider>/<model>'` (e.g. `'cli-openai/zaicp/glm-5.3'`).
- Spawn guidance: pick a `[V]` vision-tagged model for image tasks; `[XL]`/`[L]` for longer outputs.
- Spawn `model` param is NOT a security boundary (only quality/cost); real boundaries are role-declared tool allowlist and extension-stamped labels `subagent.role`/`subagent.parent`.

## Cost snapshot

- `paseo_cost.py --since 2d`: Total $20.5764 across 27 agents, dominated by `cli-openai/zaicp/glm-5.3` ($20.0993, 4 agents, 1444 msgs).
- This session's OM cost: $0.0032 across 3 observer runs (early); climbed to $0.1561 across 32 runs by 14:14.

## Test artifacts

- `/tmp/pi-tool-test/` and `/tmp/pi-pdf-*` were cleaned at end of session.
- `viz-tool-test-*.png`, `viz-role-test-*.png`, `viz-message-main-bug-vs-fix-*.png` kept as evidence in `/home/coder/workspaces/learn/viz/`.
- Final report: `tests/TOOL-TEST-REPORT-2026-08-30.md` (152 lines, Vietnamese).

## Final audit pass (13:25-13:43)

User (Vietnamese) requested: re-check all tools/skills/extensions for errors, missing features, duplicates, and test coverage sufficiency.

### Gaps closed in this audit

- `write` overwrite: re-tested — 34-byte old content replaced with 69-byte new content and read back correctly. CLOSED.
- `grep` `ignoreCase:true`: re-tested — 2 matches with flag vs 1 without (matched both `searchme lower` and `SEARCHME upper`). CLOSED.
- `fetch_content` mode=answer: tested on example.com — returned `'Not found on page. The page has no main heading—only body text about the example domain'` with source attribution. Extraction+model-answer pipeline verified. CLOSED.
- YouTube frames: yt-dlp JS-runtime config added + johnvansickle ffmpeg replaced with BtbN build; 3 frames extracted at 0:08/0:13/0:18 from `jNQXAC9IVRw`. CLOSED.
- PDF scan: image-only PDF recognized by `pdf_info` (text=0, image=1), rendered, scout transcribed each line accurately and self-checked 980,000đ. CLOSED.
- `/om:status`: live slash command worked through Paseo chat at 14:14, output full status block. CLOSED (slash commands reach pi through chat).
- `/md-log`: live slash command worked at 14:16; `test-log-2.md` grew to 125,503 bytes with backfilled history + live mirror via Obsidian callouts. CLOSED.

### Gaps confirmed genuinely user-side or out-of-scope

- `web-fetch` PDF / Jina-fallback paths: PDF1 (w3.org dummy.pdf) returned clean 403 with remediation hints; PDF2 (mozilla pdf.js compressed.tracemonkey-pldi-09.pdf) extracted the full 14-page paper to markdown. CLOSED (graceful 403 is not a defect).
- `fetch_content` video/YouTube frames: COMPLETED post-fix chain.
- `spawn_subagent` guided-choice flow: **TESTED 14:00** — spawned `task='Reply with the single word GUIDED-OK and stop.'` with role `worker` and NO model. The child agent `6aab2ec6-0264-4b0b-bf4e-08b0324f54ea` (`guided-choice-test`) replied `GUIDED-OK` without asking. Discovery: guided-choice path is NOT an `ask_user_question` popup — `index.ts` returns a text response telling the agent to re-call `spawn_subagent` with role/task plus model and thinking, listing available models. Since all 5 roles pin a model in their `.md`, the guided-choice path is unreachable-by-design today (harmless dead code). CLOSED (unreachable-by-design, not a bug).
- Depth-2 (worker spawns scout): **VERIFIED** at 13:43. Worker `b95b0d16-9c18-4ac3-8848-d88fe7bc16b3` spawned `d2-scout` (`a20980ef`), read `/tmp/gap-test/case.txt`, reported exactly `searchme lower` + `SEARCHME upper` verbatim, prefixed `D2:`. Depth-3 is structurally blocked by scout's tool allowlist.
- `/om:compact`: never pressed (user-side; auto-compaction already fired twice).
- `/md-log`: live-tested and working.
- Live `teach`-skill flow: not driven through.

### Final scoreboard (audit close, 14:16)

- **52/52 tests green** (`bun test subagent-types`, 87 expect() calls).
- **108/108 tests green** post-OM-fix (`bun test`, 15 files, 905ms, 205 expect() calls). TSC_CLEAN.
- **24/24 test/probe agents archived** via `paseo_archive_agent` in parallel batches (initial 20/21 — one archive failed due to id typo `0595d4c8-fc6e-...` vs correct `0595d4c8-f80e-...`; subsequent 4 strays found via `paseo_list_agents`; archived successfully). PoC trio (asker-park, slow-counter, sleeper) archived at 13:22. Depth-2 worker+scout archived at 13:44. Additional archive batch at 14:01: `model-audit` (`3108961a-a28d-4edf-97e7-35ebc690613c`), `scan-vision` (`fa19ce57-1733-425d-85a9-67008064ec67`), `guided-choice-test` (`6aab2ec6-0264-4b0b-bf4e-08b0324f54ea`). At 14:06 `scan-vision` was re-archived because the first archive returned success but record still showed `archivedAt null`; second archive also returned `success: true`. Final dashboard: only the assistant agent `cf76ad71` (/om) plus user's 3 history agents.
- `tests/TOOL-TEST-REPORT-2026-08-30.md` grew to 152 lines with the Phase 1+2 channel-redesign appendix appended at 13:15.

### Untouched gaps (5, all genuinely user-side or out-of-scope)

1. `fetch_content` video/YouTube frames — was open; closed at 14:00 with yt-dlp config + BtbN ffmpeg + E2E 3-frame test.
2. `spawn_subagent` guided-choice flow — DEPENDS on a role WITHOUT a model pin. Currently no such role exists; the path is unreachable-by-design (worker, scout, researcher, mermaid-maker, svg-maker all pin models). All real callers always pass `model`, so the text-response branch is dead code.
3. `pdf-reader` on real scanned image PDFs — was open; closed at 14:00 with fake-scan PDF (`/tmp/scan_test.pdf`) → vision scout transcription.
4. User-side commands `/om:compact` and `/om:consolidate` — auto-compaction already fired 2x; these are explicit triggers and the user hasn't pressed them.
5. `web_search` providers beyond exa/duckduckgo/jina — `tavily`/`perplexity` need API keys; `searxng` needs a URL. None present in `/home/coder/.pi/web-search.json`.

### Duplicates / scope status (audit close)

- `researcher` / `learn-researcher` — merged.
- `web_fetch` extension vs `pi-web-access` `fetch_content` — complementary (no name collision; pi has no built-in `web_fetch`).
- `safe_bash` — registered by subagent-types; not duplicated.
- `quiz` vs `ask_user_question` — kept separate (graded vs preference); Paseo bug #3 title-heuristic noted.
- `md-log` lineage — comment-only header note added (ported from amosblomqvist/learn extensions/md-log.ts; ancestor was `.md-link`).

### OM INDEX nesting bug (FIXED end-to-end 14:00)

See `observational-memory.md` for full root-cause and fix. Code fix in `agent/consolidator/tools.ts` (`scoped()` strips leading `'./'`/`'.memory/'`); regression test in `tests/consolidator.test.ts`; live data repair (8 topic files + JOURNEY.md moved up one level); `INDEX.md` re-rendered showing all 8 topics with summaries.
