# Audit #46 — Inventory (pi extensions + paseo plugins)

Step 1/6 of plan #46 (task #197). Machine-generated from the repo trees at HEAD (pi-config v1.4.123 @ cd1bf53, paseo-plugins v1.0.79 @ 69d54bd).

## pi-config `extensions/` — 17 extensions + 1 shared module

| # | unit | LOC (ts/tsx/js/py) | structure | runtime deps | entry |
|---|---|---|---|---|---|
| 1 | _shared | 1005 | shared module (no activate): doorbell pokes, doorbell server, lessons-core, continuation-driver, unattended |  | — |
| 2 | ask-user-question | 1073 | interactive question tool |  | index.ts |
| 3 | bash-long-run-guard | 163 | bash long-run guard + recipes |  | index.ts + src/ |
| 4 | facts | 2873 | facts tier: store, inject, recall, curator, projection |  | index.ts + src/ |
| 5 | goal | 1056 | goal engine: state, wake loop, proposal |  | index.ts + src/ |
| 6 | lessons | 235 | lessons injector (pure) |  | index.ts |
| 7 | md-log | 446 | markdown log writer |  | index.ts |
| 8 | observational-memory | 8477 | OM: agent worker (observer+consolidator via `pi -e`), guard, spawn, src | — | agent/index.ts (worker) + src/ |
| 9 | quiz | 1242 | graded quiz tool |  | index.ts |
| 10 | read-only-mode | 2104 | plan mode + plan bridge + wake driver |  | index.ts + src/ |
| 11 | snip | 793 | snippet injector + control |  | index.ts |
| 12 | sse-probe | 399 | SSE probe tool |  | index.ts |
| 13 | subagent-types | 7463 | spawn/pool/channel/safe-bash/gates |  | index.ts + src/ + *.ts |
| 14 | task | 5534 | task board + 3-tier verify + judge |  | index.ts + src/ |
| 15 | telemetry | 432 | heartbeat instance files |  | index.ts + src/ |
| 16 | visual-tools | 668 | write_mermaid/write_svg + render_* via chrome-headless-shell | @mermaid-js/mermaid-cli@^11.4.2 | index.ts + tools/ |
| 17 | web-fetch | 885 | URL fetch → markdown | @mozilla/readability@^0.6.0, linkedom@^0.18.13, turndown@^7.2.0, unpdf@^1.4.0 | index.ts + src/ |
| 18 | zombie-watchdog | 1503 | session watchdog |  | index.ts + src/ |

## paseo-plugins — 10 plugins

| # | plugin | LOC | structure | runtime deps | entry |
|---|---|---|---|---|---|
| 1 | agent-health | 1185 | timeline transformer + panel (system-error cards, markers) | — | index.client.tsx |
| 2 | lessons | 402 | lessons panel + timeline chip | — | index.client.tsx + server |
| 3 | memory | 936 | facts panel + doorbell + untombstone | — | index.server.ts + server/ |
| 4 | om-panel | 837 | OM topics panel | — | index.client.tsx + server/ |
| 5 | om-status | 1679 | OM status pill/panel + doorbell server owner | — | index.client.tsx + server/ |
| 6 | paseo-subagents | 3523 | subagent spawner MCP door + tokens/adopt/grant | — | index.server.ts + server/ |
| 7 | plan | 1131 | plan panel + control bridge + doorbell poke | — | index.client.tsx + server/ |
| 8 | snip | 1365 | snip panel + control + doorbell | — | index.client.tsx + server/ |
| 9 | subagent-reply | 974 | reply_to_parent door for children | — | index.server.ts + server/ |
| 10 | task | 2250 | task panel + judge cards + control + doorbell | — | index.client.tsx + server/ |

## Fleet facts (probed, not re-derived here)

- Test containers: pi-config baseline 1014/0 tests; paseo-plugins baseline 196/0.
- Test environments: container (this box, /home/coder), hcm10 = Ubuntu 24.04 root@hcm10.tayra-owl.ts.net (HOME=/root, no node/bun preinstalled), Windows = Administrator@192.168.10.160 (Server 2019 17763, PS 5.1, ACP 1252, git+tar, no node/bun). No macOS — static column only.
- Shared-file discipline: `doorbell-server.ts` + `doorbell-poke.ts` synced across owner plugins via `check-shared-ui.py`; `titles.ts` synced across 5 plugins (the `PI_HOME ?? HOME ?? '/home/coder'` fallback ships in 5 copies).

## Per-unit static verdict rollup (from matrix.md)

| unit | worst verdict | blocking assumptions for non-container envs |
|---|---|---|
| pi-config/_shared | adapt | env-HOME, signals, unix-socket |
| pi-config/ask-user-question | portable-caveat | — |
| pi-config/bash-long-run-guard | adapt | signals |
| pi-config/facts | adapt | env-HOME, signals |
| pi-config/goal | portable | — |
| pi-config/lessons | adapt | signals |
| pi-config/md-log | portable (no hits) | — |
| pi-config/observational-memory | adapt | env-HOME, fwdslash-build, signals |
| pi-config/quiz | portable (no hits) | — |
| pi-config/read-only-mode | portable | — |
| pi-config/snip | adapt | env-HOME, hardcoded-home |
| pi-config/sse-probe | adapt | env-HOME, hardcoded-home |
| pi-config/subagent-types | adapt | env-HOME, fwdslash-build, signals |
| pi-config/task | adapt | env-HOME, fwdslash-build, signals, unix-socket |
| pi-config/telemetry | adapt | env-HOME, signals |
| pi-config/visual-tools | adapt | env-HOME, hardcoded-home, signals |
| pi-config/web-fetch | portable (no hits) | — |
| pi-config/zombie-watchdog | portable | — |
| paseo-plugins/agent-health | portable | — |
| paseo-plugins/lessons | portable | — |
| paseo-plugins/memory | adapt | env-HOME, unix-socket |
| paseo-plugins/om-panel | adapt | env-HOME, hardcoded-home |
| paseo-plugins/om-status | adapt | env-HOME, hardcoded-home, unix-socket |
| paseo-plugins/paseo-subagents | portable-caveat | — |
| paseo-plugins/plan | adapt | env-HOME, hardcoded-home, unix-socket |
| paseo-plugins/snip | adapt | env-HOME, hardcoded-home, unix-socket |
| paseo-plugins/subagent-reply | portable | — |
| paseo-plugins/task | adapt | env-HOME, hardcoded-home, unix-socket |
