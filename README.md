# pi-config — pi configuration dev bench

Dev bench for extensions that run live under `~/.pi/agent/extensions/` (user-wide).

- `extensions/` — dev tree (bun workspaces), each extension ships `*.test.ts`
- Tests: `bun test` · Typecheck: `bunx tsc -p tsconfig.json --noEmit`
- Sync to live: overwrite the matching directory in `~/.pi/agent/extensions/`
- History: split from the `learn` workspace (2026-08-31), all original commits kept
- (`pi-backup.tar.gz` — legacy backup, unrelated to this bench)
