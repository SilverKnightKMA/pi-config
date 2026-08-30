# Memory index

Durable memory topics for this project. Read a file for its full current state.

## Extension provenance, upstream repos, role pins, and scope-audit findings
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/extension-provenance.md` · updated 2026-08-30 15:36
- Per-extension fork attribution, upstream repos for pi-subagents vs interactive-subagents, full 14-component scope-audit, port decisions, visual-tools/researcher/web-fetch collision findings, model audit verdict, and vision model recommendations.

## message_main queue-flush bug — root cause, fix, Phase 1 + Phase 2 implementation, E2E verification
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/message-main-bug.md` · updated 2026-08-30 15:36
- Confirmed real bug; file-queue + 3-event drain fix DESIGNED, IMPLEMENTED, TESTED, and E2E-VERIFIED. Phase 2 (ask_question park/wait/absorb + name registry + resume-by-name) also shipped and E2E-verified. One self-introduced bug (missing JSON-RPC id) found and fixed during E2E. Related: Paseo 'finish notification drop' stop-bug confirmed via 3 reproductions.

## Observational-memory (OM) extension: models, settings, lifecycle, current state
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/observational-memory.md` · updated 2026-08-30 15:36
- Configuration of the OM extension (observer/consolidator models, pool thresholds), how the .memory directory is populated by consolidation, observer stats, cost breakdown, INDEX.md refresh bug (FIXED end-to-end), and consolidator nesting bug (FIXED end-to-end).

## Known Paseo/pi bugs and quirks observed
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/paseo-bugs.md` · updated 2026-08-30 15:36
- Known Paseo bugs from handoff, scope-audit findings from this session (visual-tools stale host, researcher/learn-researcher duplicates, web-fetch origin), OM observer cost stats, the 'finish notification drop' stop-bug, session-specific quirks, and yt-dlp/ffmpeg/BtbN environment fixes.

## Exhaustive tool/skill/extension test results (2026-08-30)
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/tool-test-results.md` · updated 2026-08-30 15:36
- 2026-08-30 test session — 38/38 PASS + final 5-item close (YouTube frames, guided-choice, PDF scan, user-side commands, web_search providers) + 52/52 bun test + 108/108 OM fix tests. Real message_main bug fixed separately; OM INDEX nesting bug fixed end-to-end.

## User communication and working-style preferences
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/user-preferences.md` · updated 2026-08-30 15:36
- Language (Vietnamese), exhaustive-testing demand, preference for guided interactive instructions over forced interactive runs, scope of features to keep covered, model-audit verdict, stop-bug interaction patterns, and priority-on-user-action directive.

## Workspace structure and Paseo/pi runtime environment
- `.memory/01a0522e-81f4-7311-8ba4-027cea97e974/workspace-and-environment.md` · updated 2026-08-30 15:36
- Layout of .pi/skills and .pi/extensions, dev-copy extensions/ tree vs live-only extensions, settings.json packages, pi-web-access tool lineage, OM fix details (consolidator cwd + scoped() bug), and pi/Paseo runtime versions.
