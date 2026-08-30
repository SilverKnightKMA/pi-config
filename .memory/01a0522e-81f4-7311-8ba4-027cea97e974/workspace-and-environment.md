---
id: workspace-and-environment
title: Workspace structure and Paseo/pi runtime environment
summary: Layout of .pi/skills and .pi/extensions, dev-copy extensions/ tree vs live-only extensions, settings.json packages, pi-web-access tool lineage, OM fix details (consolidator cwd + scoped() bug), and pi/Paseo runtime versions.
updated: 2026-08-30 15:36
---

## Workspace layout (`/home/coder/workspaces/learn`)

- `.pi/skills/` (active): `analyze-sessions`, `pdf-reader`, `teach`, `visualize`, `youtube-transcript`. `disabled-pi-scripts` is a directory of disabled skills inside `analyze-sessions`.
- `.pi/extensions/`: `snip`, `web-fetch`, `ask-user-question.ts`, `subagent-types`, `observational-memory`, `visual-tools`, `quiz.ts`, `md-log.ts`.
- `extensions/` (project root) — dev copies. **Two-tier layout** (documented in `extensions/README.md`, 1934 bytes, written 13:22):
  - **Tier 1** (dev copies in `extensions/`, synced to `.pi/extensions/` via `cp` after `bun test`): `subagent-types`, `snip`, `quiz`, `ask-user-question`, `observational-memory`.
  - **Tier 2** (live-only packages, edited in place at `.pi/extensions/`): `visual-tools`, `web-fetch`, `md-log`. Each carries its own `node_modules`, `package.json`, and lockfile (where applicable) — duplicating them as dev twins would waste hundreds of MB (`visual-tools` depends on `@mermaid-js/mermaid-cli` which pulls `aws-sdk`; `web-fetch` depends on `readability`/`linkedom`/`turndown`; `md-log.ts` is a standalone dependency-free file). Origin is noted in each file's header comment.
- These dev copies MUST be manually synced to `.pi/extensions/` after editing.
- The project is a port of `amosblomqvist` repos (`pi-config`, `learn`, `pi-subagents`) onto Paseo. Observational-memory was the last open decision before install.
- `tests/TOOL-TEST-REPORT-2026-08-30.md` (152 lines, Vietnamese) is the report from this session's exhaustive test run, with a Phase 1+2 channel-redesign appendix appended.

## Pi / Paseo runtime

- **Paseo daemon 0.6.1** — the assistant must NEVER restart it; doing so kills the running session agent (user reminded 3x). Note: a Paseo restart WAS performed by the user at 12:34 (not by the assistant) to verify that the new file-queue fix survives a daemon restart — it did (queue drained at 12:35 via `before_agent_start`). A second user-initiated restart was at 13:09 to load the on-disk JSON-RPC `id` fix.
- **pi 0.84.4** at `/home/coder/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/`.
- **tmux 3.5a** at `/usr/bin/tmux` — satisfies `interactive-subagents` tmux dependency if ever ported.
- Test runner: `bun test`. Typecheck: `bunx tsc -p tsconfig.json --noEmit` (bare `bunx tsc --noEmit` prints help under tsc 7).
- Pi RPC smoke harness: spawn `pi --mode rpc --extension EXT --no-session` and feed JSONL on stdin; reference implementations in `extensions/ask-user-question/smoke-rpc.ts` and `extensions/observational-memory/smoke-rpc.ts`.
  - **Correct frame format**: the `type` field IS the command name directly (e.g. `type: 'get_commands'`); frames include optional `method` field for sub-protocols; writes `JSON.stringify(frame) + '\n'` to `proc.stdin`; response types are `response` / `extension_ui_request` / `extension_error`.
  - Wrapping frames in `{type:'request', command:'...'}` returns `Unknown command: request`.
  - Using `command: '...'` without the wrapper returns `Unknown command: undefined`.
  - Smoke test waits up to 20s for `get_commands` response; retries probe.
- `web-debug` skill was removed by the user in a prior session.
- `web_search`/`source_check` auto-mode currently routes to duckduckgo because the Exa free quota is exhausted. `fetch_content` readable/answer modes need an extraction API key.

## Subagent-types current state (post-Phase-1+2)

- `paseo-channel.ts` (full rewrite) — file-queue both directions + 3-event drain + Phase 2 registry/`waitForReply`. **dev==live synced**.
- `index.ts` rewrites — `message_main` (file-queue), `message_subagent` (with `interrupt:true` + Phase 2 `name`/`kind`), new `ask_question` (child→main park/wait/absorb), `allowlistFor` includes `ask_question`. **dev==live synced**.
- `agents/` has 5 roles (scout, researcher merged, mermaid-maker, svg-maker, worker); `learn-researcher.md` deleted.
- Tests: `bun test subagent-types` runs 52 tests across 2 files, 0 fail, 87 expect() calls, ~800 ms. TSC CLEAN.

## `~/.pi/agent/settings.json` packages

Installed packages:
- `npm:pi-mcp-adapter@2.11.0`
- `npm:pi-mcp-adapter`
- `npm:pi-web-access`

`pi-web-access` is loaded globally and exposes `web_search`, `fetch_content`, `source_check`, `get_search_content`. `web_fetch` is the self-dev extension (copied from `amosblomqvist/pi-config`). pi has NO builtin web tools — `grep` of `pi-coding-agent` dist returns zero hits for `web_fetch`.

Because `pi-web-access` is global, OM observer sessions and subagents get `web_search` without needing to port the author's web-search extension (e.g. `learn-researcher.md`'s `web_search` is satisfied by the package, not a local extension).

## `/home/coder/.pi/` config files

- `agent/` contains: `auth.json`, `mcp-cache.json`, `models-store.json`, `models.json`, `settings.json`, `trust.json`.
- `web-search.json` contains `exaApiKey` (36 chars), `jinaApiKey` (65 chars), `fetchRouting` (2 providers), `allowRemoteHostedProviders: true`. Earlier "Exa quota exhausted" / "readable needs key" findings were stale — both keys are present and `web_search provider=exa` + `fetch_content mode=readable` worked on re-test (13:19). Only `exa`/`duckduckgo`/`jina` providers are ready; `tavily`/`perplexity` need API keys; `searxng` needs a base URL.
- `config/yt-dlp/config` contains `--js-runtimes node` (one line). Without this, `yt-dlp` fails on YouTube because no JS runtime is found and format list comes back empty. The fix is global; no edit to the npm package.

## System binaries installed in this session

- `~/.local/bin/yt-dlp` (standalone binary version `2026.08.19`) — pip3 install was blocked by PEP 668 (externally managed environment).
- `~/.local/bin/ffmpeg` + `~/.local/bin/ffprobe` (BtbN `FFmpeg-Builds` master build, version `N-126335-gb32f8d1c23-20260830`) — johnvansickle.com static `ffmpeg 7.0.2` segfaulted (exit 139, SIGSEGV) on DASH stream URLs; BtbN build works. A pre-existing dangling symlink for `ffprobe` (pointing at old `video-extract/node_modules/ffprobe-static`) had to be removed before `cp` could write through.

## MCP paseo server

- Starts sessions disconnected (0/1 servers); assistant reconnects it manually.
- Once connected, exposes ~39 tools: `create_agent`, `send_agent_prompt`, `schedules`, `heartbeats`, `terminals`, `workspaces`, `providers`, `models`, `profiles`, `permissions`, `agent`/`activity`/`mode`, plus read-only `paseo_list_*` family and destructive `archive_agent`/`kill_agent` (no delete exists).
- `paseo_list_providers` returns 8 providers: `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp`, `factory-droid`, `gemini`. Only `pi` and `omp` are enabled.
- `omp` provider has 3 approval modes: `full` (yolo, unattended), `write` (writes need approval), `ask` (always ask). `pi` provider has no modes.

## Port conventions applied to all 10 ported extensions

Per `HANDOFF-observational-memory.md`:
1. Keep original logic; only the UI layer is rewritten to be RPC-safe.
2. Use `pi.sendMessage` for in-turn feedback — `notify()` is dropped mid-turn.
3. No side-channel file reads.
4. Descriptions without explanation.
5. Extension fills every payload field; the agent only sends.
6. Pin live tool names — re-register from the SDK factory for `read`/`bash`/`edit`/`write`.
7. Required test workflow per extension: unit → RPC smoke → E2E via `paseo agent run`.
8. Kill the old `pi` process before testing a new extension.

## Subagent role conventions

- `subagent-types` loads roles from `agents/*.md` frontmatter; synthesizes a `main` role; pins `anthropic/claude-*` models (author's documented choice).
- **5 roles** currently exist (3 from upstream `pi-subagents`, 2 new from `learn` repo, with `researcher`/`learn-researcher` merged into one).
- Session labels: `subagent.role=<role>` and `subagent.parent=<agentId>` keep spawned test subagents categorized in the agent list. Both labels tested individually as HTTP-200 (not the cause of the JSON-RPC id bug).
- Allowlist helper at `index.ts:148`: `allowlistFor(def)` returns `[...def.tools.map(mapToolName), 'message_main', 'message_subagent', 'ask_question']`. Line 121 (floor) also auto-adds `message_main` and `message_subagent` for roles with no defined `tools` array. Main role returns `['*']` and needs no `.md` file.
- No role `.md` lists `message_main` — only the allowlist wires it in.
- Frontmatter fields used in this workspace: `name`, `description`, `tools`, `model`, `thinking`, `subagent_agents`, plus optional `system-prompt` and `auto-exit`. Specific pins: `scout` → `cli-openai/mmcp/MiniMax-M3` thinking high (RECOMMENDED SWITCH to `glm-5.3-flash` due to MiniMax's think-leak format bug — same `[V]` tag, cheaper, clean format); `researcher` (merged) → `cli-openai/zaicp/glm-5.3-flash` thinking high with `safe_bash` + `system-prompt: append` + `auto-exit: true`; `mermaid-maker` and `svg-maker` → `cli-openai/zaicp/glm-5.3-flash` thinking max; `worker` → `cli-openai/zaicp/glm-5.3-flash`.
- 2 of the 5 roles (`mermaid-maker`, `svg-maker`) were added during the port and have no upstream equivalent. Upstream `amosblomqvist/pi-subagents` has only `scout`/`researcher`/`worker`. The `researcher` body comes from the `learn` repo (was `learn-researcher.md` verbatim copy of `learn/agents/researcher.md`, merged). See `extension-provenance.md` for the full audit.

## Paseo MCP loopback details (subagent-types)

- Loopback endpoint discovered via `/tmp/paseo-pi-mcp-*` dirs; only the dir matching `callerAgentId` of the current agent is valid (e.g. for main `cf76ad71-...` it's `pJMw1M`).
- Loopback URL format: `http://127.0.0.1:6767/mcp/agents?callerAgentId=<myAgentId>` with a `token` from `mcp.json`.
- `create_agent` payload requires `provider` field as `provider/model` (e.g. `pi/cli-openai/zaicp/glm-5.3-flash`). 4-segment `pi/cli-openai/zaicp/glm-5.3-flash` accepted by the daemon at 12:41; may have been a more recent validation change.
- Each spawned agent gets its own `/tmp/paseo-pi-mcp-<id>` directory; only the one matching the spawning agent's `callerAgentId` resolves in `findMcpEndpoint`.

## File-system notes

- The repo file `extensions/subagent-types/index.ts` uses box-drawing char `U+2500` for header dashes and em-dash `U+2014` in comments and strings — both must be preserved when matching for `edit` tool oldText. Tabs are 3 levels of indentation (not 4) for block-end `};` lines; mismatches cause `Could not find edits[N]` failures.
- `pi-coding-agent` dist `grep` for `web_fetch` returns zero hits — no built-in web_fetch tool.

## Extension provenance and upstream repos

Per-extension fork attribution, scope-mistake audit, and upstream `pi-subagents` vs `pi-interactive-subagents` distinction are in `extension-provenance.md`. Key facts:

- `subagent-types` is a port of `amosblomqvist/pi-subagents` — a single-tool, 3-agent, no-2-way-channel architecture.
- The 2-way UX in author's videos (YouTube `KRVYUkM16hE` for Simple Pi Subagents; `PIdETjcXNIk` for "Pi to Pi: Two-Way Agent Orchestration") comes from a DIFFERENT upstream extension: `pi-interactive-subagents` in `pi-config`, fork of `HazAT/pi-interactive-subagents`, tmux-pane-based with `ask_question` tool.
- `message_main` / `message_subagent` were self-designed additions during the Paseo port. Their CHILD→MAIN queue-flush path has a self-deadlock bug; see `message-main-bug.md`.

## Paseo chat timeline — image display

- `pi.sendMessage` content is text-only; no image param.
- Tool-result images (4 per render call from `render_mermaid`/`render_svg`) are stored in the session transcript, but whether the Paseo TUI timeline renders them inline is a Paseo UI question — not confirmed.
- The intended visual-design path is Obsidian via `md-log`: `/md-log <filepath>` mirrors the session to a markdown file, the assistant embeds images as `![[viz-...png]]`, Obsidian renders inline. Markdown/math/code blocks do NOT render in Paseo; the `.md` file is the reading surface.

## Skill/runtime dependencies

- `web-fetch` (extension): requires `npm install` (dependencies shipped via npm).
- `youtube-transcript` (skill): requires `yt-dlp` and `ffmpeg` system tools.
- `pdf-reader` (skill): requires python3 venv at `~/.pi/agent/skills/pdf-reader/.venv` with `requirements.txt` installed.

## OM extension internals (consolidator subprocess)

- `spawnWorker` at `consolidator-trigger.ts:122` runs the consolidator subprocess with `cwd = runtime.memoryRoot` (the session-dir top-level, e.g. `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/`).
- `buildWorkerEnv` in `src/spawn/launch.ts` sets `OM_MEMORY_DIR` to `memoryRoot`, plus `OM_WORKER` (role), `OM_RUN_ID`, `OM_RESULT_PATH`, `OM_COST_PATH`.
- `buildWorkerArgv` in `launch.ts` loads extension via `-e agentExtensionPath` with `--no-extensions`/`--no-skills`/`--no-prompt-templates`/`--no-context-files`/`--no-builtin-tools` flags.
- Consolidator's scoped `read`/`write`/`edit`/`ls`/`grep` tools are confined to `memoryRoot` (sandbox root for the consolidator's scoped file tools, design risk 6).
- `agent/index.ts` reads `OM_WORKER` env var; Phase A implements only the `'observer'` role, `'consolidator'` arrives later; consolidator worker requires `OM_MEMORY_DIR` set and its output is its `.memory/` edits (no result file).
- Consolidator worker prompt at `agent/consolidator/prompt.ts` instructs the model to fold observations into topic files under `.memory/`, must NOT create/edit `INDEX.md` (generated automatically), maintains `JOURNEY.md` as APPEND-MOSTLY dated segments, forbids end-of-session framing phrases like `'by session end'`.
- `buildConsolidatorPrompt` (`consolidator-trigger.ts`) injects current time, rendered index, journey text (read via `readJourney(memoryRoot)`), and observations as `<timestamp-id>  <content>` lines.
- The consolidator is deliberately NOT tracked in `observerTasks` (design R5) so compaction waits only for in-flight observers, never the consolidator; `consolidatorInFlight` flag enforces one-at-a-time; on clean exit it trusts the consolidator and re-folds against the current branch to avoid tombstoning observations committed during the run.
- INDEX.md is written by `renderIndexFile` in `src/memory/index-render.ts`; re-rendered after consolidation at `consolidator-trigger.ts:144`; `listTopics` in `src/memory/paths.ts` lists `.md` files except `INDEX.md`/`JOURNEY.md`.

## OM extension — INDEX.md refresh bug + consolidator-nesting bug — FIXED (14:00)

- `INDEX.md` at the session-dir root was reading `Memory index\n_No topics yet._` despite 8 topic files having been written by the consolidator at 12:42-12:43.
- Root cause (two layers): (a) `spawnWorker` runs with `cwd = memoryRoot`, and the consolidator prompt said "write under `.memory/`" — the child resolved `.memory/` relative to its own cwd and wrote one level too deep at `.memory/<sessionId>/.memory/`; (b) `agent/consolidator/tools.ts` `scoped(root, '.memory/auth.md')` nested one level deeper than `'auth.md'`, even though tool descriptions promised both spellings work.
- Fix: `scoped()` in `agent/consolidator/tools.ts` strips leading `'./'` and `'.memory/'` prefix before resolving, so `.memory/auth.md == auth.md`; doc comment cites the 2026-08-30 `'No topics yet'` bug.
- Regression test in `tests/consolidator.test.ts`: `'.memory/auth.md'` prefix write resolves to `memoryRoot/auth.md` (not nested) and `'./.memory/auth.md'` reads back the same file.
- Live data repair: moved 8 topic files + `JOURNEY.md` from `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/.memory/` up one level to `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/` and removed the empty nested `.memory` dir; re-rendered live `INDEX.md` via a `bun` one-liner using `renderIndexFile` + `listTopics` + `atomicWrite` + `indexPath`.
- Tests: `bun test` 108/108 across 15 files in 905ms with 205 expect calls; `bunx tsc -p tsconfig.json --noEmit` TSC_CLEAN.

## Session ledger path

`~/.pi/agent/sessions/--home-coder-workspaces-learn--/2026-08-30T10-19-34-772Z_01a0522e-81f4-7311-8ba4-027cea97e974.jsonl`. Session `01a0522e` started `2026-08-30T10:19:34.772Z` in cwd `/home/coder/workspaces/learn`, model `zaicp/glm-5.3` via `cli-openai`, thinking level high. Two older session dirs from morning pre-fix runs: `01a0521d` and `01a0521e` (each contains only a hidden subdir, likely `.runs` artifacts).
