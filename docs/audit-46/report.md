# Audit #46 — Final report: environment + model-provider independence

Plan #46, steps 1-6 complete (tasks #197-#202). Scope: 17 pi-config extensions + `_shared` + 10 paseo plugins. Fleet: container (baseline), hcm10 Ubuntu 24.04 (HOME=/root, bun 1.4.2), Windows Server 2019 (Administrator, bun 1.4.2 zip, autocrlf=true, symlinks=false), macOS static-only (no machine).

Artifacts: `inventory.md` · `matrix.md` (static 578 findings + runtime sections) · `findings-raw.tsv` · `hcm10-results.md` · `windows-results.md` · `provider-audit.md` · reproducible `scan.py`.

## 1. Full matrix — unit × environment (100% coverage)

| unit | container | hcm10 | windows | macOS (static) |
|---|---|---|---|---|
| _shared | PASS | PASS | FAIL-1t (0600 mode assert) | portable-caveat (unix-socket, chmod) |
| ask-user-question | PASS | PASS | PASS | portable |
| bash-long-run-guard | PASS | PASS | PASS (tests) | portable-caveat (setsid/nohup recipes POSIX-only) |
| facts | PASS | PASS | FAIL-1t (separator assert) | portable |
| goal | PASS | PASS | PASS | portable |
| lessons | PASS | PASS | PASS | portable |
| md-log | PASS | PASS | PASS | portable |
| observational-memory | PASS | FAIL-0t (all OM tests pass; repo-level E2BIG/launch fails are windows-only) | **FAIL-6t** — 2 RUNTIME: backslash paths written into memory index + sessionId split('/') breaks; 4 spawn/argv | portable-caveat (spawn, separator) |
| quiz | PASS | PASS | PASS | portable |
| read-only-mode | PASS | PASS | PASS | portable |
| snip | PASS | PASS | PASS | portable-caveat (/home/coder fallback tail) |
| sse-probe | PASS | PASS | PASS | portable-caveat (zaicp-specific diagnostic) |
| subagent-types | PASS | PASS | **FAIL-4t** (2 CRLF fixtures + 2 bare-`mkdir` spawn) | portable-caveat (execFile paseo, MODEL_ALIASES) |
| task | PASS | PASS | FAIL-1t (separator assert; HOME itself fine) | portable-caveat |
| telemetry | PASS | PASS | PASS | portable |
| visual-tools | PASS | PASS | PASS (chrome-headless-shell absent → graceful) | portable-caveat (puppeteer cache path, HOME fallback) |
| web-fetch | PASS | PASS | PASS | portable |
| zombie-watchdog | PASS | **FAIL-1t** (readdirSync order) | PASS | portable |
| pi-config repo gates | 1014/0 + tsc + smoke 16/16 | 1013/1 + tsc 14/14 + smoke 16/16 | 1000/14 + tsc 14/14 + **smoke FAIL** (bare `bun` spawn) | — |
| agent-health | PASS | PASS | PASS | portable |
| lessons-plugin | PASS | PASS | PASS | portable |
| memory | PASS | PASS | PASS | portable-caveat (unix-socket doorbell) |
| om-panel | PASS | PASS | PASS | portable-caveat |
| om-status | PASS | PASS | PASS | portable-caveat (unix-socket) |
| paseo-subagents | PASS | PASS | PASS | portable-caveat (roles model default) |
| plan-plugin | PASS | PASS | **BROKEN-INSTALL** (git symlink → ENOTDIR → TSC-FAIL) | **gãy** (symlink needs privilege/macOK) |
| snip-plugin | PASS | PASS | PASS | portable-caveat |
| subagent-reply | PASS | PASS | PASS | portable |
| task-plugin | PASS | PASS | PASS | portable-caveat (unix-socket) |
| plugins repo gates | 196/0 + tsc | 196/0 + tsc 10/10 | 196/0 + tsc **9/10** | — |

## 2. Risk ranking

### [GÃY THẬT TRÊN MÁY TEST]
1. **plan-plugin install broken on Windows** — `plan/node_modules` is the repo's ONLY git-tracked symlink (`120000` → `../task/node_modules`); Windows Git checks it out as a plain file → `bun install ENOTDIR` → tsc unresolvable. Repo-level fix needed.
2. **OM runtime bugs on Windows (2)**: memory index rendered with `\` separators into file content (`renderIndexFile`); v2.2 sessionId extraction `split('/')` returns whole Windows path → two-session isolation logic breaks. (Found by tests; runtime code, not test-side.)
3. **Smoke gate dead on Windows**: `smoke-extensions.mjs` spawns bare `"bun"` → ENOENT when bun isn't on PATH (we run it by absolute path).
4. **Windows 14 test failures / hcm10 1** — full root-cause tables in `windows-results.md` §A-E and `hcm10-results.md` (separators ×5, bare spawns ×5, 0600 ×1, CRLF ×2, argv ×1, readdirSync-order ×1).

### [ADAPT CẦN CODE]
- `MODEL_ALIASES` (subagent-types:382-385) hardcodes zaicp/glm targets.
- Path-separator string building in runtime code (template literals with `/`).
- Bare-name spawns: `execFile("paseo")`, `resolvePiBinary` PATH fallback (`pi` → .cmd problem), smoke script.
- `$HOME ?? ""` chains (facts/lessons-core) and `?? "/home/coder"` fallback tails (titles.ts ×5 plugins, snip, sse-probe, visual-tools) — no-op wherever HOME is set, wrong on HOME-less Windows.
- POSIX 0600 assertions + setsid/nohup recipes (bash-long-run-guard teaches POSIX-only patterns).

### [PORTABLE-CÓ-CAVEAT]
chmod no-op on NTFS · fs.watch backend variance (non-recursive = fine) · symlink privilege (Win/mac dev-mode) · LF parsing vs CRLF · capability-tag `[T]/[V]/[XL]` models.json convention · 3 pinned model DEFAULTS (all overridable; OM heterogeneous fleet live-proves the override path).

## 3. Provider axis — PASS (with 4 findings)

Dynamic full swap proven: new provider entry → different endpoint (`llm.tungvuthanh.com/v1`) + different model (`zaicp/glm-5.2`) → `pi -p` real call `PROVIDER46-OK` exit 0, config restored. Same service verified 200 from all 3 machines. Details + findings table: `provider-audit.md`.

## 4. macOS static column

No Linux-only syscall in runtime code (no /proc, no inotify flag, no gosu); home anchoring via os.homedir present everywhere it matters; unix sockets + fs.watch + signals all native on macOS. Expected portable — runtime confirm deferred until a Mac joins the fleet.

## 5. Proposed fix tasks (AUDIT-ONLY plan — user approves opening these separately)

| # | fix | effort |
|---|---|---|
| F1 | Replace plan/node_modules symlink (real install or bun workspace) — unblocks Windows plugin dev/test | S |
| F2 | Separator sweep: sessionId split(/[\\/]/), renderIndexFile join for OUTPUT strings, path assertions via path.join in tests | M |
| F3 | Spawn hardening: smoke script uses process.execPath; document `pi`/`paseo` PATH-vs-.cmd caveat for Windows | S |
| F4 | Test hygiene: sort() readdirSync lists; CRLF-proof fixtures (add .gitattributes `* text=auto eol=lf` for *.ts or assert normalized); skip 0600-mode assert on win32 | S |
| F5 | MODEL_ALIASES → settings-driven; consider one `defaults.models` settings block for judge/OM/roles defaults | M |
| F6 | Docs: [T]/[V]/[XL] tag convention; sse-probe labeled diagnostic; Windows-prep note (bun on PATH or absolute path) | S |

## 6. Gate self-check

- report.md + matrix.md cover **28/28 units × 3 runtime environments + macOS static** (matrix.md runtime sections + §1 above). ✓
- Risk ranking ordered gãy > adapt > caveat. ✓
- Provider axis answered with a real swap test. ✓
- Fix proposals listed for user decision. ✓
