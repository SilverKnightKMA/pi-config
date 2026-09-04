#!/usr/bin/env node
/**
 * sync-live.mjs — idempotent dev → live extension sync.
 *
 * Sinh ra sau sự cố 2026-09-04: lệnh cũ `cp extensions/<tên>/{*.ts,tests} …`
 * (a) copy *.test.ts ra cấp 1 live → pi loader nạp như extension → chết
 *     (`bun:test` not found), (b) cp vào dst tồn tại → lồng `x/x/`,
 * (c) không xóa file phẳng v1 khi đưa layout v2 vào → registerTool conflict.
 *
 * Quy tắc: mỗi ext là MỘT rsync --delete dir-sang-dir (không lồng, không sót),
 * loại *.test.ts / node_modules / .tmp* khỏi cấp 1. Chạy `bun test` trước,
 * chạy `pi -p` sau — xem extensions/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const devRoot = path.resolve(import.meta.dirname);
const liveRoot = path.join(homedir(), ".pi/agent/extensions");

// Ext có dev copy và BỐ CỤC THƯ MỤC ở live (v2). File phẳng v1 đã bị loại bỏ
// cùng sự cố — không thêm tên file phẳng nào vào đây nữa.
const PACKED = ["ask-user-question", "observational-memory", "quiz", "snip", "subagent-types", "zombie-watchdog"];
// Live-only, KHÔNG đụng: visual-tools, web-fetch (node_modules riêng), md-log.ts.
const NEVER_TOUCH = new Set(["visual-tools", "web-fetch", "md-log.ts"]);

const args = process.argv.slice(2);
const targets = args.length > 0 ? args : PACKED;
for (const t of targets) {
	if (!PACKED.includes(t)) throw new Error(`unknown packed extension: ${t}`);
	if (NEVER_TOUCH.has(t)) throw new Error(`refuse to touch live-only: ${t}`);
}

const rsyncArgs = ["-a", "--delete",
	"--exclude", "*.test.ts",
	"--exclude", "node_modules",
	"--exclude", ".tmp*"];
for (const name of targets) {
	const src = path.join(devRoot, name) + "/";
	const dst = path.join(liveRoot, name);
	if (!existsSync(src)) throw new Error(`dev copy missing: ${src}`);
	mkdirSync(dst, { recursive: true });
	console.log(`[sync] ${name}/`);
	execFileSync("rsync", [...rsyncArgs, src, dst + "/"], { stdio: "inherit" });
}
console.log("[sync] done — chạy bun test (dev) và pi -p \"reply OK\" (loader) để xác minh.");
