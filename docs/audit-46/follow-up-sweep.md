# Task-board follow-up sweep (2026-09-22, #210)

Rule being enforced (shipped v1.4.125/v1.4.126): every REPORT-type task (research/eval/audit/scan/review — deliverable is findings, not a product) must leave a successor: implementation, decision stage, or an explicit no-follow-up note.

## Method
Detector = same regex as the live extension + manual classification of every flagged task (heuristic flags are noisy: many BUILD tasks carry audit/review words).

## Numbers
- Total tasks on board: 212
- Report-type by keyword: 74
- Flagged orphan by heuristic (`#id` / blockedBy reference missing): 33
- After manual classification: **32 have semantic successors or are product tasks**; **1 genuine orphan**.

## The one genuine orphan
- **#65 — Audit toàn bộ tools/exts/skills (trùng chức năng + nguồn gốc)** → deliverable `docs/tool-inventory-audit.md`, never consumed. Follow-up created: **#213** (review + extract still-open recommendations or mark superseded).

## Notable chains verified healthy (heuristic missed, semantics fine)
- #2 LLM-as-judge research → #4 build verify layer 0+1 → judge system (live)
- #29 landscape 4 họ → #34/#35/#36 evals/ports → #48 re-sweep → #95 decision (user) → PORT batch #107/#108/#171
- #202 audit #46 report (step 6/6) → F1–F6 = #203–#208 (cited "audit #46", not "#202" — the one heuristic gap class: **plan-umbrella linkage**)
- #122/#149 [CHỜ USER QUYẾT] decision stages → closed with user verbatim answers → successors executed (fd cleanup; door-lifecycle → #187/#193)

## Detector tuning note
Two false-negative classes for the `#id` heuristic: plan-step tasks cite the umbrella task id, not the step id; decisionOf pairs are caught via blockedBy. Acceptable — nudge is soft, human sweep closes the rest (this file).
