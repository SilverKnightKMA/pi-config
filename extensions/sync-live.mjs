#!/usr/bin/env node
/**
 * sync-live.mjs — idempotent dev → live sync (extensions + skills).
 *
 * Sinh ra sau sự cố 2026-09-04: lệnh cũ `cp extensions/<tên>/{*.ts,tests} …`
 * (a) copy *.test.ts ra cấp 1 live → pi loader nạp như extension → chết
 *     (`bun:test` not found), (b) cp vào dst tồn tại → lồng `x/x/`,
 * (c) không xóa file phẳng v1 khi đưa layout v2 vào → registerTool conflict.
 *
 * Quy tắc: mỗi ext là MỘT rsync --delete dir-sang-dir (không lồng, không sót),
 * loại *.test.ts / node_modules / .tmp* khỏi cấp 1. Chạy `bun test` trước,
 * chạy `pi -p` sau — xem extensions/README.md.
 *
 * Vai trò từ v1.4.0: HOT-LANE giữa 2 tag thôi. Luồng giao chính là managed
 * pack (tag → auto-PR bump pin repo docker → managed-tools:update). Extensions
 * và skills giờ đã nằm trong pack, bản này sync TẤT CẢ entry managed, riêng
 * visual-tools/web-fetch sync code nhưng GIỮ node_modules live (npm install
 * một lần; rsync --delete --exclude=node_modules không đụng tới).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const devRoot = path.resolve(import.meta.dirname);
const liveRoot = path.join(homedir(), ".pi/agent/extensions");
const devSkills = path.join(devRoot, "..", "skills");
const liveSkills = path.join(homedir(), ".pi/agent/skills");

// Mọi extension dir trong pack v1.4.0+ (md-log là dir, visual-tools/web-fetch
// node_modules được exclude nên an toàn cho rsync --delete).
const PACKED = [
	"ask-user-question",
	"md-log",
	"observational-memory",
	"quiz",
	"snip",
	"subagent-types",
	"visual-tools",
	"web-fetch",
	"zombie-watchdog",
];
const SKILLS = ["analyze-sessions", "pdf-reader", "teach", "visualize", "youtube-transcript"];

const args = process.argv.slice(2);
const wantAll = args.length === 0 || args[0] === "all";
const targets = wantAll ? PACKED : args.filter((a) => a !== "skills");
const wantSkills = wantAll || args.includes("skills");
for (const t of targets) {
	if (!PACKED.includes(t)) throw new Error(`unknown packed extension: ${t}`);
}

const rsyncArgs = ["-a", "--delete",
	"--exclude", "*.test.ts",
	"--exclude", "node_modules",
	"--exclude", ".tmp*"];
function rsync(src, dst) {
	if (!existsSync(src)) throw new Error(`dev copy missing: ${src}`);
	mkdirSync(dst, { recursive: true });
	execFileSync("rsync", [...rsyncArgs, src + "/", dst + "/"], { stdio: "inherit" });
}
for (const name of targets) {
	console.log(`[sync] extensions/${name}/`);
	rsync(path.join(devRoot, name), path.join(liveRoot, name));
}
if (wantSkills) {
	for (const name of SKILLS) {
		console.log(`[sync] skills/${name}/`);
		rsync(path.join(devSkills, name), path.join(liveSkills, name));
	}
}
console.log("[sync] done — chạy bun test (dev) và pi -p \"reply OK\" (loader) để xác minh.");
