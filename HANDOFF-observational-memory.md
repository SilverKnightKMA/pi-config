# Handoff: port observational-memory qua Paseo

> Session mới bắt đầu từ đây. Đọc kỹ file này trước khi hỏi user bất cứ gì — mọi quyết định đã chốt bên dưới là final, không mở lại.

## Bối cảnh 1 dòng

Workspace `learn` đã port toàn bộ repo amosblomqvist (pi-config, learn, pi-subagents) sang môi trường Paseo. **observational-memory là item cuối cùng** — chưa quyết cài/bỏ, nhưng user đã yêu cầu chuẩn bị để xử lý ở session mới (nghiêng về làm).

## Môi trường đã setup (đừng cài lại)

- Paseo daemon 0.6.1 (bản riêng, KHÔNG tự restart — user tự làm, restart sẽ giết session agent đang chạy; đây là quy tắc đã được nhắc 3 lần)
- pi 0.84.4 tại `/home/coder/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/` (binary chuẩn `bin/pi`)
- Project trust đã có: `~/.pi/agent/trust.json` chứa `/home/coder/workspaces/learn`
- Extensions chạy tại `.pi/extensions/` (dev copies + tests ở `extensions/` — 2 chiều luôn đồng bộ bằng cp)
- Test runner: bun test; typecheck: `bunx tsc --noEmit -p tsconfig.json` (mỗi ext có tsconfig với `allowImportingTsExtensions: true`, types `bun-types`); symlink deps tại `~/workspaces/learn/node_modules/@earendil-works/*`
- **Pi RPC thực tế**: spawn `pi --mode rpc` + stdin JSONL để smoke test không cần daemon (xem `extensions/ask-user-question/smoke-rpc.ts` làm mẫu)

## Nguồn observational-memory

- Upstream: https://github.com/amosblomqvist/pi-observational-memory (đã clone sạch tại `/tmp/ext-audit/pi-observational-memory` — 609 dòng src + tests vitest + PLAN.md chi tiết)
- README đọc kỹ trước: observer subprocess → observations → ledger branch-local → deterministic compaction → consolidator → `.memory/<sessionId>/` topic files + INDEX.md + JOURNEY.md
- Cấu hình namespace `observational-memory` trong settings.json; on/off gate `/om`; commands `/om:status|compact|consolidate`

## Phân tích khả thi đã làm (từ session này)

| Khía cạnh | Kết luận |
|---|---|
| Cơ chế chính | Event-driven (`turn_end`, `agent_start`) + spawn pi subprocess (`-e` worker extension, `OM_WORKER=observer\|consolidator`) + ghi file `.memory/` — **không phụ thuộc ui.custom**, chạy được headless |
| UI bị mất | Widget gauges (observer/consolidator/context progress), footer cost `$x.xxx` — chết dưới RPC như mọi extension khác đã gặp |
| notify() | **Bị daemon drop khi turn đang chạy** (bug đã verify: `bufferNoTurnOutput` return sớm nếu `activeTurnStarted`). `/om:status` dùng notify → cần đổi kênh nếu muốn hiện trên Paseo timeline |
| Compaction trigger | `agent_end`/idle — hoạt động qua RPC |
| Worker subprocess | pi spawn con trong `.memory/<sessionId>/.runs/` — độc lập với UI, ổn |
| Điểm cần chú ý | Worker là "ordinary recorded pi session" trong `~/.pi/agent/sessions` — sẽ xuất hiện trong paseo-analyzer (đánh dấu internal để không đếm nhầm cost?) |

## Quy ước port đã chốt với user (áp dụng cho mọi ext — TUÂN THỦ)

1. **Logic gốc giữ nguyên tối đa** — chỉ thay tầng giao tiếp host (UI methods, binary wiring). Result format cho model không đổi.
2. **UI-layer RPC-safe only**: `select/input/editor/notify`. KHÔNG dùng `ui.custom()` (stub no-op dưới RPC).
3. **Feedback cho user khi turn đang chạy**: KHÔNG dùng notify (bị drop) — dùng `pi.sendMessage({customType, content, display:true})` → hiện trên Paseo timeline (pattern đã verify trong snip: `📝 Snippets armed/applied`).
4. **Không side-channel đọc file hệ thống thay vì đi qua Paseo** (user đã từ chối cách đọc `models.json` trực tiếp — thông tin phải đến từ nguồn thống nhất).
5. **Descriptions model-visible không chứa giải trình** (no "fork of", "port of", "RPC-safe", "pi 0.84 note") — chỉ hành động cần làm. Code comments thì thoải mái.
6. **Không trust model tự build payload** — extension tự điền mọi thứ (labels, provider string, thinking). Caller chỉ được chọn trong khung extension cho phép.
7. **Agent chỉ việc gửi** — retry/queue/Busy-handling là việc harness/extension, không trả lỗi về model để model tự xoay.
8. **Tool names**: .md pin đúng tên sống (không alias + map). Nếu tool không mount mặc định (pi 0.84 chỉ có read/bash/edit/write) → re-register từ SDK factory (`createGrepTool/FindTool/LsTool` — xem `subagent-types/readonly-tools.ts` làm mẫu).
9. **Workflow test bắt buộc**: unit (bun test) → RPC smoke (`pi --mode rpc` scripted) → E2E qua Paseo thật (`paseo agent run --label "subagent.role=main"` — chú thích: agent tạo qua bash-tool trong session agent có parent-agent-id → bị floor; agent WebUI/agent test user thì main). Sau E2E: dọn agent test (`paseo delete`).
10. **Kill pi process cũ trước khi test ext mới** (`ps aux | grep " pi$"`) — extension chỉ load lúc process khởi động. KHÔNG restart paseo daemon trừ khi user bảo.

## Bug Paseo đã biết (cần remember khi debug, đỡ mất giờ)

- `notify()` drop mid-turn (đã nói ở trên)
- `getInputQuestionTitle`: placeholder chứa "optional"/"skip" → title bị ghi đè thành "Optional response" (quiz đã dính — fix: đổi placeholder)
- multiSelect hardcode `false` trong `buildExtensionUiQuestionPermission`; `readActiveAskUserDialog` đọc `allowMultiple` rồi vứt
- pi provider **không có steerActiveTurn** → mọi "steer" đến pi đang streaming qua send_agent_prompt thực chất là interrupt+replace (abort + rerun turn). Lưu ý khi OM observer spawn cần kết quả tức thì
- Prompt RPC timeout 30s (`JSONL_RPC_DEFAULT_TIMEOUT_MS`) — slash command nhiều dialog tuần tự phải trả lời nhanh
- Daemon restart làm agent đang chạy kẹt "Pi RPC process is closed" — chỉ sửa bằng restart daemon tiếp theo

## Việc cần làm (session mới)

1. **Quyết định với user**: cài nguyên bản + patch tối thiểu (notify→sendMessage), hay port sâu. Khuyến nghị từ session cũ: **cài gần nguyên bản** vì core không đụng UI nhiều; chỉ thay:
   - `/om:status` output → timeline message (kênh sendMessage) + giữ text stdout cho headless
   - Widget gauges → 1 timeline message mỗi khi observer/consolidator hoàn tất (đã có pattern)
   - Cost footer → gộp vào message trên
2. Settings: thêm namespace `observational-memory` vào `.pi/settings.json` (project scope) hoặc `~/.pi/agent/settings.json` — đọc `src/config.ts` cho defaults; model observer/consolidator **map sang model máy này** (glm-5.3-flash cho observer, glm-5.3 cho consolidator — cùng triết lý role pins đã chốt: haiku→flash, sonnet→glm-5.3)
3. Workers spawn pi con với `-e` trỏ worker extension — verify path tuyệt đối hoạt động từ mọi cwd
4. Test theo workflow mục "Quy ước" điều 9
5. Đặc thù OM: observer subprocess là **session pi thật** → sẽ lọt vào `paseo_cost.py` (đếm cost trùng). Kiểm tra `paseo_sessions.py::iter_agent_records` có lọc được theo label `internal` (record có field `internal: true` — xem `agent-loading.js` dùng `purpose: "history"`) và nếu cần thêm filter `--no-internal` cho analyzer

## Trạng thái các thành phần liên quan (đều XANH)

- subagent-types hoàn chỉnh (spawn 1-call + kênh 2 chiều message_subagent/message_main E2E pass) — OM không phụ thuộc nó
- paseo-analyzer 4 script tại `.pi/skills/analyze-sessions/scripts/paseo_*.py` — có thể cần cập nhật khi OM thêm sessions nội bộ
- md-log đang chạy — OM ghi `.memory/`, không đụng nhau
- Danh sách dev-copies tại `extensions/` phải sync `.pi/extensions/` sau mỗi thay đổi (không có auto-sync)

## Còn treo khác (ngoài OM) — nhắc user nếu quên

- 3+1 bug Paseo upstream chờ user duyệt rồi mới report (multiSelect hardcode / notify drop / title heuristic / pi thiếu steerActiveTurn). Evidence nằm trong phân tích session này; sẽ cần viết lại issue text vì session cũ không mang sang.
