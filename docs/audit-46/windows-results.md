# Audit #46 — Windows runtime results (step 4/6)

Environment: Windows Server 2019 (17763), PS 5.1, Administrator@192.168.10.160:22 (key auth, sshd 9.8p2 service), bun 1.4.2 at `C:\Users\Administrator\audit-46\bun.exe` (zip, NOT on PATH), Git for Windows 2.51 (`core.autocrlf=true`, `core.symlinks=false`), ACP 1252, HOME=C:\Users\Administrator (set by bun/SSH), repos @ pi-config fc668d0 + paseo-plugins 69d54bd. Ran 2026-09-22 (~19:40Z). All commands via base64 `-EncodedCommand` (PS 5.1 quoting-safe).

## Verdict summary

| repo | test | tsc | smoke | extra cases |
|---|---|---|---|---|
| pi-config | **1000 pass / 14 fail** / 2493 expect (1014 tests) | 14/14 OK | **FAIL** — `Bun.spawnSync(["bun",...])` ENOENT | CRLF: autocrlf converted **328 worktree files**; MAX_PATH: **no risk** (longest path 124) |
| paseo-plugins | **196 pass / 0 fail** / 496 expect | **9/10** — plan TSC-FAIL (no deps: install broken) | — | plan install **ENOTDIR** (repo symlink, below) |

## The 14 failures — root-cause groups (all real environment assumptions)

### A. Path separator `\` vs `/` — 5 tests (RUNTIME code affected in 2)
| test | evidence |
|---|---|
| `factsFilePath env override wins` (facts/src/store.test.ts) | `Expected "/h/.pi/agent/facts.md"` / `Received "\h\.pi\agent\facts.md"` |
| `launch argv > resolves run paths under .runs` (OM spawn.smoke) | `Expected "/proj/.memory/sess-1/.runs"` / `Received "\proj\.memory\sess-1\.runs"` |
| `renderIndexFile/renderMemoryMap` (OM memory.paths) | **runtime output**: index file contains `` `.memory\sess-1\auth.md` `` (backslash paths written INTO the memory index on Windows) |
| `om timeline sink v2.2 — two sessions never stomp` (OM status-file) | `Expected "sess-1"` / `Received "C:\...\omv2sess-fvwrFR\.memory\sess-1"` — **runtime**: sessionId extracted by splitting on `/` breaks on Windows paths |
| `taskStatusPath lands under ~/.pi/agent/task-status` (task/index.test.ts) | `AssertionError: bad path: C:\Users\Administrator\.pi\agent\task-status\abc123.json` (HOME resolves correctly — separator assertion fails) |

### B. Spawn bare-name binaries (`bun`, `pi`, `mkdir`) not on PATH / no .exe resolution — 5 tests
| test | evidence |
|---|---|
| `extension load smoke` (extension-smoke.test.ts) | `error: Executable not found in $PATH: "bun" code ENOENT` |
| `E2BIG regression > pipes >128KB via stdin` (OM spawn) | spawn of pi fails (not on PATH) |
| `E2BIG regression > stdin ignored` (OM spawn) | same |
| `findDoorUrlForAgent > finds <agentId>.json across subdirs` | test helper spawns `mkdir` → `Executable not found: "mkdir"` |
| `findDoorUrlForAgent > null for missing record...` | same |
| `scripts/smoke-extensions.mjs` (gate itself) | `Bun.spawnSync(["bun", smoke-one.mjs])` at :54 → ENOENT |

### C. POSIX permission-bit assertion — 1 test
| test | evidence |
|---|---|
| `doorbell-server real round-trip` (_shared) | `statSync(path).mode & 0o777` expects `0o600` — Windows has no POSIX mode bits (chmod no-op) |

### D. CRLF-converted fixtures — 2 tests (plan step-4 case 1: **YES, CRLF breaks fixtures**)
| test | evidence |
|---|---|
| `file queue > torn tail line dropped` (subagent-types channel.test.ts) | `toEqual` diff Expected -3 / Received +1 — multi-line string fixtures in CRLF-converted source carry `\r` |
| `name registry > corrupt registry file` (same file) | `toEqual` diff Expected -1 / Received +7 |

### E. argv content assertion — 1 test
| test | evidence |
|---|---|
| `launch argv > builds the headless yt-edit-style flag set` | `Expected: true / Received: false` — argv contains Windows-form paths |

## Plan-plugin install failure — repo-level symlink (step-4 hard finding)

`paseo-plugins/plan/node_modules` is a **git-tracked symlink** (mode `120000` → `../task/node_modules`, the only symlink in either repo — a Linux-only dep-sharing trick):
- **Windows**: `core.symlinks=false` (default, no Developer Mode) checks it out as a plain FILE containing `../task/node_modules` → `bun install` fails `ENOTDIR: could not open the "node_modules" directory` → tsc unresolvable → **TSC-FAIL plan** (only red tsc on either machine).
- **hcm10**: symlink works; its earlier one-off `ENOENT` during per-plugin install was the SAME symlink resolving before `task/node_modules` existed (install order), self-healed once task installed.

## Notes

- HOME anchoring itself WORKS on this box (HOME set by bun/SSH) — the static scan's `env-HOME` adapt class did not fire here; the fires were separators/spawns/modes/CRLF.
- `bun test` cross-drive path handling and the PS remoting CLIXML stderr wrapping are noise, not failures.
- pi-config tsc 14/14 OK and paseo-plugins 196/0 pass prove the TypeScript toolchain + pure logic are Windows-clean; the damage concentrates in (a) separator string-building, (b) bare-name spawns, (c) POSIX mode assertions, (d) CRLF fixtures, (e) the one repo symlink.
