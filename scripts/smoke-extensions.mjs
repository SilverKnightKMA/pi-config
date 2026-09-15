// smoke-extensions.mjs — load every <dir>/<name>/index.ts in a child bun
// process and assert activate() runs clean. This is the regression guard for
// the "extension change shipped without load-testing crashes pi" class
// (session 01a093d5: pi crash at extension load -> daemon retry -> spawn storm;
// user: "code extension pi, thay đổi mà không test kỹ dẫn đến việc crash pi").
//
// Usage:
//   bun scripts/smoke-extensions.mjs                     # repo extensions/
//   bun scripts/smoke-extensions.mjs ~/.pi/agent/extensions   # installed tree, BEFORE a daemon restart
// Exit code: 0 = all clean, 1 = at least one failed load.

import { readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? join(here, "..", "extensions"));

const entries = readdirSync(target)
	.map((n) => join(target, n))
	.filter((p) => {
		try {
			return statSync(p).isDirectory();
		} catch {
			return false;
		}
	})
	.filter((p) => {
		try {
			return statSync(join(p, "index.ts")).isFile();
		} catch {
			return false;
		}
	})
	.map((p) => join(p, "index.ts"))
	.sort();

if (entries.length === 0) {
	console.error(`no */index.ts under ${target}`);
	process.exit(1);
}

let bad = 0;
for (const file of entries) {
	const name = file.slice(target.length + 1).replace(/\/index\.ts$/, "");
	const proc = Bun.spawnSync(["bun", join(here, "smoke-one.mjs"), file], {
		cwd: dirname(file), // extension-local node_modules resolve first
		timeout: 20_000,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = proc.stdout?.toString() ?? "";
	let result;
	try {
		result = JSON.parse(out.trim().split("\n").pop() ?? "");
	} catch {
		result = { ok: false, activated: false, error: `runner produced no JSON (exit=${proc.exitCode} timeout=${proc.signalCode ?? "-"}) stderr=${(proc.stderr?.toString() ?? "").slice(0, 300)}` };
	}
	if (result.ok && result.activated) {
		console.log(`ok        ${name}`);
	} else {
		bad++;
		console.log(`FAILED    ${name}\n          ${String(result.error).split("\n").slice(0, 4).join("\n          ")}`);
	}
}
console.log(bad === 0 ? `ALL ${entries.length} EXTENSIONS LOAD CLEAN` : `${bad}/${entries.length} FAILED LOAD`);
process.exit(bad === 0 ? 0 : 1);
