---
status: accepted
date: 2026-09-24
deciders: user, main agent
---
# ADR 0003 — Supply-chain pre-filter for eval finalists

## Context
Evals recommend porting third-party npm packages into pi-config with zero supply-chain visibility. Full OpenSSF Scorecard (github.com/ossf/scorecard) needs repo-contents API checks we do not crawl with; researcher analysis 2026-09-23 found only 2 of the relevant checks derivable cheaply.

## Decision
Deploy the 2 cheap checks (SECURITY.md and .github/dependabot.yml existence) in the harness-eval crawler: token-gated batch field at crawl time for gh-* sources, plus on-demand `--supply-chain owner/repo` mode for EVAL finalists. Explicitly a PRE-FILTER, not a security certificate.

## Consequences
Every EVAL brief records a supply-chain row. A failed pre-filter is a signal to look closer, not an automatic reject (amosblomqvist/pi-config itself fails it today — real data point 2026-09-24).

## Evidence
Task #287 completed 2026-09-24 (user: "cái gì cost nhẹ mà nó đáp ứng được thì triển khai thôi"); standard: github.com/ossf/scorecard checks.md (derivability analysis by researcher 01d5a9ff 2026-09-23).
