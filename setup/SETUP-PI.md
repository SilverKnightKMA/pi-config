# SETUP-PI — cài pi + pi-config pack từ đầu (phần 1/2)

> **⚠️ Hệ 2 repo — repo này đơn lẻ KHÔNG chạy được.**
> Extension của pack (subagent-types, task, goal, plan, snip…) giao tiếp với Paseo daemon qua kênh disk + MCP. Chưa cài Paseo + plugin thì: subagent không spawn được, task/goal/plan wake không chạy, marker không hiển thị panel.
> **Sau khi xong file này, bắt buộc làm tiếp:** [`SETUP-PASEO.md` trong repo paseo-plugins](https://github.com/SilverKnightKMA/paseo-plugins/blob/main/setup/SETUP-PASEO.md)

Hướng dẫn này dành cho **agent** đọc và tự thực hiện trên máy sạch. Viết cho **Linux, macOS và Windows native** (PowerShell).

## 0. Prerequisites

| Yêu cầu | Linux/macOS | Windows native |
|---|---|---|
| Node.js ≥ 20 + npm | nodejs.org hoặc package manager | nodejs.org installer (đánh dấu *Add to PATH*) |
| Git | git | **Git for Windows** (git-scm.com) — mang cả `git` lẫn `bash.exe`; một số extension gọi bash, Git for Windows cung cấp qua PATH |

Kiểm tra: `node --version`, `npm --version`, `git --version` — cả 3 phải chạy được trong shell bạn đang dùng (PowerShell trên Windows).

Path cấu hình theo OS:

| Hệ | Đường dẫn config pi |
|---|---|
| Linux/macOS | `~/.pi/agent/…` và `~/.pi/web-search.json` |
| Windows native | `%USERPROFILE%\.pi\agent\…` và `%USERPROFILE%\.pi\web-search.json` |

## 1. Cài pi (luôn latest — không pin)

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

## 2. Lấy pack này

```bash
git clone https://github.com/SilverKnightKMA/pi-config.git
cd pi-config
```

## 3. Cài pack (extensions + skills + npm externals)

```bash
node scripts/install-pack.mjs
```

Một lệnh duy nhất làm cả ba: sync `extensions/` (15 extension) + `skills/` (10 skill) vào thư mục pi, rồi install 2 package ngoài (`pi-mcp-adapter`, `pi-web-access`). Script tự nhận môi trường: có `rsync` thì dùng rsync, không có (Windows native) thì dùng mirror thuần node — cùng kết quả.

## 4. Đặt config từ samples

Copy 3 file từ `setup/samples/` sang thư mục config pi (path theo bảng ở bước 0), rồi điền các giá trị `<PLACEHOLDER>` theo bảng FILL-IN dưới đây. **Agent hỏi user lấy giá trị — không tự bịa.**

| File đích | Nguồn sample | Placeholder phải điền |
|---|---|---|
| `~/.pi/agent/settings.json` | `setup/samples/pi-settings.json` | `<FAST-MODEL-ID>`, `<MAIN-MODEL-ID>`, `<REASONING-MODEL-ID>` (id model bạn đăng ký ở file models) |
| `~/.pi/agent/models.json` | `setup/samples/pi-models.json` | `<YOUR-API-KEY>`, `<YOUR-OPENAI-COMPATIBLE-ENDPOINT>`, `<THINKING-FORMAT>`, `<MODEL-ID>`, `<MODEL-NAME>` (+ cost theo giá thật) |
| `~/.pi/web-search.json` | `setup/samples/pi-web-search.json` | `<YOUR-EXA-API-KEY>`, `<YOUR-JINA-API-KEY>`, `<YOUR-SEARXNG-HOST>:<PORT>` (bỏ file này nếu không dùng web-search) |

Ghi chú shape:
- `models.json`: một entry provider kiểu OpenAI-compatible (`api: "openai-completions"`). Thêm bao nhiêu model cũng được — mỗi model một object trong mảng `models`. `THINKING-FORMAT` nói với pi cách gửi reasoning cho các họ model reasoning — xem docs pi để biết các giá trị được hỗ trợ, model không reasoning thì bỏ key.
- `settings.json` → `observational-memory`: observer nên là model rẻ/nhanh, consolidator là model reasoning tốt — đây là bộ máy ghi trí nhớ dài hạn, cấu hình đúng thì hệ tự học sau mỗi session.
- `packages` giữ nguyên — installer đã đăng ký sẵn.

## 5. Verify pi

```bash
pi -p "reply OK"
```

Must pass: pi trả lời, không stack trace loader. Kiểm tra tree đã đủ:

```bash
ls ~/.pi/agent/extensions        # 15 thư mục extension (Windows: dir %USERPROFILE%\.pi\agent\extensions)
```

## 6. Bắt buộc: cài tiếp Paseo

Đến đây pi chạy được nhưng **pack chưa hoạt động** — subagent/task/goal/plan cần Paseo daemon và plugin panel. Chuyển sang:

**➡️ [SETUP-PASEO.md — repo paseo-plugins](https://github.com/SilverKnightKMA/paseo-plugins/blob/main/setup/SETUP-PASEO.md)**

---

## Migrate dữ liệu cá nhân (optional, không nằm trong repo)

Repo chỉ mang cấu hình khung. Dữ liệu sau KHÔNG được commit vào bất kỳ repo nào — copy tay từ máy cũ nếu có:

| Dữ liệu | Path | Mất thì sao |
|---|---|---|
| Token OAuth provider | `~/.pi/agent/auth.json` | Login lại từng provider (`/login`) |
| Bài học gấp | `~/.pi/agent/lessons.md` | Mất vĩnh viễn — OM ghi dần |
| Trí nhớ OM | `<workspace>/.memory/` | Mất vĩnh viễn |
| Board task/goal | `~/.pi/agent/task-status/`, `goal-status/`, `plan-control/` | Fresh start |
| Paseo state | xem bảng tương ứng trong SETUP-PASEO.md | — |
