#!/usr/bin/env node
/**
 * install-pack.mjs — one-command install of this whole pack.
 *
 * Since v1.4.20 installing the pack covers everything it ships:
 *   1. extensions/ + skills/  → ~/.pi/agent/{extensions,skills}   (sync-live)
 *   2. external npm packages  → ~/.pi/agent/npm + settings.json   (install-externals)
 *
 * The agent-code-server managed flow clones the repo at a tag and runs this
 * pack's own installers — externals tracking lives here (dependabot on
 * package.json devDependencies), not in the docker repo.
 *
 * Usage: node scripts/install-pack.mjs [--force]
 * Verify after: bun test (dev tree) and `pi -p "reply OK"` (loader).
 */
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const force = process.argv.includes("--force");
const packRoot = path.resolve(import.meta.dirname, "..");
const home = os.homedir();
const liveExtensionsDir = path.join(home, ".pi", "agent", "extensions");

async function run(cmd, args, label, options = {}) {
  console.log(`[pack] ${label}`);
  await execFileAsync(cmd, args, {
    cwd: packRoot,
    env: { ...process.env, HOME: home },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 600_000,
    ...options,
  });
}

// Runtime deps: entries carrying package.json with dependencies get npm
// install'd (sync-live preserves live node_modules across rsync --delete, so
// this is a fast verify on dev containers; fresh hosts pay the one-time
// download). Mirrors the managed-pack flow in agent-code-server.
async function verifyRuntimeDeps() {
  let entries = [];
  try {
    entries = (await readdir(liveExtensionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const dst = path.join(liveExtensionsDir, entry);
    const pkgJsonPath = path.join(dst, "package.json");
    try {
      await lstat(pkgJsonPath);
    } catch {
      continue; // no package.json — plain source extension, nothing to install
    }
    try {
      const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
      if (pkgJson.dependencies && Object.keys(pkgJson.dependencies).length > 0) {
        console.log(`[pack] ${entry}: npm install (runtime deps)`);
        await execFileAsync("npm", ["install", "--prefix", dst, "--no-audit", "--no-fund"], {
          cwd: dst,
          env: { ...process.env, HOME: home },
          maxBuffer: 10 * 1024 * 1024,
          timeout: 600_000,
        });
      }
    } catch (err) {
      console.warn(`[warn] ${entry}: npm install failed — ${err.message}`);
    }
  }
}

await run("node", [path.join("extensions", "sync-live.mjs"), "all"], "sync extensions + skills");
await verifyRuntimeDeps();
await run(
  "node",
  [path.join("scripts", "install-externals.mjs"), ...(force ? ["--force"] : [])],
  "install external npm packages",
);
console.log("[pack] done — extensions, skills, runtime deps and externals installed.");
