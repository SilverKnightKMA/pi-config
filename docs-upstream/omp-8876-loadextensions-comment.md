# Draft comment — oh-my-pi issue #8876 (post after review)

Target: https://github.com/can1357/oh-my-pi/issues/8876
Status reference: closed as duplicate; the per-module onLoad rewrite cost is
still reproducible on 18.0.11 (latest at time of writing). Fast-path PRs
#9213 / #9627 / #9764 were closed without merge.

---

Reproducing on **omp 18.0.11** (bun 1.3.14, i7-8700T, Linux x64) with hard
numbers, in case it helps prioritize a fix — the per-module rewrite cost
described here is still the dominant startup expense:

**`omp --mode rpc` time-to-ready: 10.4–19.4s** (11.4–11.7s on three
consecutive warm runs — stable, so no effective cross-start caching).

`PI_DEBUG_STARTUP=1` phase trace: **`loadExtensions` alone = 8.02s**
(2.15s → 10.17s), every other phase is milliseconds.

`bun --cpu-prof` over the whole startup (15.8s, 7402 samples):

| Self time | Where |
|---|---|
| 6.35s (40.1%) | bundled `dist/cli.js` — includes an AST-walk helper at **2.48s** self that filters `ImportDeclaration` nodes |
| **4.21s (26.6%)** | `@babel/parser` (`readWord`, `skipSpace`, `nextToken`, `Position`, `Node`, ...) |
| 4.99s (31.5%) | native (module eval + fs) |
| ~1.4s | `stat` 472ms + `hash` 257ms + `existsSync` 268ms + `realpathSync` 160ms |

Two observations that point at the loader rather than user workload:

1. The `?mtime=...` cache-busting suffix shows up on every materialized
   module (pi extension sources copied into a temp dir with zod and the MCP
   SDK each start) — exactly the per-module `onLoad` rewrite mechanism from
   this issue.
2. **The cost is config-independent.** With `HOME` pointed at an empty dir
   (no `~/.omp`, no `~/.pi`), startup still spends ≥11s in
   `loadExtensions`. With the real `~/.omp` plugin store present but no
   `~/.pi`: 10.84s vs 10.78s with everything — i.e. the bundled extension
   surface is the cost, not what the user installed.

`~/.omp/cache/legacy-pi-extension-cache.db` (6 MB) exists but warm runs are
byte-for-byte as slow, so whatever it caches does not eliminate the parse.

Happy to attach the full `.cpuprofile` if useful.

(Context, not a complaint: this one-time-per-spawn cost is what made the
Paseo daemon's old 10s ready deadline fail almost every provider snapshot
refresh — paseo#4142/#4143 raised it to 20s on their side.)
