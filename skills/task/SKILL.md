---
name: task
description: Use for any multi-step work (3+ distinct steps) so progress is visible, ordered, and survives compaction - explains task_create/task_update discipline, dependencies, and evidence-gated completion
source: https://github.com/pifydev/task
source_author: pifydev
license: MIT
packaged_as: port
---

# Task tracking

This environment has the `task` extension installed: a session task list
with dependencies, evidence-gated completion, and stale-list reminders.

## When to track

- The work has 3+ distinct steps, or spans multiple files/subsystems.
- The user gave several requests at once.
- Long work where compaction could lose the plan.

## When NOT to track (task is OPTIONAL — never a gate)

- Chat, explanations, teaching, quick questions — no "work" to ledger.
- 1-2 step jobs; a quick read; a one-file tweak.
- Never create a task just to be allowed to work: a junk task created
  for compliance is fake evidence and pollutes the verify signal
  (same status-as-acceptance class the code-review skill rejects).

Skip it for single-step or trivial edits — the overhead outweighs the value.

## Discipline

1. Create the tasks BEFORE starting work, with `blockedBy` reflecting real
   ordering (design → implement → verify). Blocked tasks refuse to start.
2. Mark exactly one task `in_progress` when you begin it — not before.
3. Complete a task the moment it is done. Completion REQUIRES evidence:
   state what you verified (command output, test results, file state).
   Writing code is not evidence that it works.
4. A non-zero exit can never be described as success. If the command you
   ran to verify a task failed, that failure IS the state of the task: keep
   it `in_progress` and say what failed. Evidence that quotes a passing run
   you did not get is worse than no evidence.
5. Say which check you ran, not that you checked. "bun test: 42 pass, 0
   fail" can be disagreed with; "verified" cannot.
6. A completed task is frozen. Do not quietly re-open, re-word, or re-scope
   it to match what you ended up doing — create a new task instead, so the
   record still shows what was actually promised.
7. Cancel tasks that stopped mattering instead of leaving them open.
8. `task_list` shows the ready set — tasks with no open blockers are safe to
   parallelize (e.g. hand to a subagent).

Reminders about stale tasks arrive as system messages; act on them by
updating the list, and never mention them to the user.
