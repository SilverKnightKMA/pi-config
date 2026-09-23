# BACKLOG — deferred problems & candidates (moved from task board 2026-09-21)

Not dropped — parked HERE so future sessions can see what problems exist without
them cluttering the live task board. Promote an item back to a board task (or just
start working it) when its trigger fires. Owner: main agent + user.

## B1. spawn_pool phase 4 — self-selected roles (was #23)

- **Problem:** pool children get roles assigned by the parent; phase 4 would let each
  child read its task and pick its own role (scout/researcher/worker).
- **Why deferred:** fixed 4-role pools work fine; no observed pain from manual assignment.
- **Open when:** pools get large enough that hand-assignment becomes the bottleneck,
  or mixed-probe tasks where role choice per item matters.

## B2. @pify/worktree Part 7 — write fan-out isolation (was #26) — PROMOTED CANDIDATE

- **Problem:** parallel writing subagents share one working tree; overlapping file edits
  can conflict. Git worktree per child + merge-back would isolate them.
- **Why it matters NOW (user ruling 2026-09-21):** the translation fan-out (3 workers
  writing 2 repos simultaneously) proved write fan-out is real usage; it was safe only
  because files were partitioned by hand.
- **Open when:** next fan-out where write targets overlap or can't be cleanly partitioned.
  User explicitly flagged this as close to usable.

## B3. Free image-search setup (was #38, direction changed by user 2026-09-21)

- **Goal:** working image search skill, **free to set up**. Not necessarily self-hosted
  or open-source — free hosted APIs are fine ("được việc của mình là được").
- **How:** run the pi-ext-eval LANDSCAPE scan (skills/pi-ext-eval) over image-search
  options (web-search providers with image mode, free-tier APIs, existing pi skills).
- **Open when:** user wants image search; method is decided (eval first, no API-key wait).

## B4. Upstream issue draft — cancel-ack 2000ms + replace-or-error (was #50)

- **Problem:** daemon acknowledges cancelled commands after 2s and queues instead of
  erroring when the command was replaced. Draft issue text ready in
  `learn/fd-shell-leak-issue-proposal-2026-09-20.md` (same family) + notes in memory.
- **Open when:** user wants to contribute upstream issues.

## B5. Upstream registry multi-origin + drift workflow (was #84)

- **Problem:** registry rows support a single source; want multi-origin per row
  (npm + github + fork) plus a per-source drift check comparing upstream progress
  vs our port.
- **Open when:** a ported extension actually has 2+ sources worth tracking or drift
  incidents appear (e.g. dependabot-witness PRs on several origins).

---

*Related parked board items that stay on the board (user decisions pending): none —
this file only absorbs deferred/no-trigger work. Decision tasks awaiting user stay on
the board by design.*

## Moved from harness-eval SKILL.md known-gap map (2026-09-24, backlog rule #285)

- [repo: pi-config] "Lessons that stop a repeat" (explicit memory) — @pify/memory evaluated, SET ASIDE. Trigger to revisit: recurring repeat-mistakes the lessons tier demonstrably fails to stop.
- [repo: pi-config] pre-image NOTE + recovery-record undo (yolo) — old eval item #25. Trigger: next yolo-mode work.
- [repo: pi-config] Cross-session file-lock task scope (tintinweb) — deferred with swarm part 5. Trigger: when swarm multi-agent work resumes.
- (deleted, resolved: directed-continuation goal anchor — goal extension shipped through v1.4.80+; row was stale)
- [repo: pi-config] Watch pi-vetter (closest eval-family cousin, security-only vetting) as reference — NOT adopted. Trigger: when eval volume grows enough that security vetting needs deeper checks than the 2-check pre-filter (ADR 0003).
