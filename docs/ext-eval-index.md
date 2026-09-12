# Ext-eval index — bảng verdict mọi lần đánh giá ext pi

> Truth một chỗ cho verdict (kèm `docs/upstream-registry.md` là sổ nguồn gốc).
> Brief đầy đủ (15-20KB) nằm ở workspace nghiên cứu `learn/`; hàng ở đây chỉ giữ
> verdict + lý do 1 dòng + pointer. Quy trình chạy: skill `pi-ext-eval` (3 chế độ:
> landscape / eval / sync-upstream).

## Bảng tổng 15 package @pify (quét 2026-09-07, đóng băng)

| Package (verdict lúc quét) | Verdict cuối | Ghi chú ngắn |
|---|---|---|
| task 0.3.0 | **PORTED** v1.4.19-24 | DAG + evidence-gate; verify 3 tầng là phần tự thiết kế vượt upstream |
| plan-mode 0.4.2 | **BORROWED** v1.4.31 | concepts vào read-only-mode: plan file, parseSteps, control-file approve |
| workflow 0.9/0.10 | **BORROWED PIECES** v1.4.30 | resume/gate/pending → spawn_pool + queue |
| swarm 0.6.0 | **BORROWED (đổi cơ chế)** v1.4.30 | queue + expect-gate; child-mechanism giữ spawn_subagent |
| goal 0.6.2 | **PORT (có chọn lọc) — CHƯA build** (eval 2026-09-12) | chỉ continuation driver; completion-gate yếu hơn verify 3 tầng → không port |
| memory | **ĐỂ DÀNH** (user 2026-09-10) | "lessons that stop a repeat" đáng xem sau; brief riêng ở learn/ |
| worktree 0.3.0 | **DEFERRED vô hạn** | vô giá trị dưới single-writer cho tới khi có agent song song thật |
| subagent 0.10.0 | BỎ — trùng | subagent-types là siêu tập (channel, NACK, deferred-kick, auto-ping) |
| ask-question 0.3.0 | BỎ — trùng | pi harness có ask_user_question native |
| todo 0.2.0 | BỎ — trùng | trùng built-in todo (lưu ý: pi thuần KHÔNG có todo — cái này do lớp Paseo/omp) |
| usage 0.5.0 | BỎ — trùng | om-status panel + .runs/*.cost.json phủ |
| btw 0.3.0 | BỎ — TUI-only | không có bề mặt widget trong daemon |
| pretty 0.4.0 | BỎ — TUI-only | Paseo app tự render timeline |
| cli 0.4.0 | BỎ — xung đột | pi self-update trong container = vi phạm thiết kế 3 tầng managed-tools |
| yolo 0.8.0 | BỎ — xung đột an toàn; **MƯỢN 1 mảnh** | pre-image NOTE + recovery-record undo → việc #25 (doc, chưa làm) |

## Đánh giá sâu (brief code-first, researcher độc lập)

| Ngày | Chủ đề | Brief | Verdict |
|---|---|---|---|
| 2026-09-08 | task ext + tổ tiên (tintinweb 199★ / eleqtrizit / nczz / pi-goal-x / mjasnikovs-AGPL) | pify-pending Part 1 | port giữ nguyên; answer 6 câu mở của user trong pending |
| 2026-09-09 | @pify/workflow 0.9/0.10 | `learn/pify-workflow-eval-2026-09-09.md` (19.4KB) | (b) MƯỢN PIECES → đã ship v1.4.30 |
| 2026-09-09 | @pify/swarm 0.6.0 | `learn/pify-swarm-eval-2026-09-09.md` (16.1KB) | (b) MƯỢN đổi child-mechanism → đã ship v1.4.30 |
| 2026-09-09 | @pify/plan-mode 0.4.2 | `learn/pify-planmode-eval-2026-09-09.md` (17.5KB) | 3-stage BORROW → đã ship v1.4.31 |
| 2026-09-09 | @pify/memory + LLM-as-judge | `learn/pify-memory-research-2026-09-09.txt` (55KB) | để dành; hướng D = Agent-as-a-Judge → cơ sở layer-2 judge |
| 2026-09-12 | @pify/goal 0.6.2 (diff 0.6.0→0.6.2) | `learn/pify-goal-eval-2026-09-12.md` (17.5KB) | PORT có chọn lọc (4 mảnh) hoặc mượn rẻ 20 dòng — CHỜ USER |
| 2026-09-12 | @pify/task 0.3.0→0.3.2 (sync issue #22, chế độ 3 đầu tiên) | diff trong mini-brief session | KHÔNG ĐÁNH PORT — chỉ extract sweepStep pure-function + docs polish, truth table không đổi |

## Nghiên cứu nền ngoài @pify

| Ngày | Chủ đề | Verdict |
|---|---|---|
| 2026-08-30 → 09-06 | Tác giả Eero Alvar (amosblomqvist): 6 repo, 6 quan điểm thiết kế, transcript ~150KB | gốc của snip/OM/subagent; snip backend byte-identical; divergence audit 3 chủ ý |
| 2026-09-05 | so sánh snip port vs prompt-snippets upstream tại f82da56 | byte-identical + 3 lệch chủ ý (persistence, sticky, control-file) |
| 2026-09-08 | dòng pi-tasks 3 nhánh + npm ext lạ (pi-goal-x, @arhen needs-edges, mjasnikovs AGPL⚠) | landscape họ task; license disqualifier ghi nhận |

## Chưa từng quét landscape (nợ hiện tại)

- họ memory ngoài @pify (pi-memory*, third-party)
- họ goal ngoài @pify (pi-goal-x đã thấy lướt, chưa deep)
- họ plugin-market Paseo của bên thứ ba (ngoài 5 plugin của mình)

→ lần chạy landscape đầu sẽ xử các dòng này theo skill `pi-ext-eval` chế độ 1.
