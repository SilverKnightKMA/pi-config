---
name: committee-lanes
description: Blind design lanes with proposition-pinning convergence for hard decisions. Use when stuck, looping, tunnel-visioning, or facing a high-risk design choice. Replaces the upstream paseo-committee skill.
user-invocable: true
---

# Committee Lanes

Doctrine: the first looks must be independent, one arbiter converges, and
nobody votes. A local bug fix does not need a committee — ceremony must never
exceed the failure it prevents.

## When to use

- High-risk change: auth, data, public contract, migration, external side
  effects, anything that must survive restart/handoff.
- Many defensible solutions or an unfamiliar domain.
- Stuck or looping: a third fix attempt at the same symptom, or two agents
  disagreeing on mechanism.

## When NOT to use

Local fix with an obvious answer, cheap reversible change, anything you can
verify yourself in minutes. Do not spawn lanes for these.

## Workflow

1. **Framing lint** (before writing the brief)
   - Quote the original requirement verbatim; do not paraphrase it softer.
   - The brief must not imply a preferred verdict.
   - Facts carry sources; unverified premises are labeled "claim".
   - Hard constraints are separated from preferences.
   - "Unreasonable" options stay listed unless physically impossible.

2. **Neutral brief** — identical for every lane: problem, evidence,
   constraints. It must NOT contain your current hypothesis or any solution
   sketch. Your framing is exactly what the lanes exist to escape.

3. **Spawn lanes** — 2 lanes by default (a 3rd only for high-risk), different
   provider families where possible, full isolated sessions via
   `spawn_subagent`. Every lane task ends with the no-edits suffix:

   ```
   This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code.
   ```

   Trust the finish notification; do not poll or hurry lanes.

4. **Converge by pinning propositions**
   - From all lane outputs, extract the 3–5 propositions that actually
     change the decision. Not everything the lanes said — only what the
     verdict hangs on.
   - Classify each: fact | inference | causal claim | forecast | value |
     authoritative constraint.
   - Wrong-layer guard: a true statement at a lower layer does not refute
     the proposition under debate. Pin "the proposition is: ___" before
     arguing; half of disputes end at this step.

5. **Single challenge round** (optional, max one exchange per proposition)
   - Challenger from a different model family than the proposition's source
     lane; same-family models share priors and blind spots.
   - Dissent must carry evidence; agreement is valid when evidence supports
     it. No invented dissent, no performative objection.

6. **Verdict** — you (the main agent) rule. No voting, no averaging
   confidence; seat count creates no authority. Lanes that participated do
   not audit the verdict. Escalate to the human anything involving product
   direction, irreversible trade-offs, or spend beyond the agreed budget.

7. **Report** — propositions + verdict + reopen conditions: what evidence
   would reopen this, and who owns that call.

## Hard rules

- Lanes never see each other's output and never see your framing.
- If lanes agree, that is a valid outcome. If they diverge, you reconcile and
  rule — do not average, and do not spawn a "tiebreaker" that has seen both
  framings unless you strip the framing out of its brief first.
- Forking yourself into a reviewer seat is not a third opinion: a fork of
  your session carries every biased thread you hold. Fresh session or none.
