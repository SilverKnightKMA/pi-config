---
name: code-review
description: Doctrine-filtered code review. Use when asked to review a diff, a pull request, or changes before merge/commit. Reviews stable candidates only; rejects status-as-acceptance.
---

# Code Review

Review a **stable candidate** (a named diff), not a moving target. If the code
changed after review started, that is a new candidate — restart on the new diff.
This skill reviews only; fixes are a separate write by the writer (review is
document-only output).

## Process

1. **Classify risk first.** Auth/PII, payments, schema, irreversible state,
   blast radius (count downstream callers of modified functions). Depth follows
   risk: a typo fix gets step 5 only; an auth-crypto change gets an independent
   reviewer that is not the writer.
2. **Diff discipline.** Review the delta against a named known-good base
   commit, never re-litigate the whole artifact. If >400 lines changed, ask for
   a split before reviewing (defect detection collapses past that).
3. **Work the checklist** (below), grouped by section.
4. **Verdict.** End with an explicit three-way verdict — approve / request
   changes / needs discussion — naming who accepted (authority). Cap fix-review
   loops at 2 rounds; a non-converging loop means the task is underspecified,
   which is itself the finding. Escalate to the human instead of looping.
5. **Tiny path.** Low-risk local fixes: intent check + one verification
   command + verdict. No ceremony beyond the failure it prevents.

## Checklist

### Scope & trigger
- [ ] Review the diff against a named base commit — errors live in the delta.
- [ ] Post-review edits = new candidate; restart review on the new diff.
- [ ] >400 changed lines → request a split first.
- [ ] Don't re-review an unchanged diff already reviewed; cite what was covered and by whom.
- [ ] Risk classified; depth scaled to it (0/1/independent reviewer).

### Intent & design
- [ ] One sentence on what the change claims to do; the diff does exactly that, nothing extra.
- [ ] No speculative generality (unused params, premature abstraction, "might need later").
- [ ] No compat shims or test edits whose only effect is keeping old tests green.
- [ ] New code checked against existing helpers first (reuse audit).
- [ ] If the diff touches a scope another effort is actively writing — stop and coordinate, do not review.

### Correctness & contracts
- [ ] For each changed behavior: which wrong mechanism would make a test fail? No answer = the test proves nothing.
- [ ] Deleted lines checked against history — was any of it a fix or a settled contract?
- [ ] Boundaries probed where the diff touches them: empty/null/overflow, error propagation, concurrency on shared state.

### Verification & evidence
- [ ] One real verification command run against the changed behavior; record command + actual output + environment (host, versions). Exit 0 is a wake-up signal, not acceptance.
- [ ] Deletion test on cited proofs: would the claim survive if the cited test/line were removed?
- [ ] Unchecked areas reported as unknown ("not verified"); absence of findings is never "verified safe".

### Findings & verdict
- [ ] Every finding labeled blocking / important / nit; only blocking gates.
- [ ] Style, naming, formatting → linter or "Nit:", never blocking.
- [ ] High-risk changes: reviewer ≠ writer session.
- [ ] Explicit verdict naming the acceptor.

## Hard rejects (do not let these into a verdict)

- "CI green / build passes / exit 0" used as acceptance — status is a signal, not a decision.
- Self-review as the acceptance gate for high-risk changes.
- Persona panels or full liturgy on low-risk diffs — process must not exceed the failure it prevents.
- Numeric quality scores as verdicts — blocking findings, not averages.
