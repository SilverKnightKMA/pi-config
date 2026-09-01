# [DRAFT — chưa đăng] Bug: child-agent kick notification aborts the parent's in-flight stream; partial output is lost

## Environment
- Paseo 0.6.1 (also present with v0.7.0-beta.2 behavior), pi agent runtime, extensions model
- Reproduced across two workspaces, 4+ occurrences in one evening + more the next day

## Symptom
While the MAIN agent is mid-turn (streaming a response), an extension or the user
triggers activity on a CHILD agent (`send_agent_prompt` / `message_subagent`,
including `background:true, notifyOnFinish:true`). The daemon injects a
`<paseo-system>` status notification into the parent session WHILE the parent's
LLM request is still streaming. The parent's request is then aborted:

```
[System Error] This operation was aborted (stopReason=error, model=...)
```

Consequences:
1. The parent's already-streamed text is NOT persisted (the ledger entry is
   missing) — the user saw the text in the UI, the transcript does not have it.
2. No retry: the turn is simply marked failed.
3. Single-agent sessions (no children) never hit this — the trigger is
   child-related notification injection.

## Evidence (from session ledgers)
4 of 4 aborts in a 2-hour window fire ≤1s after a `message_subagent` kick
returned "Delivered (started new turn)":
```
10:29:46 toolResult message_subagent "Delivered … (started new turn)" → assistant ⛔ aborted (no text persisted)
11:45:08 toolResult message_subagent "Delivered … (started new turn)" → assistant ⛔ aborted
12:18:29 toolResult message_subagent "interrupted current turn"      → assistant ⛔ aborted
12:18:51 toolResult message_subagent "Delivered … (started new turn)" → assistant ⛔ aborted
```
The same signature shows up at spawn time: spawn a child, child finishes a few
minutes later while the parent streams → parent aborts.

The error surfaces as an AbortError from the runtime's own AbortController —
i.e. something locally cancels the request; it is not a provider-side drop.

## Expected behavior
- Notifications injected into a session with an active turn should be BUFFERED
  until the turn settles, not abort the in-flight request; or
- if an in-flight request must be cancelled, the streamed-so-far content should
  be persisted and the request retried.

## Workaround (extension-side)
Defer all child kicks to the parent's `turn_end`/`agent_settled` and pass
`notifyOnFinish:false`; deliver child→parent reports through a file queue that
the parent drains at its own turn boundaries.
