# Incident report — "extension changed without thorough testing → pi crash" (2026-09-15)

**Failure class:** named by the user and repeated many times. *"you code a pi extension,
make changes without thorough testing, and cause pi to crash, session id 01a093d5"*.
Most recently, the error persisted after restarting the daemon (17:34 UTC).

## Crash mechanism (confirmed in pi source)

pi loads every extension at session start. An extension fails to load → diagnostic
`Failed to load extension "<path>"` → **`process.exit(1)`** directly in
`dist/main.js`. The daemon sees the agent die → retries → **spawn storm** (3+ processes
within a few seconds; session 01a093d5 captured this on 2026-09-13 when a bisect
broke TS syntax). Restarting the daemon does not fix it because the error is in the
extension code, not the daemon.

## Previous test gap

642 tests covered pure modules (`src/*.ts`), but **not one test ever imported +
`activate()`d an `index.ts` file** — the exact layer of code pi executes on load.
CI stayed green even when an extension could not load at all.

## Four real bugs caught (all from v1.4.0, 2026-09-05 — silently broken for 10 days)

Commit v1.4.0 "absorb live-only extensions" added code to the pack without including
or declaring its dependencies:

| # | Extension | Error | Fix (zero-dep) |
|---|---|---|---|
| 1 | web-fetch | `import "typebox"` — undeclared and not installed | literal JSON schema |
| 2 | web-fetch | `@mariozechner/pi-tui` — obsolete package name | rename |
| 3 | web-fetch | `new Text` value import — cannot resolve from the installed tree | type-only + self-contained FallbackText |
| 4 | visual-tools | `@sinclair/typebox` — declared but never installed on the host | literal JSON schema, remove dependency |

## Misleading traps (found during verification)

1. **Repo tree masks the problem**: local node_modules (gitignored) + root node_modules
   resolve dependencies on its behalf → the repo smoke test passes while the host fails.
2. **Bun global cache masks the problem**: without node_modules, bun resolves bare
   imports from `~/.bun/install/cache` — a v1.4.71 clone (with broken code) still loads
   on a development machine with a warm cache. On a host with local node_modules that
   lacks the package → fallback is disabled → it actually fails. **A local pass is only
   trustworthy when it FAILS.**

## Preventive guardrails (three layers)

| Layer | Mechanism | When it runs |
|---|---|---|
| `extensions/extension-smoke.test.ts` | child-process import + `activate()` every extension with a stub | every `bun test` |
| `scripts/smoke-extensions.mjs <dir>` | smoke-load any tree (repo / host) | procedure: run against `~/.pi/agent/extensions` **before every daemon restart** after editing an extension |
| CI job `installed-tree-smoke` | fresh clone of PR HEAD, no install, smoke test with a cold cache — accurately models the host tree | every PR to main (including dependabot + auto-merge) |

Implementation: `smoke-one.mjs` runs activate with a chainable recording stub, then
explicitly calls `process.exit(0)` — timers/watchers started by activate() cannot
freeze the probe.

## Evidence

- v1.4.72: gate + fix bugs 1-2 · v1.4.73: fix bugs 3-4 (both extensions zero-dep)
- PR #201, #202 (agent-code-server-docker) merged; host installed
- Host verification: `ALL 13 EXTENSIONS LOAD CLEAN` on `~/.pi/agent/extensions`
- CI run 34975003936: both `test` + `installed-tree-smoke` succeeded
- Suite: 642/642 EXIT:0
