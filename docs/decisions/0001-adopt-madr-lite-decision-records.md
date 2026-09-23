---
status: accepted
date: 2026-09-24
deciders: user, main agent
---
# ADR 0001 — Adopt MADR-lite decision records in both repos

## Context
Evals and builds accumulated verdicts with no durable, checkable decision log; the harness-eval SKILL.md known-gap map went stale (goal ext listed "awaiting user" long after shipping). User asked 2026-09-24 for a standard with workflow validation to stop fabricated records ("chống viết bừa").

## Decision
Adopt MADR-lite: MADR 3.0 field set (adr.github.io/madr) with YAML frontmatter per smadr (github.com/zircote/structured-madr; adrkit.dev/schema), validated by a self-contained stdlib checker (adr-check.py) + adr-check.yml workflow in BOTH pi-config and paseo-plugins. Every record needs an Evidence section with ≥1 resolvable ref. NO bulk backfill of old decisions — invented history is exactly what this guards against; seed only real, dated, evidenced decisions going forward.

## Consequences
New significant decisions get a record; CI fails records missing structure or evidence refs. Schema proves structure only — content truth rides on the evidence-ref rule (boundary stated in adr-check.py docstring).

## Evidence
Task #288, user build order 2026-09-24 ("284-288 và 1 nhiệm vụ chưa vào task thực hiện đi"); standards web-verified 2026-09-24: github.com/adr/madr, zircote/structured-madr, adrkit.dev/schema.
