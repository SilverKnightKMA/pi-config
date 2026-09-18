# pi-config — pi configuration dev bench

> **⚠️ Fresh install / hệ 2 repo:** repo này đơn lẻ KHÔNG chạy được — extension cần Paseo daemon + plugin bên [`paseo-plugins`](https://github.com/SilverKnightKMA/paseo-plugins). Cài từ đầu trên máy mới (Linux/macOS/Windows native): đọc [`setup/SETUP-PI.md`](setup/SETUP-PI.md) rồi [`setup/SETUP-PASEO.md`](https://github.com/SilverKnightKMA/paseo-plugins/blob/main/setup/SETUP-PASEO.md) — thiếu một trong hai là hệ không hoạt động.

Dev bench for extensions that run live under `~/.pi/agent/extensions/` (user-wide).

- `setup/` — hướng dẫn cài từ đầu (agent-facing, cross-OS) + sample config đã sanitize
- `extensions/` — dev tree (bun workspaces), each extension ships `*.test.ts`
- Tests: `bun test` · Typecheck: `bunx tsc -p tsconfig.json --noEmit`
- Sync to live: overwrite the matching directory in `~/.pi/agent/extensions/`
- History: split from the `learn` workspace (2026-08-31), all original commits kept
- (`pi-backup.tar.gz` — legacy backup, unrelated to this bench)
