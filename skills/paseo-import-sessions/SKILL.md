---
name: paseo-import-sessions
description: Bulk-import provider session transcripts (pi, omp, codex, opencode, copilot, claude, factory-droid) into Paseo as real agents. Use when setting up a new machine for Paseo, migrating history from CLI-only tools, backfilling after the daemon was installed late, or cleaning up empty/junk agents created by a bad import run.
---

# Paseo Import Sessions

Tri thức từ chiến dịch import thật 2026-09-18→09-20: ~2600 session, 974→995 agent sau audit,
126 agent rỗng dọn tay. Mọi con số và gotcha dưới đây đã trả giá trên store thật.

## Nguyên tắc nền

1. **Import = metadata + con trỏ.** `paseo import` chỉ tạo record agent (~1KB) với
   `persistence.sessionId` trỏ file gốc của provider — KHÔNG copy transcript. File provider là
   dữ liệu thật: **cấm xóa**; xóa file gốc = view hội thoại chết, chỉ còn vỏ metadata.
2. **Luật chung: session CÓ nội dung thì phải vào paseo.** Chỉ 4 nhóm dưới đây được skip.
3. **Subagent chưa import thì PHẢI import rồi archive ngay — KHÔNG bỏ** (chỉ thị user 2026-09-19).
   Subagent spawn sau thời MCP luôn live rồi (đi qua `paseo_create_agent`, có label
   `subagent.role`/`subagent.parent`); chỉ subagent pre-MCP sót trên đĩa — nhận biết: user-message
   đầu tiên là role prompt (vd "You are a research specialist...") hoặc delimiter `\n---\nTASK:\n`.
   Import với `--label subagent.role=<role>` rồi archive NGAY qua MCP `paseo_archive_agent`.

## Bảng chính sách 4 lớp (skip duy nhất)

| Lớp | Nhóm | Lý do skip | Tự tăng? | Kiểm chứng |
|---|---|---|---|---|
| 1 | **OM worker** (pi, dir `.memory-*`) | Worker nhất thời của observational-memory; tri thức đã hợp nhất vào `.memory/` topic files | CÓ — mỗi turn OM | `ls ~/.pi/agent/sessions/ \| grep memory-` |
| 2 | **Judge mới** (dir `--judge--/` + registry `~/.pi/agent/judge-sessions.jsonl`) | Verifier one-shot done-check: đọc log → PASS/FAIL → chết; marker first-class từ pi-config v1.4.101 | CÓ — mỗi done-check | `tail ~/.pi/agent/judge-sessions.jsonl` |
| 3 | **Copilot hàng rỗng** (sqlite `~/.copilot/session-store.db`) | 0 turns toàn bộ — byproduct handshake/health-check | CÓ | `SELECT COUNT(*) FROM turns` per session |
| 4 | **OMP observer-review** (subdir `<ts>_<uuid>/`) | Artifact nội bộ OMP (`observerPlanReview/observerResultReview.jsonl`), không phải session; session omp thật là file `<ts>_<uuid>.jsonl` tầng trên | CÓ | glob `[0-9a-f-]{36}\.jsonl` lọc riêng |

**Ranh giới:** probe one-shot CÓ nội dung thì KHÔNG skip — import + archive như thường
(đã làm đủ: 5 omp stub, 6 codex, 8+19 pi). Judge CŨ (pre-v1.4.101) cũng import+archive,
chỉ judge MỚI mới skip.

## Nguồn file theo provider

| Provider | Đường dẫn session | Ghi chú |
|---|---|---|
| pi | `~/.pi/agent/sessions/<cwd-slug>/*.jsonl` | bỏ `.memory-*`, `--judge--/` |
| omp | `~/.omp/agent/sessions/*.jsonl` + subdir observer-review | chỉ file uuid.jsonl tầng trên |
| factory-droid | `~/.factory/sessions` | xem gotcha vỏ ACP |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | glob recursive; chạy QUA paseo thì không có rollout |
| claude | `~/.claude/projects/<slug>/` | |
| opencode | `opencode.db` sqlite | |
| copilot | `~/.copilot/session-store.db` sqlite | chỉ hàng 0-turn mới được skip |

## Quy trình dựng queue (offline trước, RPC sau)

1. **Scan file + phân loại OFFLINE** (isdir/isfile check bằng python, không gọi daemon) —
   mỗi RPC import đều tốn; queue sai tốn gấp đôi để dọn.
2. **Lọc hasConversation/nhiều-dòng khi build queue từ scan đĩa.** App picker của paseo lọc
   session rỗng, nhưng import CLI theo `sessionId` KHÔNG lọc — session abort/auth-crash 1-dòng
   sẽ thành agent rỗng trong list (bài đắt nhất: 126 agent fd rỗng).
3. **Đọc cwd từ chính JSONL** (grep `"cwd":"..."` ở head file) rồi `mkdir -p` lại cwd gốc:
   `pi import` hỏi tương tác "Fork this session?" khi `--cwd` khác cwd gốc và abort non-interactive.
4. Queue dạng TSV `provider<TAB>sessionId<TAB>cwd` → import loop với throttle `sleep 2`,
   log vào `~/` (không `/tmp`), chạy nền `setsid nohup` (CLI `paseo send`/import block term).
5. Import trùng daemon tự chặn ("already imported") — loop an toàn, không cần dedupe tay.
6. Classifier thành công phải grep `AGENT ID` (bảng in hoa) — grep 'Agent'/'created' trượt.

## Gotcha vận hành

- **503/1006 transient khi daemon bận**: không parallelize; retry cuối là đủ. Throttle 2s an toàn
  (throttle 1s từng bẻ container một lần ở store 2600).
- **Import ACP (fd) sinh vỏ file**: paseo mở probe session tạm → droid persist eager → mỗi lượt
  +1-2 vỏ `session_start`-only ~194B. Khi audit đếm file PHẢI lọc vỏ (<2KB, 1 dòng) kẻo thấy
  "sót ảo". (Skeleton issue upstream: `learn/fd-shell-leak-issue-proposal-2026-09-20.md`.)
- **Agent rỗng sau import dở**: CLI `paseo archive` không với agent closed ("Agent not found") —
  dùng MCP `paseo_archive_agent`.
- **Codex qua paseo không ghi rollout** (chỉ CLI trực tiếp ghi): codex chạy trực tiếp = cần
  import; chạy qua paseo = đã live.

## Tài sản để dùng lại

- `~/bulk-import/` (máy nguồn): run3.sh (classifier 'AGENT ID', throttle 2s), chuỗi 3 pha fd,
  retry chain, offline pre-classification.
- Báo cáo đầy đủ: `learn/report-import-project-2026-09-20.md` (inventory + §3b + bài học).
- SETUP-PASEO.md mục "Chính sách import 4 lớp" (bản rút cho setup máy mới).
