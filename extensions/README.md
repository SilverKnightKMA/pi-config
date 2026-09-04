# extensions/ — bố cục dev ↔ live

## Cấp 1: có dev copy trong `extensions/` (sửa ở đây → sync sang `.pi/extensions/`)

| Dev copy | Live | Nguồn gốc upstream |
|---|---|---|
| `subagent-types/` | `.pi/extensions/subagent-types/` | amosblomqvist/pi-subagents + roles/extensions từ amosblomqvist/learn; kênh 2 chiều + ask_question + registry là thiết kế riêng cho Paseo (semantics interactive-subagents) |
| `snip/` | `.pi/extensions/snip/` | amosblomqvist/pi-config (prompt-snippets) |
| `quiz/` | `.pi/extensions/quiz/` | amosblomqvist/learn (extensions/quiz.ts) |
| `ask-user-question/` | `.pi/extensions/ask-user-question/` | amosblomqvist/pi-config, fork có chủ đích |
| `observational-memory/` | `.pi/extensions/observational-memory/` | amosblomqvist/pi-observational-memory, port gần nguyên văn |

Sync (idempotent, sau sự cố 2026-09-04 — xem `sync-live.mjs`):

```bash
node extensions/sync-live.mjs            # sync mọi ext có dev copy
node extensions/sync-live.mjs snip quiz  # chỉ vài ext
```

Quy tắc chống tái phạm (hậu quả của lệnh cũ `cp {*.ts,tests}`):
- `rsync --delete` theo từng ext — không bao giờ `cp` vào dst đã tồn tại (gây lồng `x/x/`).
- `--exclude '*.test.ts' --exclude 'node_modules'` ở CẤP 1 live — loader quét `*.ts` cấp 1 + `*/index.ts`; file test cấp 1 làm pi chết (`bun:test` not found).
- Quan trọng: live LÀ `~/.pi/agent/extensions/` (không phải `.pi/extensions/` — bảng trên ghi theo workspace cũ, giữ lại làm tham chiếu lịch sử).
- Chạy `bun test` ở dev repo trước khi sync; sau sync chạy `pi -p "reply OK"` để xác minh loader sạch.

## Cấp 2: chỉ có bản live (package tự chứa, KHÔNG tạo dev copy)

| Live | Vì sao không có dev copy | Nguồn gốc upstream |
|---|---|---|
| `.pi/extensions/visual-tools/` | `node_modules` riêng (@mermaid-js/mermaid-cli + chrome) — nhân bản lãng phí; sửa trực tiếp bản live | amosblomqvist/learn (extensions/visual-tools) |
| `.pi/extensions/web-fetch/` | `node_modules` riêng (readability/linkedom/turndown) | amosblomqvist/pi-config (extensions/web-fetch) |
| `.pi/extensions/md-log.ts` | file đơn, không dependency — sửa trực tiếp | amosblomqvist/learn (extensions/md-log.ts) |

Quy ước cho cấp 2: sửa thẳng bản live, ghi chú nguồn gốc trong header comment (đã có), không tự sinh dev copy.

## Ghi chú quan trọng

- **Không ai sinh ra từ không khí**: mọi ext đều truy được nguồn ở repo tác giả (clone tham khảo từng ở `/tmp/ext-audit-2` — tạm thời, header từng file là nơi lưu vĩnh viễn).
- Header từng file ghi origin + quan hệ với công cụ lân cận (vd: web-fetch vs package `pi-web-access` trong `~/.pi/agent/settings.json`).

## Chặn tool cho main agent (2026-09-02)

`subagent-types` hỗ trợ deny-list cho **main agent** (mặc định rỗng — opt-in). Thêm vào `.pi/settings.json` của workspace (ưu tiên) hoặc `~/.pi/agent/settings.json` (mọi nơi):

```jsonc
{
  "subagentTypes": {
    "mainBlockedTools": ["safe_bash", "web_search", "web_fetch", "render_mermaid", "render_svg", "write_svg", "write_mermaid"]
  }
}
```

- Workspace thắng user-wide. Chỉ áp cho main — subagent role giữ allowlist riêng.
- Block được tái áp mỗi input nên tool đăng ký muộn vẫn bị lọc.
- Toast xác nhận số tool đã chặn khi có tác dụng thật (idempotent, không spam).
- KHÔNG nên chặn `spawn_subagent` / `message_subagent` / `message_main` — main sẽ mất đường giao tiếp với con.
