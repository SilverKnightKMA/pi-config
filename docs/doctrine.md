# System doctrine — one place, three sources

Every design decision in this repo should be checkable against this page. Three sources feed it:
the original author whose extensions we ported, the orchestration doctrine the user uploaded, and
the user's own standing decisions. When sources conflict, **the user's decisions win** (they are
newer and more specific); when something here conflicts with shipped code, the code wins until the
doc is updated — doc-drift is a bug either way.

Sources:
- **Author** — Eero Alvar (`amosblomqvist` / YouTube `@EeroAlvar`), synthesized from
  `research/eero-alvar-videos/` (16 transcripts, 2026-08-30 + 2026-09-15).
- **Doctrine** — "Quyết định vô chủ" (ownerless decisions), Paseo Foundation, 91-page PDF,
  uploaded 2026-09-05. Digest in workspace memory.
- **House rules** — the user's recorded decisions, 2026-09-04 → present (each with what shipped).

---

## 1. Author's philosophy (Eero Alvar)

Ported pieces must keep this shape unless a house rule overrides:

1. **Copy pieces, not packages.** The author's README says the repo is meant to be browsed and
   pieces copied — no big-package installs. Our ports stay source-level, credited in
   `docs/upstream-registry.md`.
2. **Minimal core.** "Everything beyond that is overhead at best and interference at worst."
   Short clean prompts, few tools; snips are mined from repeated instructions, not authored specs,
   and pruned when they stop earning their place.
3. **Deterministic, model-free where possible.** Deterministic compaction over LLM
   summary-of-summary decay; a safer bash command rather than asking the model to behave;
   file-system as the only carrier of state across runs; disk-is-truth with zero-ceremony hot
   reload (re-read at send time, no `/reload`).
4. **Total transparency.** No hidden context, no surprise model calls, no work the user cannot see.
   Instructions in messages, not bloated system prompts — "they have more weight when these kind
   of instructions are in the message and not the system prompt."
5. **Subagents = context hygiene.** Outsource token-heavy exploration to cheap isolated processes;
   each subagent is a markdown file, auto-discovered, depth-bounded; no central registry.
6. **Agent-human inequivalence.** "An agent system's analogousness to human processes is not
   indicative of agent results" — don't justify a design by "a human would do it this way."
7. **Premature automation warning.** Automate only after cumulative manual cost exceeds build cost;
   AI removed the expensive-build-cost filter, so validation comes first.
   Tool-polishing-as-procrastination is a real failure mode: build, use, move on.
8. **Ship early; instinct is a trained model.** (2026-09-08 video) Artifacts are recoverable —
   everything can be superseded — while time is not; perfectionism trades the irrecoverable to
   protect the recoverable. Instinct = a model trained on instant decisions; overthinking withholds
   training samples. Choose formats that structurally limit the vision-output gap.

## 2. Orchestration doctrine (Paseo Foundation)

The orchestration layer must obey these, independent of who wrote the code:

1. **Ownerless decisions are the root failure.** A binding decision made by something without
   authority or sufficient understanding. Every guard in this repo exists to route a decision to
   its right owner — usually the human.
2. **Roles:** Lead (final authority, framing, integration), Peer (independent session with
   REOPEN/DEPENDENCY/BLOCKED rights), Supervisor (watches attention and causes, does not decide),
   Human (purpose, edit/commit/push/deploy authority, budget).
3. **Three instruction layers:** persistent role profile → per-repo workspace protocol → bounded
   assignment/lease. Bounded means bounded: leases have scope, budget, and expiry.
4. **One writer, stable documents, evidence.** One writer owns a moving scope; reviewers inspect
   stable commits; tests and "finished" are not acceptance — evidence is.
5. **Events, not loops.** Work is woken by events, not polling. Polling that exists must justify
   itself or die.
6. **Plans are temporary restartable maps**, not pseudocode. Plan mode exists to be closed.
7. **Stop after the third patch to the same symptom** — escalate or redesign instead. Clear over
   clever. Record causes, not slogans. Grow workflow from evidence, G1→G5, not from ambition.
8. **Kernel/policy/recipes separation.** Workflows stay installable and replaceable; nothing
   workflow-shaped leaks into the kernel (engine extensions here). Presentation (Paseo plugins)
   never owns state.

## 3. House rules (user's standing decisions)

Each of these was explicitly decided by the user; overrides need a new decision, not an opinion:

- **Single-writer memory.** Only OM agents (observer, consolidator) decide memory content;
   everything else — including the main agent — is blocked by the harness (hard tool-call guard,
   not prompt rules). `memory-guard`.
- **Engines vs presentation.** Engines (hooks, interception, channel state, ledger writes) live in
   pi extensions inside pi's process; Paseo plugins are presentation only (panels, pills, cards).
   Never port an engine into the sandboxed plugin runtime.
- **Mode doors are user-only.** Plan mode and goal mode are OPENED by the user (`/plan on`,
   `/goal start`). The model cannot self-enter, self-propose out of draft, or write plan files
   outside active/awaiting modes (`planToolGate`, v1.4.70).
- **Regression test for every recurring bug.** When a bug class repeats, the deliverable is a
   regression gate, not just a fix: extension-smoke load gate (v1.4.72), bash-long-run-guard
   (v1.4.71), loop-guard, smoke-before-restart ritual.
- **Verify at query time.** Analysis code probes real data shape before parsing (`probe before you
   parse`). Never hand-roll parsers against assumed shapes.
- **Escape hatches have death dates.** Every env-variables override gets a review date
   (`docs/escape-hatches.md`); standing leases are re-granted explicitly, not inherited.
- **Mechanism first, blocking later.** Build the mechanism, default it off
   (`subagentTypes.mainBlockedTools` empty, guards opt-in), decide actual blocks separately.
- **Research before build when doctrine is the judge.** Eval candidates code-first
   (tarball + read source + diff versions; never README-only), user decides port/borrow/drop.
- **Sweeps distinguish open vs already-resolved.** Listing a fixed item as pending is a bug;
   retract cleanly.
- **Ship ritual.** Full suite green (EXIT:0) → tag → docker pin PR → host install → verify live.
   `'tiếp tục'` from the user is the phase-ship signal, not a request to rush.
- **Silent long commands run backgrounded up front** (nohup + /tmp log); never wait for the abort.
- **English in the three repos** (pi-config / paseo-plugins / docker); Vietnamese stays in chat.

## 4. Where the sources land on the same question

| Question | Author | Doctrine | House rule | What we do |
|---|---|---|---|---|
| Who writes memory | deterministic files | one writer, evidence | single-writer OM + hard guard | OM only, harness-enforced |
| Where engines live | minimal core | kernel/policy split | extensions = engine, plugins = UI | split as shipped |
| Who opens modes | (TUI-first human) | Human settles authority | user-only doors | planToolGate |
| Loops vs events | — | events not loops | — | wake loops budgeted, anti-spin 3, single-waker |
| Surprise model calls | never | — | — | OM budgeted, nothing else calls silently |
| Upstream debt | copy pieces, credit | — | drift-issue + real diffs | upstream-registry |

## 5. Using this doc

- New extension or guard design → check sections 1–3; name which rule it serves.
- A design that needs to break a rule → that's a user decision; present it as one.
- New user decision that generalizes → add a house-rule line with the date and what shipped.
- Author's or @pify/* upstream moves → SYNC-UPSTREAM mode updates the registry, and any
  philosophy-relevant change lands here too (this doc is the place upstream philosophy drift
  gets noticed — e.g. @pify/memory 0.9.2's opt-in observer converging toward our OM).
