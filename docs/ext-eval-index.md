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
| 2026-09-12 | **anthropics/sandbox-runtime** (họ bash-safety, do user chỉ định) — chạy đầu tiên chế độ LANDSCAPE; **verdict sửa cùng ngày theo user: môi trường chạy không gắn với pack** | `learn/sandbox-runtime-eval-2026-09-12.md` — MƯỢN CONCEPTS + ADOPT srt làm TẦNG TÙY CHỌN KHẢ CHUYỂN: 3 mảnh text-level cho safe_bash mọi môi trường (mandatory-deny write list + write-allowlist theo role + thông điệp kiểu deniedDomainReasons) + mảnh 4 detect-delegate-fallback `bashSandbox: auto\|srt\|off` — container hiện tại auto→text-guard, host Windows/Linux/macOS không-container auto→OS-sandbox |

| 2026-09-12 | **LANDSCAPE họ bash-safety ngoài srt** (spawn_pool 4 researcher) | `learn/landscape-bash-safety-2026-09-12.md` — 13 ứng viên: **PORT 1** (opencode-bash-guard — text-tier AST segmentation + substitution lồng + fail-closed + redirect-path, nâng cấp trực tiếp thay 16 regex) · MƯỢN/BỎ phần còn lại · phụ: tree-sitter guards, LlamaFirewall classifier liền kề |
| 2026-09-12 | **LANDSCAPE họ memory ngoài @pify** | `learn/landscape-memory-2026-09-12.md` — 13 gói npm + 4 harness + 3 trục kiến trúc: **PORT 0 · CANDIDATE 2** (pi-hermes-memory: correction-detector regex 2 lớp + content-scanner + failure target; @fradser/pi-memory: plan→validate→apply có receipt/hash) · MƯỢN 2 (recovery/undo pi-memory; not-extract policy @samfp) · Claude Code auto-memory hội tụ đúng thiết kế 3 lớp của mình |
| 2026-09-12 | **LANDSCAPE họ goal ngoài @pify** | `learn/landscape-goal-2026-09-12.md` — **PORT 0 · CANDIDATE 1** (pi-goal-x 0.31.2 MIT: checkpoint-marker + disk-persist restart-resume + backoff ladder 5→80s + delegated-guard — 4 mảnh NGOÀI @pify/goal) · MƯỢN 3 (stop_hook_active+hard-cap 8+quota_auto_resume Claude Code; paused-stays-paused Codex; loop-break abort+resume opencode) · BỎ 7 (2 vì AGPL cấm port code) |
| 2026-09-12 | **LANDSCAPE Paseo plugin bên thứ ba** | `learn/landscape-paseo-plugins-2026-09-12.md` — thị trường non nhưng sống: ~40 repo/~50 plugin trong ~3 tuần, đa số MIT; pattern chuẩn monorepo cá nhân + `plugin add --path`; rủi ro source-only unsandboxed chạy cạnh daemon |

## Đã quét landscape xong (2026-09-12)

4 họ nợ trong mục cũ đã quét trọn bằng spawn_pool 4 researcher (brief ở learn/, verdict
chi tiết ở bảng trên): bash-safety ngoài srt · memory ngoài @pify · goal ngoài @pify ·
Paseo plugin bên thứ ba.

Còn nợ deep-eval (chế độ 2, chờ user chọn):
- pi-goal-x (CANDIDATE — eval sâu 4 mảnh ngoài @pify/goal; đối chiếu song song với
  decision @pify/goal đang treo)
- pi-hermes-memory + @fradser/pi-memory (CANDIDATE — đan xen @pify/memory part 2 user
  đã để dành; hermes chỉ đáng eval mảnh handler vì store MEMORY/USER.md trùng)
- opencode-bash-guard (PORT đã chốt trong brief — chờ lệnh build cùng 4 mảnh
  sandbox-runtime: mandatory-deny + role allowlist + thông điệp + tầng srt tùy chọn)

Vẫn chưa từng quét (mở mới nếu cần):
- họ plan/todo ngoài @pify (plan-mode đã mượn nhưng chưa quét hàng xóm)
- họ context-compaction ngoài OM của mình
- plugin/hook cho harness khác xem như nguồn mượn pattern (đã chạm qua các brief riêng)
