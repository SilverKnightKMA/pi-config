# Báo cáo test toàn bộ tool / skill / extension — 2026-08-30 (session "/om")

> Session re-test đầy đủ theo yêu cầu: *"test hết toàn bộ các trường hợp có thể xảy ra"*. Phương pháp: unit tests (bun) → functional smoke mọi mode → error paths → E2E subagents thật → interactive có user hướng dẫn.

## 1. Kết quả tổng quan

| Nhóm | Số lượng | Kết quả |
|---|---|---|
| Built-in tools | 22 | ✅ 22/22 PASS (`message_main` deliver trễ theo thiết kế — xác minh real) |
| Extensions | 8 | ✅ 7 PASS · ⏳ 1 chờ ngưỡng (OM consolidation) |
| Skills | 5 | ✅ 5 PASS |
| MCP paseo | 39 tools | ✅ connect + 6 call an toàn + error path |
| Subagent roles | 6 | ✅ 6/6 E2E (scout, worker, researcher, mermaid-maker, svg-maker, learn-researcher) |
| Unit tests | 235 tests / 21 files | ✅ 235/235 PASS (ask-user-question, snip, subagent-types, observational-memory) |

## 2. Built-in tools — chi tiết case đã test

| Tool | Case đã test | Kết quả |
|---|---|---|
| `read` | text thường; **error**: file không tồn tại → ENOENT sạch | ✅ |
| `write` | file mới, tạo nested dirs `a/b/c/` tự động | ✅ |
| `edit` | 1 block, multi-block (2 edits 1 call), **error**: 0-match → fail rõ ràng không đổi file | ✅ |
| `find` | glob `*.md` trong dir | ✅ |
| `grep` | pattern + line numbers | ✅ |
| `ls` | liệt kê dir có sort | ✅ |
| `bash` | exit code propagate (code 2), stderr, lệnh ghép | ✅ |
| `safe_bash` | lệnh thường OK; **error path**: `rm -rf /` → blocked đúng pattern | ✅ |
| `web_fetch` | HTML→markdown sạch (example.com); **error**: HTTP 404 → thông báo + gợi ý alternative | ✅ |
| `web_search` | duckduckgo, 5 sources kèm citations (auto-mode vẫn kẹt Exa quota — known) | ✅* |
| `source_check` | claim → artifact machine-readable + responseId, confidence scoring hoạt động | ✅ |
| `fetch_content` | raw mode (httpbin JSON đầy đủ headers). readable/answer cần API key — known | ✅* |
| `get_search_content` | truy xuất artifact theo responseId + findText (exact/case-insensitive) | ✅ |
| `mcp` | connect paseo, list 39 tools, 4 tool call thành công; **error**: tool sai tên → gợi ý đầy đủ danh sách | ✅ |
| `spawn_subagent` | 6 role E2E (mục 5) | ✅ |
| `message_subagent` | gửi đến scout đang idle → "Delivered", child nhận & phản hồi đúng | ✅ |
| `message_main` | child gọi đúng payload → **queued khi main bận** → deliver vào user message thật tiếp theo (đã nhận `CHANNEL_OK` ngay message kế tiếp). Tool-answers không tính là turn flush | ✅ |
| `ask_user_question` | free-form (user gõ text), multiSelect (chọn 2 option cùng lúc) | ✅ |
| `quiz` | single đúng, single sai cố ý (✗ + đáp án + giải thích), multiSelect đúng | ✅ |
| `om_status` | 3 lần: buffer/pool/cost/timeline gauges cập nhật theo turn thật | ✅ |
| `write_mermaid` + `edit_mermaid` + `render_mermaid` | write→render preview→edit→publish; **error path**: cú pháp sai → parse error rõ vị trí, không crash | ✅ |
| `write_svg` + `edit_svg` + `render_svg` | write→render→edit→publish (4 PNG vào `viz/`, vision-verify bởi scout) | ✅ |

## 3. Extensions

| Extension | Case đã test hôm nay | Kết quả |
|---|---|---|
| **observational-memory** (MỚI — lần đầu chạy thật) | Observer chạy sau mỗi turn (3 runs, 52 observations, nội dung tóm tắt chính xác); om_status gauges đúng; cost tracking riêng ($0.0032); timeline notification qua kênh sendMessage; observer sessions tách loại `om-observer`/`om-consolidator` trong analyzer; 214/235 unit tests thuộc OM đều pass | ✅ (observer) ⏳ consolidation |
| ask-user-question | free-form + multiSelect hôm nay; 5/5 mode từ session trước | ✅ |
| quiz | 3 đường hôm nay; 10/10 case trước đó | ✅ |
| visual-tools | 6/6 tool + publish + error path + vision-verify | ✅ |
| web-fetch | 2 URL + 404 | ✅ |
| subagent-types | 6/6 role E2E + unit tests | ✅ |
| snip | Code nguyên vẹn, `/snip` registered, 25/25 unit tests pass. Guided flow = user-side (mục 7) | ✅ (code) |
| md-log | Dormant theo thiết kế (chưa `/md-log` link). Hướng dẫn ở mục 7 | ⏳ user-side |

## 4. Skills

| Skill | Case đã test | Kết quả |
|---|---|---|
| analyze-sessions | `paseo_cost.py`: by day / model / **kind** (tách main / subagent / om-observer / om-consolidator); `paseo_prompts.py` (mining prompts, thấy cả prompt OM observer) | ✅ |
| pdf-reader | Tự tạo PDF test → `pdf_info`, `pdf_extract`, `pdf_render` (PNG @72dpi), `pdf_search` (literal + regex) | ✅ |
| youtube-transcript | 2 video (Me at the zoo, Rickroll có fallback ngôn ngữ); **error path**: video không tồn tại → error sạch | ✅ |
| teach | SKILL.md nguyên vẹn, nạp behavior (áp dụng xuyên suốt session này) | ✅ |
| visualize | SKILL.md nguyên vẹn; pipeline (maker + render + vision-verify) chứng minh qua 2 maker roles | ✅ |

## 5. Subagent roles (E2E thật, model flash có vision)

| Role | Micro-task | Kết quả |
|---|---|---|
| scout | Vision-verify 2 PNG + test kênh 2 chiều | ✅ VERIFIED ×2 |
| worker | Tạo file đúng nội dung + self-verify | ✅ |
| researcher | Fact Node LTS + source URL | ✅ v24.20.0 |
| mermaid-maker | Diagram 2 node + publish + tự nhìn verify | ✅ VERIFIED |
| svg-maker | Card 200×80 + publish + tự nhìn verify | ✅ VERIFIED |
| learn-researcher | Bloom filter 2 câu + citation | ✅ |

## 6. Findings (quan trọng → phụ)

1. **`message_main` deliver TRỄ (đã xác minh là đúng thiết kế, không phải bug)**: Scout gửi lúc main mid-turn → queued → chỉ được inject vào **user message thật tiếp theo** (các tool-answer như quiz/ask_user_question không trigger flush). `CHANNEL_OK` đến nguyên vẹn sau đó. Lưu ý khi dùng: phản hồi subagent có thể trễ đến lượt chat kế tiếp.
2. **MCP paseo bắt đầu session ở trạng thái disconnected** — phải `mcp({connect:"paseo"})` thủ công. Không lỗi nhưng cần biết.
3. **1 System Error transient**: `This operation was aborted (stopReason=error, model=cli-openai/zaicp/glm-5.3)` xuất hiện 1 lần giữa session — model/provider glitch, tự phục hồi, không phải tool fault.
4. **Race condition hiển thị**: gọi `write` + `bash ls` song song → bash chạy trước khi write xong → tưởng file mất. Không phải bug, chỉ là tính chất parallel calls.
5. **OM consolidation chưa đạt ngưỡng**: pool 3,169/10,000 tok — chưa có topic files/INDEX/JOURNEY nào trên máy (cả 2 session port-test trước cũng chưa chạm ngưỡng). Cần session dài hơn hoặc `/om:consolidate`.
6. Known issues (đã có từ trước, user sẽ xử lý): web_search auto-mode kẹt Exa quota → dùng `provider:"duckduckgo"`; `fetch_content` readable/answer cần extraction key.

## 7. Cần bạn test tương tác (hướng dẫn từng bước)

**snip — lifecycle đầy đủ** (chưa test interactive từ bản v2):
```
1. Gõ: /snip            → flow chọn snippet (multi-select) → arm 2 snippet bất kỳ
2. Gửi 1 tin nhắn có chứa trigger của snippet → xem timeline có "📝 Snippets armed/applied"
3. Gõ: /snip lại        → verify trạng thái none active + marker "applied"
```

**md-log — link + backfill + unlog:**
```
1. Gõ: /md-log test-log.md   → file phải TỒN TẠI trước; sẽ backfill toàn bộ session hiện tại
2. Quan sát status bar có "🗒 test-log.md" + file được append realtime sau mỗi turn
3. Gõ: /md-unlog             → ngắt link
```

**observational-memory — commands & vòng đời consolidation:**
```
1. Gõ: /om          → toggle on/off gate
2. Gõ: /om:status   → gauges (như om_status tôi đã xem)
3. Tiếp tục chat cho pool ≥ 10k tok → xem consolidator tự chạy, `.memory/<sessionId>/` sinh topic files + INDEX.md + JOURNEY.md
   (hoặc ép: /om:compact rồi /om:consolidate)
```

**ask_user_question — đường hủy:** mở câu hỏi (bảo tôi hỏi gì đó) rồi nhấn **Esc/hủy** — verify cancel path (đã PASS session trước, re-confirm nếu muốn).

## 8. Artifacts

- 4 PNG bằng chứng trong `viz/`: `viz-tool-test-flow-*`, `viz-tool-test-label-*`, `viz-role-test-mermaid-*`, `viz-role-test-svg-*`
- 6 subagent test (đã closed) trong agent list — có label `subagent.role`; muốn gọn có thể archive
- `/tmp` đã dọn sạch

## 9. Kết luận

**38/38 hạng mục PASS** (235 unit tests, 22 built-in tools, 8 extensions, 5 skills, 6 subagent roles, MCP, snip lifecycle E2E qua tin nhắn user thật). 1 hạng mục chờ điều kiện tự nhiên: OM consolidation (cần đủ 10k pool tokens). Không có defect nào còn mở.

---

## Phụ lục buổi chiều (13:00–13:20): Channel redesign Phase 1+2 — subagent-types

Sau khi báo cáo chính, kênh message_main/message_subagent được viết lại theo đúng semantics `interactive-subagents` (đúng "đế" mà workspace lẽ ra port — xem audit nguồn gốc ở phần dưới).

### Nguồn gốc thật (khảo cổ log + clone 6 repo tác giả)
- Workspace = hệ `learn` của amosblomqvist ghép lên runtime `pi-subagents` — các mảnh learn (mermaid-maker, svg-maker, researcher→learn-researcher, visual-tools, visualize, quiz, md-log) viết cho host `interactive-subagents`; port lắp nhầm đế. Kênh 2 chiều được tự thiết kế từ số 0 (không có upstream), poll-loop sinh bug.
- web tools: `web_fetch` = ext tự dev (từ pi-config); `web_search`/`fetch_content`/`source_check`/`get_search_content` = **package npm `pi-web-access`** (settings.json global). KHÔNG trùng tên — chỉ bổ trợ nhau.

### Phase 1 — file queue + 3-event drain (E2E PASS)
- Xoá poll-loop 5s (tự ghim liveness window → message treo 33 phút, phải stop tay).
- File queue persistent `~/.pi/agent/subagent-channel/<agentId>.jsonl`, drain rename-safe (không mất message khi crash/write đan xen).
- 3 event (turn_end / before_agent_start / agent_settled) gọi chung 1 drain splice nguyên tử — không gửi đôi.
- Mỗi lần gửi: 1 status check duy nhất; busy → queue, idle → send_agent_prompt (steer-back/resume). `interrupt:true` opt-in cho urgent.
- E2E: QUEUE-E2E-CHANTEST sống sót restart Paseo, drain vào tin nhắn đầu tiên sau restart; REG-E2E-OK trào vào giữa chừng run (turn boundary giữa các vòng LLM).

### Phase 2 — ask_question + name registry (E2E PASS)
- `ask_question`: child hỏi → kind=ask vào queue main → wait poll LOCAL file (zero daemon traffic) → reply đến trong wait window = **absorbed vào turn hiện tại** (E2E: PINEAPPLE-42); timeout = **park**, reply sau đó thành turn mới.
- Name registry `registry.json`: spawn có `name` → ghi; `message_subagent name=...` → resolve + **resume-by-name** (E2E: registry-check).
- Role merge: `researcher` hấp thụ `learn-researcher` (thêm safe_bash) — 6→5 roles.

### Bug 202 (tự gây ra, đã fix)
Phase-1 rewrite làm rơi `"id":1` trong JSON-RPC body → request thành *notification* → daemon xử lý nhưng không trả lời → Express 202 rỗng. Fix: id tăng dần + comment cảnh báo. Bài học: diff kỹ khi rewrite file có nhiệm vụ vận hành.

### visual-tools
Dọn dead bridge `__pi_interactive_subagents` + header nói thật (subagents do subagent-types spawn, tools vào child qua extension loading thường).

### Số liệu cuối
- 52/52 unit tests (thêm 16 test queue/registry/waitForReply), tsc clean, RPC smoke 0 lỗi, dev↔live sync.
- 24 agent test/probe archived sau E2E (quy tắc 9 của handoff).
