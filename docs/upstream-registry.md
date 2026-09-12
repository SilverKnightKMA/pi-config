# Upstream registry — sổ nguồn gốc mọi mảnh đã port/mượn

> Truth một chỗ cho chế độ **SYNC-UPSTREAM** của skill `pi-ext-eval`.
> Mỗi dòng: extension của ta ↔ nguồn gốc ngoài ↔ ref đã port ↔ lần kiểm cuối ↔ cơ chế theo dõi.
> Khi upstream nhích (dependabot witness PR hoặc quét định kỳ) → chạy chế độ sync trong skill
> → ghi lại kết luận vào cột "lần kiểm cuối" + thêm dòng vào `ext-eval-index.md`.

Cơ chế theo dõi:
- **drift-issue** — workflow `.github/workflows/upstream-drift.yml` (weekly + manual) đọc cột endpoint,
  so ref-đã-port với npm `/latest` + GitHub HEAD; drift → issue `[upstream-sync] <name>` (label
  `upstream-sync`, tự đóng khi registry cập nhật ref). **Đây là cơ chế duy nhất cho ext đã PORT/CONVERT** —
  code port nằm trong pi-config, không cài package ngoài nên bump version không có ý nghĩa nâng cấp.
- **witness-deps** — CHỈ cho 2 external được cài thật (`EXTERNALS` trong scripts/install-externals.mjs:
  pi-mcp-adapter, pi-web-access). Version truth nằm ở devDependencies → dependabot bump → release →
  docker pin → host install = chuỗi nâng cấp THẬT. Không áp dụng cho ext đã port.

## Extensions

Cột **endpoint** là định dạng chuẩn-máy cho workflow `upstream-drift` (một ô chứa nhiều endpoint
phân tách bằng khoảng trắng). Định dạng: `npm:<package>@<version-đã-port>` hoặc `gh:<owner>/<repo>@<sha7>`.
Endpoint `gh:` theo dõi HEAD của repo — khi drift, mini-brief chỉ cần diff đúng thư mục extension liên quan.

| Extension (pi-config) | Nguồn gốc | Ref đã port | Lần kiểm cuối | Theo dõi | endpoint |
|---|---|---|---|---|---|
| `task` | `@pify/task` (dòng tintinweb/pi-tasks) — concepts: DAG blockedBy, evidence-gate, transient nudges, ledger | npm `@pify/task@0.3.0` (snapshot 2026-09-07, MIT) | 2026-09-12 — npm có 0.3.2, CHƯA diff | drift-issue | `npm:@pify/task@0.3.0` |
| `task` (verify 3 tầng) | **tự thiết kế** — layer 0/1/2, PARK, doneCheck guard; KHÔNG có ở upstream | — | — | — | — |
| `snip` | `amosblomqvist/pi-config` `extensions/prompt-snippets` — backend byte-identical lúc port; 3 chủ ý lệch: persistence (ledger), sticky, control-file bridge | commit `f82da56` (2026-08-24) | 2026-09-12 — upstream đứng im tại f82da56 | drift-issue | `gh:amosblomqvist/pi-config@f82da56` |
| `ask-user-question` | fork RPC-compatible của `amosblomqvist/pi-config` extension cùng tên | `f82da56` | 2026-09-12 — đứng im | drift-issue | `gh:amosblomqvist/pi-config@f82da56` |
| `quiz` | fork của `amosblomqvist/learn` `extensions/quiz.ts` | learn `7cfd894` (2026-08-25) | 2026-09-12 — đứng im | drift-issue | `gh:amosblomqvist/learn@7cfd894` |
| `observational-memory` | port gần nguyên văn `amosblomqvist/pi-observational-memory` (HANDOFF đi kèm lúc port); đã tự phát nhiều vòng (status v2, durable cost, stdin fix v1.4.36) | `78a1efc` (2026-08-24) | 2026-09-12 — đứng im | drift-issue | `gh:amosblomqvist/pi-observational-memory@78a1efc` |
| `subagent-types` | fusion: `amosblomqvist/pi-subagents` (spawn base + vai scout/researcher/worker) + `learn` repo (mermaid-maker, svg-maker, roles) + **channel 2 chiều tự thiết kế không có upstream**; auto-ping/main-tool-block/NACK/deferred-kick đều tự thiết kế | pi-subagents `1f54189`, learn `7cfd894` | 2026-09-12 — đứng im | drift-issue | `gh:amosblomqvist/pi-subagents@1f54189` |
| `web-fetch` | copy gần nguyên văn `amosblomqvist/pi-config` web-fetch | `f82da56` | 2026-09-12 — đứng im | drift-issue | `gh:amosblomqvist/pi-config@f82da56` |
| `md-log` | viết-lại-theo-mẫu của `learn` `extensions/md-link.ts` (file đã bị xóa ở upstream; header ghi nguồn) | learn `7cfd894` | 2026-09-12 — đứng im | drift-issue | `gh:amosblomqvist/learn@7cfd894` |
| `read-only-mode` | **tự thiết kế** v1.4.17; v1.4.31 mượn concepts `@pify/plan-mode@0.4.2` (plan file + parseSteps + step cursor + control-file approve) | plan-mode 0.4.2 | 2026-09-12 — npm có 0.4.3, CHƯA diff | drift-issue | `npm:@pify/plan-mode@0.4.2` |
| `subagent-types` (spawn_pool) | mượn concepts `@pify/swarm@0.6.0` (queue + expect-gate) + `@pify/workflow` (resume/gate) — đổi child-mechanism sang spawn_subagent của mình | swarm 0.6.0 / workflow 0.10.0 | 2026-09-12 — npm có 0.6.2 / 0.10.1, CHƯA diff | drift-issue | `npm:@pify/swarm@0.6.0 npm:@pify/workflow@0.10.0` |
| `zombie-watchdog` | **tự thiết kế** 2026-09-01 (sau chat #3845/#3847) | — | — | — | — |
| `sse-probe` | **tự thiết kế** (detector zaicp SSE) | — | — | — | — |
| `visual-tools` | **tự thiết kế** cho pipeline Obsidian/teach | — | — | — | — |

## Externals cài thật (witness-deps, root package.json devDependencies)

| Package | Pin | Ý nghĩa |
|---|---|---|
| `pi-mcp-adapter` | 2.32.1 | cài thật qua install-externals.mjs — dependabot bump = nâng cấp thật (release → docker pin → host install) |
| `pi-web-access` | 0.28.0 | cài thật qua install-externals.mjs — như trên |

KHÔNG pin @pify/* hay ứng viên chưa port trong devDependencies (đã thử rồi bỏ 2026-09-12 theo user:
nothing đọc pin đó nên bump PR vô nghĩa; ext đã port theo dõi bằng drift-issue, ứng viên
chưa quyết re-check version khi quay lại eval theo skill).

## Quy tắc

1. Port mới → thêm dòng registry TRƯỚC khi code trộn main (cột ref = bản/tarball thật đã đọc).
2. Issue `[upstream-sync]` (từ workflow upstream-drift) xuất hiện → chạy chế độ sync trong skill
   `pi-ext-eval`; kết luận (diff gì / port hay bỏ) ghi vào `ext-eval-index.md`; cập nhật cột "lần kiểm
   cuối" + ref trong endpoint → issue tự đóng ở lần chạy workflow sau.
3. Quét định kỳ (landscape) rà thêm repo mới / package mới — không thay drift-issue cho repo đã có endpoint.
4. "Tự thiết kế" vẫn ghi dòng — để mai sau phân biệt cái gì có upstream cái gì không.
5. devDependencies chỉ giữ 2 external cài thật (witness-deps ở trên); tín hiệu tự động cho ext đã port
   là issue upstream-drift, không phải PR dependabot.
6. Workflow `.github/workflows/upstream-drift.yml` (weekly + manual) đọc cột endpoint, so ref-đã-port với
   npm `/latest` + GitHub HEAD; drift → mở/cập nhật issue label `upstream-sync` (title `[upstream-sync] <name>`, KHÔNG nhúng version để dedupe); hết drift → tự đóng. Vấn đề sync theo issue này dùng chế độ 3 của skill `pi-ext-eval`.
