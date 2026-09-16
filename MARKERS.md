# MARKERS.md — Timeline marker contract v2

## v2 change (2026-09-04)

`om-event` and `zw-warning` are **deprecated as live emissions**: custom
messages are part of the model context (pi feeds `agent.state.messages` to
the provider; the `display` flag only controls UI), so OM/ZW chatter was
being read — and occasionally acted on — by the model. Producers now emit
to display-only state files (OM: workspace om-status.json under the memory
dir, consumed by the Paseo om-status plugin panel; ZW: zombie-watchdog.jsonl,
consumed by the Agent Health panel). The two markers below remain valid for
**rendering historical sessions** and for the escape hatches
(`OM_TIMELINE_EMISSION=message` / `ZW_TIMELINE_EMISSION=message`).
`auto-report` and `channel-nack` are functional channel traffic and stay
live — the main agent must see them.

**v2.1 change (2026-09-13, #52):** pool notifications from `subagent-types`
join the live markers under the new `<machine-notice>` envelope. They still
travel the user-role channel **by design** — the main agent must act on them
(spawn a replacement, resume a pool) and pi has no other model-facing path —
but the stable envelope lets agent-health restyle them as cards so they no
longer read as human-typed messages. Presentation is plugin-side; the payload
the model reads stays verbatim.

Single source of truth for the machine-detectable prefixes that pi extensions
emit into the conversation timeline, and that the Paseo plugin `agent-health`
consumes to restyle them as cards. Two repos, one contract:

- **Producer side**: this repo (`extensions/*`) — the pi extensions.
- **Consumer side**: `paseo-plugins/agent-health` — its timeline transformer
  parses `<subagent-message>` and `<machine-notice>` envelopes into rendered
  cards (the former `om-timeline` plugin was removed 2026-09-04, 2c03477).

## Rules

1. Markers are **additive-only** within a major version: a marker may gain new
   payload fields but its exact prefix bytes never change.
2. Every marker is emitted for a **human reader first**. Pretty formatting is
   the plugin's job; the emit stays plain, single-prefix, line-oriented.
3. The consumer must tolerate unknown payloads (parse defensively) and fall
   back to the raw text if anything fails. A plugin crash must never hide a
   marker message.
4. Adding/renaming a marker requires: edit this file → update the test on the
   producer side (`extensions/markers.test.ts`) → vendor this file into
   `paseo-plugins/` → update the agent-health transformer + `check-markers.py`
   there → both checks green.
5. Plugin reads state, never writes it. Cards are transient; durable state
   lives in panels (`Agent Health`, `Observational Memory`).

## Markers

### 1. `om-event` — observational-memory lifecycle *(deprecated v2 — history render only)*

| Field | Value |
|---|---|
| Emitted by | `observational-memory` (observer + consolidator workers) |
| Mechanism | pi custom message, `customType: "om-timeline"` |
| Line prefix (exact) | `> om: ` (blockquote-wrapped by `makeTimelineSink`) |
| Payload (free text) | `observer started/done/failed`, `consolidator folding/done`, cost lines `· $X this run · session $Y (N runs)` |
| Typical lines | `> om: observer done: 17 observations from ~9.0k tok · $0.0012 this run · session $5.00 (136 runs)` |

### 2. `zw-warning` — zombie-watchdog warnings *(deprecated v2 — history render only)*

| Field | Value |
|---|---|
| Emitted by | `zombie-watchdog` (B1 silent-turn, B2 settle-lost) |
| Mechanism | pi custom message, `customType: "zw-timeline"` |
| Line prefix (exact) | `> zw ⚠ ` (blockquote-wrapped by `emitTimeline`) |
| Payload | `B1: Turn silent <dur> — request died silently (#3845)`; `B2: turn ended in-process <dur> ago but daemon still shows "running"` + hint |
| Typical lines | `> zw ⚠ B2: turn ended in-process 45s ago but daemon still shows "running" (settle wake dropped, #3845). Press STOP to clean up` |

### 3. `auto-report` — subagent backstop ping

| Field | Value |
|---|---|
| Emitted by | `subagent-types` (`buildAutoPing`) |
| Mechanism | plain message (renders as assistant text) |
| Line prefix (exact) | `[auto-report] ` |
| Payload | `Subagent <role> (<agentId>) finished… Use paseo_activity(agentId)…` |
| Hard limit | ≤ 300 chars, one line, no result payload |

### 4. `channel-nack` — undelivered kick notice

| Field | Value |
|---|---|
| Emitted by | `subagent-types` (`flushKicks` failure branch) |
| Mechanism | queued channel message (main reads it next turn) |
| Line prefix (exact) | `[channel-nack] ` |
| Payload | `Kick to subagent <agentId> FAILED (<reason>). N messages are still parked in its queue file…` |
| Cadence | one notice per failed kick (retries are silent) |

## Detection (consumer contract)

The plugin transformer queries `assistant_message` items (custom messages are
surfaced by the daemon as text items) and matches:

```
text (trimmed, first line) starts with "> om: "        → om-event
text (trimmed, first line) starts with "> zw ⚠ "       → zw-warning
text starts with "[auto-report] "                       → auto-report
text starts with "[channel-nack] "                      → channel-nack
```

## Vendoring

`paseo-plugins/` keeps a byte-identical copy of this file at its root;
`check-markers.py` fails if the copies or `markers.ts` drift from it.

### 5. `pool-notice` — detached pool lifecycle notice *(live — v2.1)*

| Field | Value |
|---|---|
| Emitted by | `subagent-types` (`drivePoolDetached`) |
| Mechanism | pi `sendUserMessage` followUp (user-role: model must act on it) |
| Line prefix (exact) | `<machine-notice kind="pool-notice">` |
| Payload | early notice: `[pool <id>] early notice: <item> -> <status>…` — first hard failure; final aggregate: `aggregateReport` (counts + per-item lines) |
| Cadence | ≤ 2 per pool (one early notice on first gate_failed/failed, one final aggregate) |
| Why user-role | spawn replacement / pool_resume decisions are model work; no model-facing alternative exists in pi today |

### 6. `wake-prefix` — continuation nudge family *(live — v3, 2026-09-16 #82)*

The continuation driver (goal > plan > task, single-waker) nudges the session
to keep working. Since engine v1.4.86 the plan/task nudges are machine-readable
custom messages (`plan-wake` / `task-wake`, display:false, triggerTurn:true —
model context intact, no chat-text block); the daemon surfaces them as text
items, so the consumer contract is the literal PREFIX either way. Goal wakes
stay full user-role text (the anchor recap is deliberate).

| Field | Value |
|---|---|
| Emitted by | `task` + `read-only-mode` (plan) extensions |
| Mechanism | pi `sendMessage` customType `task-wake`/`plan-wake` (display:false, triggerTurn:true); `WAKE_CHAT_EMISSION=1` restores the old user-role text block |
| Prefixes (exact) | `[task wake N/M] ` · `[plan wake N/M] ` · `[task] continuation wrapped up` · `[plan] continuation wrapped up` · `[plan] quiescent` |
| Consumer | agent-health `wake-chip` transformer — ⚡ wake / ⏹ wrapped / 💤 quiescent compact badges |
| Cadence | one per continuation round (≤1/min after backoff), one wrap-up per episode |

Detection block update (v3):

```
text starts with "[task wake " / "[plan wake "       → wake-chip (⚡)
text starts with "[task] continuation wrapped up"     → wake-chip (⏹)
text starts with "[plan] continuation wrapped up"     → wake-chip (⏹)
text starts with "[plan] quiescent"                   → wake-chip (💤)
```

### 7. `lessons-block` — injected lessons context *(live — v3, 2026-09-17 #110)*

The engine lessons extension injects folded lessons into model context at
session_start and after compaction (the model vaccine — full block, verbatim).
Humans do not need the multi-line block inline in the timeline: the lessons
plugin replaces it with one dim chip and offers the panel list instead.
Render-layer only; the transcript message the model reads stays verbatim.

| Field | Value |
|---|---|
| Emitted by | `lessons` extension (pi-config `extensions/_shared/lessons-core.ts` renderBlock, sent as customType `lessons-context`) |
| Mechanism | pi `sendMessage` custom message (display:false); the pi provider surfaces it as a plain assistant_message — consumer matches the prefix |
| Line prefix (exact) | `Lessons from past sessions` |
| Payload | header line + one `[YYYY-MM-DD][tag] text` lesson per line (tags: failure / convention / preference) |
| Cadence | once per session start + once per compaction (LESSONS_INJECT=0 disables) |
| Consumer | lessons plugin `lessons-block-transformer` → 📚 chip; lessons panel lists the same file (`~/.pi/agent/lessons.md`) |
