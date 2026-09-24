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

## harness-eval cache dir hardcode máy này (2026-09-24)

repo: pi-config · mở: 2026-09-24 · nguồn: self-eval vòng 2 #295

crawl.py:24 `CACHE = Path.home()/"workloads"...` — chính xác: `Path.home()/"workspaces"/"learn"/"harness-eval-cache"` — chỉ đúng máy có workspace learn.

**Trigger làm:** chạy skill trên máy khác / image đổi workspace layout. **Hướng:** env `HARNESS_EVAL_CACHE` override, hoặc cache đặt cạnh skill dir.

## anomaly_report.py — từ SET ASIDE sang CÔNG CỤ ĐẦU TIÊN khi có sự cố call/lỗi (2026-09-24)

repo: pi-config · mở: 2026-09-24 · nguồn: self-eval #302 (SET ASIDE) → **đã kiểm chứng sống cùng ngày**

Vấn đề gốc: trigger cũ "lần incident đầu tiên" là trigger chết — sự cố call-lỗi đã xảy ra nhiều (#277, stale wake, matrix HANG...) mà không lần nào chạy script, vì phải *nhớ ra nó tồn tại*.

**Kiểm chứng 2026-09-24** (chạy thật, 7 ngày): bắt ngay cluster SSE-drop `cli-openai` 22-23/09 (z=4.0–6.7), **183/458 drop trong ±5' trước session abort** (cause→symptom), zombie spike 101 lần 18/09 (z=15.9), 2 judge-session empty-stop-turn kèm session id. Toàn bộ là các sự cố user đã gặp ngoài đời.

**Trigger mới (operational):** mọi sự cố loại *call lỗi / session abort bất thường / agent treo / im lặng chết / cost spike* → chạy `anomaly_report.py` TRƯỚC khi grep tay. Deterministic, bounded, ~giây.

**Còn thiếu (làm khi mở lại):** chưa có trong luồng ghi sse-probe/zombie-watchdog của các extension mới; cân nhắc cron hằng ngày in mục "Act now" nếu user muốn theo dõi chủ động.
