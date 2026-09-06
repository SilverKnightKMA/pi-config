#!/usr/bin/env node
/**
 * sync-live.mjs — idempotent dev → live sync (extensions + skills).
 *
 * Born from the 2026-09-04 incident: the old `cp extensions/<name>/{*.ts,tests} …`
 * (a) copied *.test.ts to the live top level → pi loader picked it up as an
 *     extension → crash (`bun:test` not found), (b) cp into an existing dst
 *     nested `x/x/`, (c) flat v1 files were not removed when the v2 layout
 *     landed → registerTool conflict.
 *
 * Rule: each ext is ONE rsync --delete dir-to-dir (no nesting, no leftovers),
 * with *.test.ts / node_modules / .tmp* excluded from the top level. Run
 * `bun test` first, then `pi -p` — see extensions/README.md.
 *
 * Role since v1.4.0: HOT-LANE between two tags only. The main delivery flow
 * is the managed pack (tag → auto-PR bumping the pin in the docker repo →
 * managed-tools:update). Extensions and skills now ship in the pack; this
 * script syncs EVERY managed entry, while visual-tools/web-fetch sync code
 * but KEEP live node_modules (installed once; rsync --delete
 * --exclude=node_modules leaves them alone).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const devRoot = path.resolve(import.meta.dirname);
const liveRoot = path.join(homedir(), ".pi/agent/extensions");
const devSkills = path.join(devRoot, "..", "skills");
const liveSkills = path.join(homedir(), ".pi/agent/skills");

// Every extension dir in the v1.4.0+ pack (md-log is a dir; visual-tools/web-fetch
// node_modules are excluded, so rsync --delete is safe for them).
const PACKED = [
	"ask-user-question",
	"md-log",
	"observational-memory",
	"quiz",
	"read-only-mode",
	"snip",
	"sse-probe",
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
console.log('[sync] done — run bun test (dev) and pi -p "reply OK" (loader) to verify.');
