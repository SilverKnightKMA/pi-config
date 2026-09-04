# Draft comment — getpaseo/paseo #1446 (NOT posted yet)

Corroborating data point from a self-hosted instance (paseo 0.7.2, Docker on an n100-class host):

- omp cold-start here costs ~8s of pure CPU in `loadExtensions` (profiled with `bun --cpu-prof-md`: cli.js 40%, native 32%, @babel/parser 27% — it babel-parses the whole extension surface at startup). That makes OMP the slowest probe in every concurrent snapshot by a wide margin.
- After the 0.7.1 → 0.7.2 upgrade (ready wait 10s → 20s, #4143), steady-state snapshots are clean: zero `Timed out waiting for OMP` across a full day of runtime.
- The only remaining flakes are at **container boot**, when the daemon's first provider snapshot collides with everything else warming up (load avg ~8.5 on a small host). Observed two consecutive `Timed out waiting for OMP` at daemon start +9s/+13s on 0.7.2 — both self-healed on the next retry.
- That matches the root-cause diagnosis behind PR #1314: it's CPU/IO contention, amplified at boot. Bounding probe concurrency (p-limit 2) should cover the boot case too, since the slowest member (omp) stops competing with the rest simultaneously.

No local fix needed beyond the upgrade — sharing the boot-time data point in case it helps validate the concurrency bound.
