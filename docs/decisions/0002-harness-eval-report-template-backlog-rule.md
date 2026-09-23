---
status: accepted
date: 2026-09-24
deciders: user, main agent
---
# ADR 0002 — harness-eval 5-block report template + no-state SKILL.md

## Context
User's eval reports were too sketchy to decide from (2026-09-24: "sơ sài và chưa đủ để mình nhận ra vấn đề cần giải quyết, vì sao mình sẽ cần nó, làm xong thì được lợi gì, có rủi ro nào không"); the skill file also carried pending state that went stale.

## Decision
Mandatory 5-block template for every harness-eval output: TIÊU CHÍ (criteria fixed first) / BẢNG VERDICT (criterion+evidence per row) / ĐỀ XUẤT-THIẾT KẾ (Lý do layer: Vấn đề→Vì sao cần→Lợi ích→Rủi ro thật hoặc 'Không có'→Công sức; Kỹ thuật layer: Làm gì→Flow trước/sau→Thay đổi hành vi→Drift-guard; NGUỒN credit per borrowed concept) / CẦN USER QUYẾT (options). SKILL.md carries no state: pending items → BACKLOG.md with repo: tags, verdicts → ext-eval-index.md.

## Consequences
Every LANDSCAPE/EVAL/SYNC output follows one comparable shape; borrowed concepts must carry credit; the skill file cannot go stale. Report source rules distilled from the user's own rewrite history (analyze-sessions research 2026-09-24).

## Evidence
Task #285; commit a778464 (BACKLOG.md absorbs known-gap items); report artifact learn/harness-eval-self-eval-20260924.md; commit c2581bd (self-eval verdict row).
