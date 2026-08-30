# extensions/ — bố cục dev ↔ live

## Cấp 1: có dev copy trong `extensions/` (sửa ở đây → sync sang `.pi/extensions/`)

| Dev copy | Live | Nguồn gốc upstream |
|---|---|---|
| `subagent-types/` | `.pi/extensions/subagent-types/` | amosblomqvist/pi-subagents + roles/extensions từ amosblomqvist/learn; kênh 2 chiều + ask_question + registry là thiết kế riêng cho Paseo (semantics interactive-subagents) |
| `snip/` | `.pi/extensions/snip/` | amosblomqvist/pi-config (prompt-snippets) |
| `quiz/` | `.pi/extensions/quiz/` | amosblomqvist/learn (extensions/quiz.ts) |
| `ask-user-question/` | `.pi/extensions/ask-user-question/` | amosblomqvist/pi-config, fork có chủ đích |
| `observational-memory/` | `.pi/extensions/observational-memory/` | amosblomqvist/pi-observational-memory, port gần nguyên văn |

Sync: `cp extensions/<tên>/{*.ts,tests} .pi/extensions/<tên>/` — luôn chạy `bun test` trước khi sync.

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
