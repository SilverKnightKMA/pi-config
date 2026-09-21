# Audit #46 — hcm10 runtime results (step 3/6)

Environment: Ubuntu 24.04.2 LTS, kernel 6.8.0-138-generic, glibc 2.39, HOME=/root, ext4 root fs, bun 1.4.2 (~/.bun user-local), repos @ pi-config fc668d0 + paseo-plugins 69d54bd. Ran 2026-09-22 (~19:35Z).

## Verdict summary

| repo | test | tsc | smoke | verdict |
|---|---|---|---|---|
| pi-config | **1013 pass / 1 fail** / 2508 expect (1014 tests, 79 files) | 14/14 OK | **ALL 16 EXTENSIONS LOAD CLEAN** (bun-run) | 1 test-side env assumption (below) |
| paseo-plugins | **196 pass / 0 fail** / 496 expect (196 tests, 19 files) — identical to container baseline | 10/10 OK | — | clean |

## The 1 failure — real environment assumption found

`extensions/zombie-watchdog/zombie-watchdog.test.ts:522` — `#107 A: termination funnel... > turn lifecycle funnels to exactly one reason per turn`:

```ts
const files2 = readdirSync(join(dir, "runs")).filter((f) => f.endsWith(".json"));
const rec2 = JSON.parse(readFileSync(join(dir, "runs", files2[1]), "utf8"));
expect(rec2.reason).toBe("shutdown");   // Received: "completed"
```

- Root cause: the test relies on **unsorted `readdirSync()` ordering** = file-creation order. Container overlayfs happens to return creation order; hcm10 ext4 returns hash order → `files2[1]` is the FIRST turn's record (`completed`) instead of the second (`shutdown`).
- Classification: **test-side ordering assumption** (`adapt` — fix is `.sort()` before indexing). Runtime funnel code itself is order-independent (writes both records correctly; only the assertion picks by index).
- Deterministic on hcm10 (failed identically in full-suite + isolated run).

## Per-unit lines (feeds matrix.md step-6 report)

All 17 extensions + _shared: **PASS on hcm10** except:
- `zombie-watchdog` — FAIL (test): `zombie-watchdog.test.ts:522` readdirSync-order assumption; first error `Expected "shutdown" / Received "completed"`.

All 10 paseo plugins: **PASS on hcm10** (196/0, tsc clean).

## Observations (non-blocking)

- One plugin `bun install` printed `ENOENT ... node_modules` (transient; everything green afterward — likely bun racing dir creation on fresh clone).
- `bun scripts/smoke-extensions.mjs` runs under bun (script normally node-run in container) — no node present on hcm10; loaded all 16 clean.
- Different HOME (/root) exercised the home-anchored paths — no failure attributable to HOME anchoring (matches static verdict: `/home/coder` fallback tails never fire when HOME set).
