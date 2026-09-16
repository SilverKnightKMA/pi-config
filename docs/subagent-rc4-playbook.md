# Subagent kick playbook — RC4 (2026-09-16, #51)

Doctrine: never teach a workaround — teach the native path. If a child lacks
a tool it needs, the fix is a role/template/tool change, not a bash trick.

## The failure shapes

| Symptom | Root cause | Play |
|---|---|---|
| Child repeats the same text turn after turn, no tool calls | Missing tool it assumes it has; task phrasing asks for an action its role cannot do | RC4 below; then fix the template or task phrasing |
| Child thrashes between two approaches (A-B-A-B) | Conflicting instructions or an ambiguous done-check | RC4 with the ONE next action made explicit |
| Child "finishes" without the required artifact/token | Report path unclear in its template | `research_report` (researcher) / `message_main` digest with token on first line |
| Child asks for a tool it does not have | Correct behavior since #58 — the standing footer tells it to `message_main` and WAIT | Answer via `message_subagent` with the adjusted instruction or the widened role |

## RC4 — the single-action interrupt

When a child has thrashed for ≥3 turns (repeats/oscillation/no tool calls):

1. Send `message_subagent` with `interrupt: true` — this REPLACES the child's
   current turn immediately. Do not queue behind it.
2. The message contains exactly ONE action, fully specified:
   - the tool to call (`research_report` / `message_main` / `read` …),
   - the input shape (sections, token on first line, path),
   - what NOT to do (no bash file writes, no retries of the failed approach).
3. Nothing else in the message. One action, zero alternatives — a thrashing
   model needs a rail, not a menu.
4. Watch the next settle. If the single action completes, done. If the child
   thrashes again, kill it (`cancel_agent`) — two RC4 strikes means the task
   itself is ill-posed for the role; fix the task text and respawn.

## Expect tokens in reports (pool discipline)

- The parent's `spawn_pool` item may declare `expect: "TOKEN"`; the gate reads
  the child's REPORT string (channel message or curated activity digest).
- Task text must say: put the token on the FIRST line of your report.
- `research_report` (v1.4.85) verifies the token locally before delivering, so
  a gate failure now means the child never submitted properly — check for a
  rejected `research_report` call in its transcript before blaming the gate.

## Role tool matrix (audit 2026-09-16, #51)

| Role | Tools | Report path |
|---|---|---|
| researcher | web_search, web_fetch, safe_bash (RO allowlist), read, research_report | `research_report` — never bash file writes |
| scout | read, grep, find, ls | `message_main` digest, token on first line |
| worker | read, write, edit, safe_bash, web_search, web_fetch, spawn_subagent | `message_main` digest + artifact path |
| mermaid-maker | write_mermaid, edit_mermaid, render_mermaid, read | `message_main` digest + artifact path |
| svg-maker | write_svg, edit_svg, render_svg, read | `message_main` digest + artifact path |

All roles also get `message_main`, `message_subagent`, `ask_question`
(channel floor). Tasks must never instruct a role to use a tool outside its
row — write the task for the role, not for an idealized agent.
