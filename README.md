# pi-config — pi configuration dev bench

> **⚠️ Fresh install / two-repo system:** this repo does NOT work on its own — the extensions require the Paseo daemon and the plugins in [`paseo-plugins`](https://github.com/SilverKnightKMA/paseo-plugins). To install from scratch on a new machine (Linux/macOS/native Windows), read [`setup/SETUP-PI.md`](setup/SETUP-PI.md), then [`setup/SETUP-PASEO.md`](https://github.com/SilverKnightKMA/paseo-plugins/blob/main/setup/SETUP-PASEO.md) — the system will not work if either is missing.

Dev bench for extensions that run live under `~/.pi/agent/extensions/` (user-wide).

- `setup/` — clean-install guide (agent-facing, cross-OS) + sanitized sample config
- `extensions/` — dev tree (bun workspaces), each extension ships `*.test.ts`
- Tests: `bun test` · Typecheck: `bunx tsc -p tsconfig.json --noEmit`
- Sync to live: overwrite the matching directory in `~/.pi/agent/extensions/`
- History: split from the `learn` workspace (2026-08-31), all original commits kept
- (`pi-backup.tar.gz` — legacy backup, unrelated to this bench)
