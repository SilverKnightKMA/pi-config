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
 * script syncs EVERY managed entry, while visual-tools sync code
 * but KEEP live node_modules (installed once; rsync --delete
 * --exclude=node_modules leaves them alone).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const devRoot = path.resolve(import.meta.dirname);
const liveRoot = path.join(homedir(), ".pi/agent/extensions");
const devSkills = path.join(devRoot, "..", "skills");
const liveSkills = path.join(homedir(), ".pi/agent/skills");

// Every extension dir in the v1.4.0+ pack (md-log is a dir; visual-tools
// node_modules are excluded, so rsync --delete is safe for them).
// _shared: cross-extension modules (continuation-driver.ts). NO index.ts →
// pi loader ignores it (loader picks up *.ts at top level and */index.ts only —
// 2026-09-15 incident: root-level continuation-driver.ts was loaded as an
// extension and crashed RPC).
const PACKED = [
	"_shared",
	"ask-user-question",
	"bash-long-run-guard",
	"facts",
	"goal",
	"lessons",
	"md-log",
	"observational-memory",
	"quiz",
	"read-only-mode",
	"task",
	"snip",
	"sse-probe",
	"subagent-types",
	"telemetry",
	"visual-tools",
	"zombie-watchdog",
];
// Skills ship as directories carrying SKILL.md — auto-listed so a new skill
// dir is picked up without editing this file (the static list went stale once:
// 6 of 10 real skills, found 2026-09-17 while building the standalone setup path).
const SKILLS = readdirSync(devSkills, { withFileTypes: true })
	.filter((e) => e.isDirectory() && existsSync(path.join(devSkills, e.name, "SKILL.md")))
	.map((e) => e.name)
	.sort();

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

// v1.4.100 (#115): native-Windows support. rsync is not available there, so when
// it is missing the sync falls back to a pure-node mirror with identical
// semantics: dst mirrors src for non-excluded entries; excluded names in dst
// are protected from deletion (live node_modules survive) and never copied.
const EXCLUDES = [/\.test\.ts$/, /^node_modules$/, /^\.tmp/];
const isExcluded = (name) => EXCLUDES.some((re) => re.test(name));

function haveRsync() {
	try {
		execFileSync("rsync", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
const useRsync = haveRsync();

function mirrorDir(src, dst) {
	mkdirSync(dst, { recursive: true });
	const srcNames = new Set(readdirSync(src));
	for (const name of readdirSync(dst)) {
		if (isExcluded(name) || srcNames.has(name)) continue;
		rmSync(path.join(dst, name), { recursive: true, force: true });
	}
	for (const name of srcNames) {
		if (isExcluded(name)) continue;
		const s = path.join(src, name);
		const d = path.join(dst, name);
		if (statSync(s).isDirectory()) {
			// type change file→dir in dst would make copyFileSync throw — clear it first.
			try {
				if (!statSync(d).isDirectory()) rmSync(d, { force: true });
			} catch {
				// dst entry does not exist yet
			}
			mirrorDir(s, d);
		} else {
			copyFileSync(s, d);
		}
	}
}

function rsync(src, dst) {
	if (!existsSync(src)) throw new Error(`dev copy missing: ${src}`);
	mkdirSync(dst, { recursive: true });
	if (useRsync) {
		execFileSync("rsync", [...rsyncArgs, src + "/", dst + "/"], { stdio: "inherit" });
		return;
	}
	mirrorDir(src, dst);
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
console.log(useRsync ? "[sync] mode: rsync" : "[sync] mode: node mirror (rsync not found — Windows native path)");
console.log('[sync] done — run bun test (dev) and pi -p "reply OK" (loader) to verify.');
