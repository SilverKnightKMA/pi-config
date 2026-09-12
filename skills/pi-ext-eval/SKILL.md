---
name: pi-ext-eval
description: Quy trình chuẩn 3 chế độ để nghiên cứu pi extension - LANDSCAPE quét họ ext trong và ngoài @pify, EVAL đánh giá code-first một ứng viên port, SYNC-UPSTREAM kiểm tra upstream đã port có tiến bộ gì. Use khi user muốn đánh giá/mượn/port một pi extension, quét xem bên ngoài có gì tương tự, hoặc khi dependabot witness PR cho biết upstream đã nhích version.
source: self-designed (pattern đóng băng từ 5 lần eval 2026-09-08→12)
packaged_as: original
---

# pi-ext-eval — quy trình nghiên cứu extension 3 chế độ

Hai file đồng hành (cùng pack, đã sync về `~/.pi/agent/`):
- `docs/upstream-registry.md` (pi-config) — sổ nguồn gốc mọi mảnh đã port: extension ↔ upstream ↔ ref đã port ↔ lần kiểm cuối ↔ cơ chế theo dõi. **Truth cho chế độ 3.**
- `docs/ext-eval-index.md` (pi-config) — bảng verdict mọi lần eval + pointer tới brief đầy đủ ở workspace nghiên cứu. **Mọi verdict mới ghi 1 dòng vào đây.**

Nguyên tắc xuyên suốt (rút từ 5 lần chạy thật):
1. **Code-first** — mọi kết luận phải trích được từ tarball/repo THẬT (download + đọc source + diff version). Cấm phán theo README/changelog.
2. **So với hệ hiện có** — câu hỏi duy nhất: gap gì so với pi-config extensions của mình? Trùng → BỎ, dù đẹp mấy.
3. **User quyết** — verdict của researcher chỉ là đề xuất; port/mượn/bỏ luôn chờ user chọn.
4. **Ghi vết** — brief về workspace nghiên cứu (learn/), verdict về `ext-eval-index.md`, nguồn gốc port về `upstream-registry.md`.

---

## Chế độ 1 — LANDSCAPE (họ extension: "bên ngoài có gì?")

Khi user hỏi "có ext tương tự nào không / bên ngoài làm thế nào", hoặc đợt quét định kỳ.

1. **Xác định họ** theo chức năng (task/todo, memory, goal/autonomy, subagent, plan, context-compaction...).
2. **Quét 3 vòng**:
   - npm: `npm search` / web_search `pi extension <họ> npm`, scope `@pify/*`, tên `pi-*`, tác giả quen (amosblomqvist, pifydev, tintinweb, @arhen...).
   - GitHub: search `<họ> pi extension`, check orgs pifydev + amosblomqvist + kết quả mới.
   - **Harness khác** (xu hướng nảy sinh ở đây rồi mới có port pi): Claude Code docs/changelog, Codex, opencode — cho họ này họ làm gì, cơ chế gì.
3. **Bảng so sánh**: mỗi ứng viên 1 hàng — tên / ★-tuổi / license / cơ chế 1 dòng / khác gì hệ mình / verdict đề xuất.
4. **Checklist phán xét 6 câu** (mọi ứng viên):
   - License sạch? (AGPL⚠, no-license⚠ = loại trừ khi port)
   - TUI-only? (widget/surface không có trong Paseo daemon → vô dụng trừ khi mượn concept)
   - Xung đột doctrine? (single-writer, disk-is-truth, memory-guard, safe_bash, managed-tools — như pify/cli tự update)
   - Trùng cái mình đã có? (so extensions/ pi-config + bảng ext-eval-index)
   - Độ trưởng thành? (tuổi, số release, test suite, ai dùng)
   - Chi phí tích hợp? (phụ thuộc gì, đụng extension nào, cần daemon version nào)
5. Đề xuất verdict từng cái + tổng quan hướng của họ. Ghi vào `ext-eval-index.md` phần landscape.

## Chế độ 2 — EVAL (một ứng viên: "đáng không?")

Khi user chọn một package để đánh giá sâu. Pattern đã chạy 5 lần (task, workflow, swarm, plan-mode, goal):

1. **Thu thập thật**: `npm pack <pkg>` hoặc clone repo → đọc toàn bộ source. Nếu có diff version (`0.6.0 → 0.6.2`): tarball cả hai, diff thật, tóm tắt thay đổi từng bước version.
2. **Viết brief** theo template cố định (output ~15-20KB, workspace nghiên cứu `learn/pify-<tên>-eval-YYYY-MM-DD.md`):
   - **TL;DR** — verdict đề xuất + 2-3 câu lý do.
   - **Cơ chế thật** — trích code: cấu trúc dữ liệu, event hooks dùng, luồng chính, biên an toàn. Ghi rõ số dòng/file.
   - **Bảng gap** — từng mảnh upstream cung cấp SO VỚI hệ mình: cái nào trùng (cái nào mạnh hơn của mình), cái nào gap thật.
   - **Chi phí + rủi ro tích hợp** — đụng extension nào, double-owner gì, điều kiện daemon/pi version.
   - **Đề xuất port/mượn/bỏ** — mảnh hóa cụ thể, kèm phương án rẻ nhất nếu có.
   - **Giới hạn nguồn** — cái gì chưa kiểm chứng được (không chạy live, không test suite, version có thể đã đổi).
3. **Researcher độc lập** viết brief (spawn researcher, model rẻ + web tools); kick nếu idle mà chưa nộp.
4. Đưa user quyết: **PORT** (đem cả cơ chế về, thích nghi hệ mình) / **MƯỢN** (mảnh lẻ concept) / **BỎ** (trùng/xung đột) / **ĐỂ DÀNH**.
5. Ghi verdict vào `ext-eval-index.md`. Nếu port/mượn: thêm dòng `upstream-registry.md` TRƯỚC khi trộn code.

## Chế độ 3 — SYNC-UPSTREAM (đã port: "upstream có tiến bộ gì?")

Khi: workflow `upstream-drift` mở/cập nhật issue `[upstream-sync] <name>` (label `upstream-sync`),
hoặc đợt quét thấy SHA upstream đổi so cột ref trong registry.
Lưu ý: KHÔNG có dependabot witness PR cho ext đã port — code port nằm trong pi-config,
bump version không cài gì cả; issue là tín hiệu duy nhất (user chốt 2026-09-12).

1. Mở `upstream-registry.md` tìm dòng tương ứng → ref cũ.
2. **Diff thật** ref cũ → mới (tarball hai version hoặc `git diff` hai SHA). KHÔNG đọc changelog thay diff.
3. **Mini-brief ~10 dòng**: đổi gì / lý do tuyên bố / có chạm vùng ta đã port hoặc vùng ta đã tự phát triển vượt không / có mảnh xứng mang về không / đề xuất.
4. Ba kết cục:
   - **Không đáng** → cập nhật cột "lần kiểm cuối" + ref mới. Xong.
   - **Đáng mượn mảnh** → đề xuất user → nếu duyệt, tạo task port (quay lại chế độ 2 cho mảnh đó).
   - **Upstream lùi** (breaking, đổi triết lý) → ghi cảnh báo vào registry + index.
5. Lưu ý vùng "tự thiết kế vượt upstream" (như verify 3 tầng của task): upstream thêm gì ở vùng đó không tự động thắng — so chất, không so sự có mặt.

---

## Từ vựng verdict (dùng thống nhất)

| Thuật ngữ | Nghĩa |
|---|---|
| PORT | đem cơ chế về pi-config, thích nghi (không cài package) |
| MƯỢN / BORROW PIECES | lấy concept/mảnh lẻ, triển lại theo hệ mình |
| BỎ | trùng cái có sẵn, hoặc xung đột doctrine/an toàn |
| ĐỂ DÀNH / DEFERRED | đáng nhưng chưa đến lúc; ghi index + ngày |
| drift-issue | workflow upstream-drift mở issue khi upstream ≠ ref-đã-port; tự đóng khi registry cập nhật — cơ chế cho ext ĐÃ PORT |
| witness-deps | devDeps pin cho 2 external cài thật (pi-mcp-adapter/pi-web-access) — dependabot bump = nâng cấp thật, KHÔNG dùng cho ext đã port |
| tự thiết kế vượt | vùng ta phát triển xa hơn upstream (vẫn ghi registry để so) |

## Bản đồ gap đã biết (cập nhật khi landscape mới)

- Continuation có hướng đích (goal anchor qua compaction) — @pify/goal đã eval, chờ user
- "Lessons that stop a repeat" (memory tường minh) — @pify/memory để dành
- pre-image NOTE + recovery-record undo (yolo) — việc #25
- Cross-session file-lock task scope (tintinweb) — hoãn theo part 5 swarm
