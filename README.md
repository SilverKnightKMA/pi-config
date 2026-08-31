# pi-config — xưởng phát triển cấu hình pi

Dev bench cho extensions chạy live ở `~/.pi/agent/extensions/` (user-wide).

- `extensions/` — cây dev (bun workspaces), mỗi extension có `*.test.ts`
- Test: `bun test` · Typecheck: `bunx tsc -p tsconfig.json --noEmit`
- Sync sang live: copy đè thư mục tương ứng trong `~/.pi/agent/extensions/`
- Lịch sử: tách từ workspace `learn` (2026-08-31), giữ nguyên mọi commit gốc
- (`pi-backup.tar.gz` — backup cũ, không liên quan bench)
