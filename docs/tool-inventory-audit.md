# Tool / Extension / Skill Inventory & Duplication Audit

Task #65 · 2026-09-15 · scope: everything available to the main agent.

## 1. Attribution map

### pi core (8 tools) — `dist/core/tools/index.js allToolNames`
read, bash, powershell, edit, write, grep, find, ls
(`safe_bash` is a built-in variant shipped in the same bundle — blocks dangerous commands; used for subagent roles.)

### pi packages (`~/.pi/agent/settings.json` → `packages`)
| package | tools |
|---|---|
| `npm:pi-web-access` | web_search, source_check, fetch_content, get_search_content |
| `npm:pi-mcp-adapter` | mcp, mcpScript |

### pi-config extensions (`~/.pi/agent/extensions/*`, each registers via `pi.registerTool`)
| extension | tools / commands |
|---|---|
| subagent-types | spawn_subagent (index.ts:820), spawn_paseo_subagent (:875), spawn_pool (:1332), message_main, message_subagent, ask_question, pool_status, pool_resume |
| task | task_create, task_update, task_list |
| goal | goal_propose |
| quiz | quiz |
| ask-user-question | ask_user_question |
| read-only-mode | enter_plan_mode, write_plan, exit_plan_mode, plan_step_done |
| observational-memory | om_status (main agent); write_memory/write_journey live in the consolidator worker subprocess only |
| web-fetch | web_fetch |
| visual-tools | write_mermaid, edit_mermaid, render_mermaid, write_svg, edit_svg, render_svg |
| snip / md-log / sse-probe / zombie-watchdog | slash commands + background only, no agent tools |

### Skills (~/.pi/agent/skills + ~/.agents/skills)
analyze-sessions, code-review, committee-lanes, paseo, paseo-advisor, paseo-handoff, paseo-help, paseo-plugin, pdf-reader, pi-ext-eval, release-beta, release-stable, stop-slop, task, teach, visualize, youtube-transcript (+ stale `paseo-committee` in ~/.agents/skills).

## 2. Key confirmations

1. **spawn_subagent is NOT native pi.** Both `spawn_subagent` and `spawn_paseo_subagent` are registered by our `subagent-types` extension (same `resolveSpawnConfig`, same role gate at index.ts:689). The blocking variant was user-approved 2026-09-05.
2. **The 3 spawn tools are 3 call styles over one mechanism** — detach (spawn_subagent), blocking-inline-report (spawn_paseo_subagent), bounded parallel fan-out (spawn_pool). promptGuidelines already state: prefer detach; block only when the next step needs the child's result. → No consolidation needed.

## 3. Duplicates found

| pair | verdict |
|---|---|
| web_fetch (ext web-fetch) vs fetch_content (pi-web-access) | genuine overlap — both fetch a URL to markdown. Keep for now (different auth/profile features); candidate to retire the ext when pi-web-access covers authFetch profiles. |
| skill `paseo-committee` (~/.agents/skills) vs `committee-lanes` | stale duplicate — committee-lanes self-declares "Replaces the upstream paseo-committee skill". → remove the stale one. |
| ask_user_question (user) vs ask_question (child→main) vs quiz (graded MCQ) | overlapping surface, distinct scopes — keep. |
| web_search vs source_check vs fetch_content | search / claim-verification / fetch — related but distinct, same package. |
| bash vs safe_bash | intentional permission-class pairing, pi built-in. |

## 4. Recommendations

1. Delete stale `~/.agents/skills/paseo-committee` (committee-lanes replaces it).
2. Default to detach `spawn_subagent`; blocking variant only when the report is needed inline (already the documented guideline).
3. No tool retirement this round; revisit web-fetch ext when pi-web-access gains authFetch profiles.

## Review 2026-09-22 (#213 — follow-up muộn của #65)

Đối chiếu trạng thái v1.4.126 (engine) + v1.0.80 (plugins):

| Rec | Trạng thái 2026-09-22 | Hành động |
|---|---|---|
| 1. Xóa `~/.agents/skills/paseo-committee` | **Còn mở suốt 7 ngày** — dir vẫn tồn tại đến hôm nay | ✅ Đã xóa trong #213 (committee-lanes là bản thay thế chính thức) |
| 2. Default detach, blocking chỉ khi cần inline report | Đã thỏa: guideline sống trong tool description `spawn_subagent` (index.ts:1174 "Prefer spawn_subagent…") | No-action |
| 3. Reconsider web-fetch ext khi pi-web-access có authFetch | **Điều kiện đã chín**: `fetch_content` giờ có `auth` param (authFetch profiles), đồng thời là superset (modes readable/raw/answer, image URLs, YouTube transcripts, GitHub repos, local video + get_search_content) so với web_fetch (readable + Jina fallback) | 🟡 Quyết định của user — decision task đã mở |

Attribution drift: bảng mục 1 là ảnh chụp 2026-09-15 (~13 ext). Hiện 17 ext + `facts` / `bash-long-run-guard` / `telemetry` / `sse-probe`… — không phát hiện trùng chức năng MỚI nào từ đợt port sau đó (audit #46 quét nguồn gốc từng unit, 0 cảnh cáo trùng). Bảng giữ nguyên giá trị lịch sử; không làm lại audit trong review này.

Kết luận chain: #65 → review này (#213) → 1 quyết định mở (R3). Chain đóng với decision stage, đúng rule REPORT FOLLOW-UP.
