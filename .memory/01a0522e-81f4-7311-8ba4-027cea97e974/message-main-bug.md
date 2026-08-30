---
id: message-main-bug
title: message_main queue-flush bug — root cause, fix, Phase 1 + Phase 2 implementation, E2E verification
summary: Confirmed real bug; file-queue + 3-event drain fix DESIGNED, IMPLEMENTED, TESTED, and E2E-VERIFIED. Phase 2 (ask_question park/wait/absorb + name registry + resume-by-name) also shipped and E2E-verified. One self-introduced bug (missing JSON-RPC id) found and fixed during E2E. Related: Paseo 'finish notification drop' stop-bug confirmed via 3 reproductions.
updated: 2026-08-30 15:36
---

## Confirmed real bug, fully fixed

Originally logged as an "alleged defect" / "not observed" — later confirmed real and user-validated. The user (Vietnamese): "the subagent message delay IS a bug; I saw the session running endlessly, stopped it and chatted more, then the message returned, which is not good" (10:59). Reversed initial finding: `message_main` works in principle, delivery merely defers to the next real user message because tool-answers (quiz/ask) do not count as turn flushes.

After Phase 1 + Phase 2 merged in: `message_main` queue → drain on next turn boundary works in ~5 seconds end-to-end (verified at 12:35); the full `ask_question` park/wait/absorb loop is verified with PINEAPPLE-42 round-trip.

## Root cause (pre-fix)

- `/home/coder/workspaces/learn/.pi/extensions/subagent-types/paseo-channel.ts` (lines 1-234) — MCP loopback client plus `sendToSubagent`/`sendToMain` plus poll-based `flushWhenIdle`.
- `/home/coder/workspaces/learn/.pi/extensions/subagent-types/index.ts` (lines 343-360 lifecycle hooks; lines 568-594 `message_main` tool).
- `paseo-spawn.ts` — no idle/flush logic.
- Old `flushWhenIdle` (`paseo-channel.ts:182-215`) was the ONLY drain path: a self-rescheduling `setTimeout` polling `get_agent_status` every 5s; when status was not `running`/`initializing` it spliced the batch and called `send_agent_prompt`.
- Three reinforcing failure modes per scout `f5971b2f-52c2-478a-8c51-a22a5375feb9`:
  1. `get_agent_status` returned stale `running` indefinitely.
  2. `pendingToMain[0].agentId` captured once at first tick, never self-corrected.
  3. `flushTimer` single-slot scheduler — a `sendToMain` during in-flight tick never re-armed.
  4. No `session_switch`/`shutdown` cleanup — leaks across sessions.
- The authenticated POST poll itself extended the parent's daemon activity window, so the daemon kept reporting parent as `running`. Manual STOP + new user message was the only way to force idle.
- Ledger timeline confirmed 33-minute delay between queue (10:23:37Z) and `CHANNEL_OK` delivery (10:56:24.580Z, entry `[174]`). User's original symptom: "session chạy mãi không ngừng" (session runs indefinitely).

## Fix design (file queue + 3-event drain)

Symmetric both directions:

- File queue path: `~/.pi/agent/subagent-channel/<targetAgentId>.jsonl`, per-line `{id, from, fromRole, kind, text, ts}`.
- `pushToQueue` = `appendFileSync` after `mkdirSync(channelDir(base), {recursive: true})` (parent-dirs were the original bug — `appendFileSync` does not create them). Atomic-ish with `O_APPEND`; per-call open means concurrent appends never lose messages.
- `drainQueue` uses rename-safe drain: `rename file → .draining-<pid>-<ts>`, read entries, then `unlink`. Race-safe under concurrent appends.
- Recipient side drains via 3 lifecycle events on its OWN process (no daemon traffic from sender):
  - `turn_end` — inject via `pi.sendMessage` right after current round while main is mid-multi-round.
  - `before_agent_start` — inject via `return {message}` when main is idle and user just submitted prompt.
  - `agent_settled` — final drain after retry/compaction/follow-up chain.
- All 3 events call a single `drainQueue()` whose first step is an atomic splice so the other two paths see empty; `inFlight` guard prevents concurrent drains.
- Anti-duplicate: each `flushInbound` call processes the result of its OWN atomic splice; subsequent drains find nothing to do.
- Main→child symmetric: `sendToMain` and `sendToSubagent` each do ONE status check, busy → queue, idle → direct `send_agent_prompt`. `interrupt:true` opt-in for urgent cases always daemon-sends.
- Old `pendingToMain` and `flushWhenIdle` DELETED.

## Implementation status — COMPLETE

**`paseo-channel.ts`** (full rewrite + Phase 2 additions) at `/home/coder/workspaces/learn/extensions/subagent-types/paseo-channel.ts` (dev) and synced to `.pi/extensions/subagent-types/paseo-channel.ts` (live), diff `-q` clean. Exports:
- `McpEndpoint` interface, `findMcpEndpoint` (exact `callerAgentId` match, not prefix)
- `mcpCall` — raw JSON-RPC `tools/call` over loopback endpoint, 30s timeout, with **incremental `let callSeq = 0; body.id = ++callSeq`**. Comment warns the `id` field is mandatory (see JSON-RPC id bug below).
- `createAgent`, `getAgentStatus`, `isBusy(running||initializing)` helpers
- `ChannelMessage` interface with `kind: 'message' | 'ask' | 'reply'`
- `channelDir` default `~/.pi/agent/subagent-channel`
- `pushToQueue(targetAgentId, message)` — `mkdirSync({recursive:true})` then `appendFileSync`
- `drainQueue(targetAgentId)` — atomic rename → read → unlink, race-safe
- `sendToMain(targetAgentId, message)` — one status check; busy/unknown → queue, idle → direct `send_agent_prompt`
- `sendToSubagent(targetAgentId, message, interrupt?)` — symmetric with `interrupt:true` flag
- `renderForPrompt(messages)` — formats drained messages as `<subagent-message from=... role=... kind=...>` block
- **Phase 2 additions**: `RegistryEntry` interface, `loadRegistry`, `saveRegistry`, `registerSubagent`, `resolveSubagentName`, `waitForReply`. Registry path `~/.pi/agent/subagent-channel/registry.json` mapping name → `{agentId, role, title, createdAt}`, latest-wins on duplicate name.

**`index.ts`** edits applied at `/home/coder/workspaces/learn/extensions/subagent-types/index.ts` (dev) and synced to `.pi/extensions/subagent-types/index.ts` (live). All edits applied cleanly after the python heredoc fallback (see "edit tool friction" below):

- Imports updated to bring in `drainQueue`, `renderForPrompt`, `ChannelMessage`, `waitForReply`, `registerSubagent`, `resolveSubagentName` from `./paseo-channel.ts`.
- `message_main` tool rewritten: builds a `ChannelMessage` and calls `sendToMain(endpoint, mainId, msg)`. Result text: `'Queued — the main agent picks this up at its next turn boundary (its current work is never interrupted).'` (busy) or `'Delivered to main agent (new turn started).'` (idle). Description updated: `"delivered when it goes idle"` → `"delivered at its next turn boundary"`, `"mid-turn"` → `"mid-run"`.
- `message_subagent` tool rewritten with `interrupt:true` opt-in. Default is turn-boundary pickup; `interrupt:true` daemon-sends for urgent redirects. Builds `ChannelMessage` with `id`/`from`/`fromRole`/`text`/`ts` and calls `sendToSubagent`. Phase 2 added optional `name` (agentId XOR name via `resolveSubagentName`) and `kind` ('message' | 'reply') params.
- `flushInbound()` at lines 347-374 wires `turn_end` + `before_agent_start` + `agent_settled` handlers to one atomic `drainQueue()` call, with `drainInFlight` guard. Each site returns `pi.sendMessage` or `return {message: {customType: 'subagent-message', content, display: true, details: {}}}` as appropriate.
- New `ask_question` tool (child→main): sends `kind: 'ask'` to main, waits `wait_seconds` (default 90, max 300) via `waitForReply` (polls caller's OWN queue file every 2s — zero daemon traffic), absorbs reply mid-wait or parks on timeout. Errors if called by main agent.
- `allowlistFor` at line ~148 returns `[...def.tools.map(mapToolName), 'message_main', 'message_subagent', 'ask_question']`.
- After successful `createAgent` spawn with a name, calls `registerSubagent({agentId, role, title, createdAt})` so the registry stays fresh.

## Tests — 52/52 PASS, TSC CLEAN

- `bun test subagent-types`: **52 tests across 2 files, 0 fail, 87 expect() calls, 791 ms**.
- `bunx tsc -p tsconfig.json --noEmit`: **TSC CLEAN**.
- New `channel.test.ts` (3299 bytes) covers:
  - `pushToQueue` / `drainQueue`: atomicity, rename-safety, torn-tail-line, per-agent isolation, disk persistence.
  - `renderForPrompt`: multiple messages joined with blank line, kind=ask variant, blank-line handling.
  - Phase 2: registry register/resolve roundtrip, same-name latest-wins, unknown → undefined, corrupt registry.json → empty non-fatal; `waitForReply` queued-reply resolves immediately, timeout → undefined, mid-wait reply absorbed.
- Test history: 36 → 38 (after first channel.test.ts; `mkdirSync` not in pushToQueue caused 7 fails) → 45 (after mkdirSync fix + display/details CustomMessage fix + buggy split-test fix) → 52 (Phase 2 tests added).

## TypeScript pitfalls discovered and fixed

- `BeforeAgentStartEventResult.message` is `Pick<CustomMessage, "customType" | "content" | "display" | "details">` requiring ALL four fields. Original extension was missing `display: true, details: {}` on every sendMessage/return site, cascading a TS2769 on `'before_agent_start'` overload selection. Fix: add `display: true, details: {}` to all 3 sendMessage/return sites.
- `bunx tsc --noEmit` (bare) prints help instead of compiling — tsc 7 (native TypeScript port) may have renamed/removed the flag. Use `bunx tsc -p tsconfig.json --noEmit` for the per-extension tsconfig. `tsconfig.json` is present in `ask-user-question`, `observational-memory`, `quiz`, `snip`, and `subagent-types` extension dirs.
- `ask_question`'s heterogeneous `{details: ...}` return shapes (`{}`, `{asked, repliedBy}`, `{asked, parked}`) broke TS2322 because the union return did not satisfy `AgentToolResult`. Fix: a single typed `const details: {asked?: string; repliedBy?: string; parked?: boolean} = {}` mutated across branches.

## Self-introduced JSON-RPC id bug (found + fixed)

After Phase 1 sync, repeated `spawn_subagent` calls returned `Spawn failed: no MCP response (http 202)` with no agent created. Diagnostic arc (from scout + raw probes):

- Loopback URL + token verified identical between `mcpCall` and raw `Bun.fetch`.
- Curl / raw Bun probes with same payload succeeded (HTTP 200, agent created).
- Curl probe `notifyOnFinish:true` succeeded — not the issue.
- Direct `createAgent` call from extension's own code reproduced the 202 in same process as a 200 raw fetch.
- Same-process pair tests: raw always 200, `mcpCall` always 202, regardless of call order.
- Verbatim copy of `mcpCall` in standalone script returned 200 — proving the live module's `mcpCall` differed from the dev copy that had been read.
- Live module debug-log patch confirmed `[mcpCall] create_agent -> 202` with empty body.
- Body comparison: both sent same payload, same `Accept`, but extension body at 12:45 had **NO `"id"` field**, while raw body had `{"jsonrpc":"2.0","id":1, ...}`.

**Root cause**: the assistant's own Phase 1 rewrite of `paseo-channel.ts` accidentally dropped the JSON-RPC `"id":1` field from the `tools/call` body. Per JSON-RPC 2.0 an id-less request is a notification — the daemon processes it but never replies, and Express returns 202 with empty body. The Paseo daemon restart at 12:34 was a red herring; the 202 bug was introduced by the rewrite (old code had `id:1` and worked that morning).

**Fix**: both dev and live `paseo-channel.ts` (lines 80-84) updated to `let callSeq = 0; body.id = ++callSeq` per call, with a code comment warning the id field is mandatory and must never be dropped.

**Side effect noted**: the assistant's own pi process loaded extensions at 12:35 BEFORE the fix, so its in-memory `mcpCall` still had the id-less bug at the time of the fix. Disk now has fixed code which new children load fresh. Spawning via `paseo_create_agent` (MCP tool, 39+ `paseo_` prefixed tools) confirmed working after the fix.

## Edit tool friction + python heredoc fallback

The `edit` tool repeatedly failed on `index.ts` because of:
- Tab-count mismatch on trailing `};` (file uses 3 tabs, assistant's oldText sometimes had 4).
- Box-drawing char `U+2500` in headers and em-dash `U+2014` in strings.
- Dropped lines in multi-block edits.
- Invisible-character mismatches.

Repeated `'Could not find edits[N]'` failures were bypassed by writing a `python3` heredoc script that read `index.ts`, asserted exact string matches, performed `s/old/new/` 1-by-1, and wrote the file. Output: `OK - N replacements applied`. This became the reliable path for `message_main`, `message_subagent`, `ask_question`, and `registerSubagent` wiring edits.

For Phase 2, three python-edit passes:
1. Add Phase 2 imports and `registerSubagent` call after spawn (OK phần 1-2).
2. Extend `message_subagent` with `name`/`kind` params, agentId resolution, `targetId`.
3. Add `ask_question` tool, update `allowlistFor`, fix `details` type union.

First details-fix script died on a multiline template-literal assertion because the file contained real newlines instead of literal `\n`; redo with exact file text succeeded.

## RPC smoke harness discoveries

- `pi --mode rpc` args: `--mode rpc --extension EXT --no-session`. Empty stdin loads without fatal errors (visible `mcp setStatus extension_ui_request` + parse failure from empty line).
- Reference implementations: `extensions/ask-user-question/smoke-rpc.ts`, `extensions/observational-memory/smoke-rpc.ts` (+ `spawn.smoke.test.ts`).
- **Correct RPC frame format** (verified by reading `ask-user-question/smoke-rpc.ts`): the `type` field IS the command name directly (e.g. `type: 'get_commands'`); frames include optional `method` field for sub-protocols; writes `JSON.stringify(frame) + '\n'` to `proc.stdin`; response types are `response` / `extension_ui_request` / `extension_error`.
- Wrapping frames in `{type:'request', command:'...'}` returns `Unknown command: request`.
- Using `command: '...'` without the wrapper returns `Unknown command: undefined`.
- Smoke test waits up to 20s for `get_commands` response; retries probe.
- Subagent-types smoke test passed: 0 extension errors; command list includes `readonly-dev`, `subagent-types-dev`, `ask-user-question-dev`, `md-log`, `websearch` (confirming `pi-web-access` package loaded).

## E2E verification timeline

### Phase 1 E2E (queue + drain, no ask_question)

- 12:07: spawned scout `3ef0e69e-debe-4808-8eb7-7bc3de51165f` ("Queue E2E child-side"); main agent id `cf76ad71-3f82-4296-960f-fa9e2fcd06ee`.
- 12:07: child called `message_main` with `QUEUE-E2E-CHANTEST` and got the NEW result text `'Queued — the main agent picks this up at its next turn boundary (its current work is never interrupted).'`
- 12:07: queue file confirmed on disk at `~/.pi/agent/subagent-channel/cf76ad71-*.jsonl` with one well-formed entry `{id:1788091625940-41f26e, from:3ef0e69e..., fromRole:scout, text:QUEUE-E2E-CHANTEST, ts:2026-08-30T12:07:05.940Z}`.
- 12:34-35: user restarted Paseo.
- 12:35: parent's first prompt drained the queue via `before_agent_start`; `<subagent-message from=3ef0e69e... role=scout kind=message>QUEUE-E2E-CHANTEST</subagent-message>` injected into main's context; queue file drained and unlinked (0 entries).
- Contrast with old behavior: 33-minute delay + manual stop.

### Phase 2 E2E (ask_question loop with name registry)

- 12:40-46: spawn failures from JSON-RPC id bug — fixed (see above).
- 12:46: spawned asker scout `906c451c-4785-40a7-bfa7-49ad12870de6` via `paseo_create_agent` with labels `subagent.role=scout` and `subagent.parent=cf76ad71-3f82-4296-960f-fa9e2fcd06ee`.
- 12:47: asker's `kind=ask` message `'What is the secret word I must report?'` landed in main's queue file `~/.pi/agent/subagent-channel/cf76ad71-*.jsonl` after 5s AND was injected into main's context as `<subagent-message kind="ask">` via the turn-boundary drain firing mid-run between LLM rounds.
- 12:47: assistant pushed `kind=reply` entry directly into the child's queue file (bypassing its own broken in-memory `message_subagent`) with text `'The secret word is PINEAPPLE-42.'`
- 12:47: asker finished and reported exactly `PINEAPPLE-42`, closing the full `ask_question` E2E loop (ask → queue → drain injection → direct reply push → `waitForReply` absorb → report).

### Phase 2 E2E — registry write/resolve/resume (REG-E2E-OK)

- 13:09: user confirmed Paseo restart; the assistant's own pi process still had the in-memory id-less `mcpCall` (loaded at 12:35 before the fix landed on disk), so a second restart was needed to pick up the on-disk fix.
- 13:10: spawned scout with `name="registry-check"`, role `scout` (id `345f36ad-7477-46ba-96b4-5c55cfa7725f`) tasked to call `message_main` with text `REG-E2E-OK`. Spawn returned without HTTP 202 — id fix working.
- 13:10: child's `REG-E2E-OK` flowed into the main agent's context mid-run via drain. `registry.json` confirmed entry `registry-check → {agentId:345f36ad-..., role:scout, created:2026-08-30T13:10:09.492Z}` — registry write E2E verified.
- 13:10: `message_subagent` by name resolved `registry-check` (no `agentId` supplied) to the idle child, delivered and started a new turn. Child processed, stopped with `'Stopping.'` — resume-by-name E2E verified.

### Park-timeout PoC (MANGO-77)

- 13:18: spawned scout `asker-park` (id `5cd46180-4927-4087-8371-1e3db85a8b0b`) tasked to call `ask_question` with `wait_seconds=10`, NOT receive a reply (so it would park), then in a later turn report the code word.
- 13:19: child pushed `kind=ask` "What is the park code word?" to main's queue, drained and injected into main's context.
- 13:19: child received no reply for 10s, parked with `'Parked. Waiting for main agent's reply to start my next turn.'` and ended its turn.
- 13:19: main replied with `MANGO-77` via `message_subagent`, which resumed the parked child as a new turn. Child reported exactly `MANGO-77`. Park-timeout PoC PASSED.

### Interrupt PoC (INTERRUPTED-OK)

- 13:20: first interrupt attempt against scout `slow-counter` (`151c7540-793c-4a8b-9a0d-f63202216ab3`) FAILED — the child counted lines via grep and finished in ~30s (6 files, 2,974 lines) before the 45s sleep completed, too fast to interrupt.
- 13:20: spawned worker `sleeper` (id `9ab5f31f-abb6-4ed6-8d3d-ea52b8b7da16`) tasked to run `sleep 90 && echo SLEEP_DONE` via `safe_bash`. After 30s the assistant sent `message_subagent` with `interrupt:true` telling it to reply `INTERRUPTED-OK` and stop.
- 13:21: worker's in-flight turn and sleep were aborted with `System Error 'This operation was aborted (stopReason=error, model=cli-openai/zaicp/glm-5.3)'`. The replacement prompt ran as a new turn and returned exactly `INTERRUPTED-OK`. Interrupt PoC PASSED.

### Three-way channel semantics summary

All three Paseo channel semantics verified E2E with distinct code words:
- **absorb** (reply mid-wait): `PINEAPPLE-42`
- **park + resume** (timeout, then later resume): `MANGO-77`
- **interrupt** (in-flight turn abort and replace): `INTERRUPTED-OK`

### Depth-2 E2E (worker spawns scout)

- 13:27: spawned worker `b95b0d16-9c18-4ac3-8848-d88fe7bc16b3` tasked to spawn its own scout `d2-scout` reading `/tmp/gap-test/case.txt` (containing two lines `searchme lower` and `SEARCHME upper`) and report them verbatim, prefixing with `D2:` (or `D2FAIL:` on failure).
- 13:43: result arrived via notification: worker relayed `D2:searchme lower\nSEARCHME upper` — exact two lines verbatim. Depth-2 PASSED.
- Depth-3 is structurally impossible: the scout role only has read/grep/find/ls tools and no `spawn_subagent`; depth control is enforced naturally by `allowlistFor`.
- Final worker state: `updateCount: 29`, `currentModeId: null`.

## Final state

- `bun test subagent-types`: 52/52 PASS, 87 expect() calls.
- `bunx tsc -p tsconfig.json --noEmit`: CLEAN.
- `diff -q` confirms `paseo-channel.ts`, `index.ts`, `channel.test.ts`, `agents/researcher.md` all sync dev==live.
- `.pi/extensions/subagent-types/agents/` contains 5 roles: `mermaid-maker.md`, `researcher.md`, `scout.md`, `svg-maker.md`, `worker.md`. `learn-researcher.md` gone.
- All three semantic modes (`absorb`/`park+resume`/`interrupt`) E2E-verified.
- All PoC agents archived via `paseo_archive_agent` (24 of 24 test/probe agents cleaned up at 13:14; PoC trio at 13:22; depth-2 worker+scout at 13:44; `model-audit`+`scan-vision`+`guided-choice-test` at 14:01).
- `tests/TOOL-TEST-REPORT-2026-08-30.md` gained a Phase 1+2 channel-redesign appendix at 13:15; final size 152 lines.

## Phase 2 design (final)

- `ask_question` (child→main): `pushToQueue({kind:'ask'})` to main, then `waitForReply` polls caller's OWN queue file locally every 2s (zero daemon traffic). On reply mid-wait: absorb into current turn. On timeout (default 90s, max 300s, `wait_seconds` param): child parks turn for next turn arrival.
- Name registry: `~/.pi/agent/subagent-channel/registry.json` mapping name → `{agentId, role, title, createdAt}`, latest-wins.
- `message_subagent`: `agentId XOR name` (resolved via `resolveSubagentName`), `kind: 'message' | 'reply'`.
- `spawn_subagent` `name` param (line 279, "Optional display title") becomes the registry key.

## Phase 3 (potential)

- Frontmatter fields `system-prompt: append` and `auto-exit: true` (subagent-types does not yet implement them).
- `subagent_message` integration with `interactive-subagents`'s `<session>.loadout.json` resume snapshots (low priority — file queue already covers most restart cases).

## Mermaid bug-vs-fix diagram

Source written via `write_mermaid` (15 lines). Rendered to `viz/viz-message-main-bug-vs-fix-1788087820929.png`. Vision-verified by scout `c3c263a0-de60-4410-bd68-be0e555fcb51` using `cli-openai/zaicp/glm-5.3-flash`: HIỆN TẠI side shows poll → "daemon vẫn báo running" → poll cycle + "user bấm STOP tay" → `send_agent_prompt` escape arrow. ĐỀ XUẤT side shows queue → wait diamond with all 3 signal arrows (`agent_settled`/`input`/poll 2 lần x 2s) converging on `flushPending()`. Vietnamese diacritics crisp.

## Plain-language analogy used

Employee keeps knocking on boss's door every 5 seconds; each knock flips the "BUSY" light back on; only manually opening the door (user STOP) lets the employee in. The 6 fix items explained by hand: why no double-send due to atomic splice — "3 người 1 chìa khóa nhà: người đầu mở cửa, người sau thấy cửa đã mở" (3 people one house key: first opens, rest find door already open).

## Paseo "finish notification drop" stop-bug (CONFIRMED)

Confirmed via 3 reproductions (14:05-14:07 daemon-side finish at 14:05:54.233 with status still `running`; user's "Tại sao còn pause?" arrived 0.4s after; reproduced again at 21:18). One root cause — daemon records `attentionReason: finished` while status stays `running`, finish signal never reaches UI — produces three symptoms: spinner keeps spinning, timer keeps running, new user messages get swallowed/queued as `followUp` until STOP forces an abort and releases the queue. Daemon-side; not fixable from extensions. Workaround: press STOP (safe, nothing lost since the turn already finished) or send a new message. See `paseo-bugs.md` for full detail and secondary hypothesis (OM `'om: observer started'` notification might keep spinner alive).
