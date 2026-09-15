# Incident report — "extension đổi không test kỹ → pi crash" (2026-09-15)

**Lớp lỗi:** user-named, lặp lại nhiều lần. *"bạn code extension pi, thay đổi mà
không test kỹ dẫn đến việc crash pi, session id 01a093d5"*. Lần gần nhất: sau khi
restart daemon vẫn gặp lỗi (17:34 UTC).

## Cơ chế crash (xác nhận trong source pi)

pi load mọi extension tại session start. Extension fail to load → diagnostic
`Failed to load extension "<path>"` → **`process.exit(1)`** ngay trong
`dist/main.js`. Daemon thấy agent chết → retry → **spawn storm** (3+ process
trong vài giây, session 01a093d5 đã chụp hiện tượng này 2026-09-13 khi một lần
bisect làm gãy TS syntax). Restart daemon không chữa được vì lỗi nằm ở code
extension, không phải daemon.

## Lỗ hổng test cũ

642 test phủ pure module (`src/*.ts`) nhưng **không dòng test nào từng import +
`activate()` file `index.ts`** — đúng lớp code pi thực thi lúc load. CI xanh khi
extension hỏng load hoàn toàn.

## 4 bug thật bị bắt (đều từ v1.4.0, 2026-09-05 — âm thầm hỏng 10 ngày)

Commit v1.4.0 "absorb live-only extensions" đưa code vào pack mà không kèm/không
khai báo dependency:

| # | Extension | Lỗi | Fix (zero-dep) |
|---|---|---|---|
| 1 | web-fetch | `import "typebox"` — không khai báo, không install | schema JSON literal |
| 2 | web-fetch | `@mariozechner/pi-tui` — package tên cũ đã chết | đổi tên |
| 3 | web-fetch | `new Text` value-import — không resolve từ cây installed | type-only + FallbackText tự chứa |
| 4 | visual-tools | `@sinclair/typebox` — khai báo nhưng không bao giờ install trên host | schema JSON literal, bỏ dependency |

## Bẫy che mắt (phát hiện khi verify)

1. **Repo tree che**: node_modules cục bộ (gitignored) + root node_modules resolve
   hộ → smoke trên repo xanh dù host đỏ.
2. **Bun global cache che**: khi không có node_modules, bun tự resolve bare
   import từ `~/.bun/install/cache` — clone v1.4.71 (code hỏng) vẫn load được
   trên máy dev cache ấm. Trên host có node_modules cục bộ thiếu package →
   fallback tắt → fail thật. **Local pass chỉ đáng tin khi nó FAIL.**

## Hàng rào phòng tránh (3 lớp)

| Lớp | Cơ chế | Chạy khi nào |
|---|---|---|
| `extensions/extension-smoke.test.ts` | child process import + `activate()` mọi extension với stub | mỗi `bun test` |
| `scripts/smoke-extensions.mjs <dir>` | load smoke một cây bất kỳ (repo / host) | thủ tục: chạy với `~/.pi/agent/extensions` **trước mỗi lần restart daemon** sau khi sửa extension |
| CI job `installed-tree-smoke` | clone-fresh PR HEAD, không install, smoke trên cache lạnh — mô phỏng đúng cây host | mỗi PR vào main (cả dependabot + auto-merge) |

Kỹ thuật: `smoke-one.mjs` chạy activate với chainable recording stub rồi
`process.exit(0)` chủ động — activate() có khởi động timer/watcher cũng không
đóng băng probe.

## Bằng chứng

- v1.4.72: gate + fix bug 1-2 · v1.4.73: fix bug 3-4 (zero-dep cả hai extension)
- PR #201, #202 (agent-code-server-docker) merged; host installed
- Host verify: `ALL 13 EXTENSIONS LOAD CLEAN` trên `~/.pi/agent/extensions`
- CI run 34975003936: `test` + `installed-tree-smoke` đều success
- Suite: 642/642 EXIT:0
