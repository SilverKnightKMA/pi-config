# [DRAFT — comment cho getpaseo/paseo#3845]

Adding a data point from the same turn-lifecycle family, observed 2026-09-01:

1. **Mirror symptom — kicks on FINISHED agents silently no-op.** A message
   queued for a subagent whose daemon state is `finished` never starts a new
   turn by itself; the queue just sits (there is no upcoming turn boundary to
   drain it). Only an interrupt-style kick force-opens a new turn. So the
   lifecycle bug cuts both ways: mid-flight turns refuse new kicks
   ("Agent is already processing"), settled turns accept them silently without
   acting.

2. **Kick notifications abort the parent's stream** (details in the new issue):
   every `[System Error] This operation was aborted` in our ledgers fires ≤1s
   after a child kick; the `<paseo-system>` notification injected into the
   parent mid-turn cancels the parent's in-flight request and the streamed
   partial output is lost with no retry.

   #3848/#3849 address settlement; the notification-vs-active-turn interaction
   looks like a second path through the same bookkeeping.
