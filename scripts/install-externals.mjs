#!/usr/bin/env node
/**
 * install-externals.mjs — install the npm packages this pack carries.
 *
 * Since v1.4.20 the pack self-carries its external pi packages (pi-mcp-adapter,
 * pi-web-access): version truth lives in THIS repo's package.json devDependencies,
 * so dependabot (bun ecosystem) opens upstream-bump PRs here and the release
 * chain ships them — the agent-code-server repo no longer tracks or installs
 * these packages separately.
 *
 * What it does (replicates `pi install npm:<pkg>@<ver>`):
 *   1. npm install <pkg>@<version> into ~/.pi/agent/npm/
 *   2. Ensure "npm:<pkg>" is registered in ~/.pi/agent/settings.json packages
 *
 * Idempotent: already-matching versions and registrations are no-ops.
 * Run standalone (node scripts/install-externals.mjs) or via install-pack.mjs.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const force = process.argv.includes("--force");
const packRoot = path.resolve(import.meta.dirname, "..");

// External npm packages carried by this pack. Versions are pinned in the root
// package.json devDependencies — single source of truth, dependabot-tracked.
const EXTERNALS = ["pi-mcp-adapter", "pi-web-access"];

const home = os.homedir();
const piAgentDir = path.join(home, ".pi", "agent");
const piNpmDir = path.join(piAgentDir, "npm");
const piSettingsPath = path.join(piAgentDir, "settings.json");

async function pinnedVersions() {
  const pkgJson = JSON.parse(await readFile(path.join(packRoot, "package.json"), "utf8"));
  const devDeps = pkgJson.devDependencies ?? {};
  const pinned = {};
  for (const name of EXTERNALS) {
    const version = devDeps[name];
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error(
        `package.json devDependencies is missing "${name}" — the pack cannot pin its externals without it`,
      );
    }
    pinned[name] = version;
  }
  return pinned;
}

async function installedVersion(pkg) {
  try {
    const pkgJson = JSON.parse(
      await readFile(path.join(piNpmDir, "node_modules", pkg, "package.json"), "utf8"),
    );
    return pkgJson.version ?? null;
  } catch {
    return null;
  }
}

async function readSettingsPackages() {
  try {
    const settings = JSON.parse(await readFile(piSettingsPath, "utf8"));
    return Array.isArray(settings.packages) ? settings.packages : [];
  } catch {
    return [];
  }
}

async function npmInstall(pkg, version) {
  console.log(`[externals] npm install ${pkg}@${version} into ${piNpmDir}`);
  await mkdir(piNpmDir, { recursive: true });
  await execFileAsync(
    "npm",
    ["install", "--prefix", piNpmDir, "--ignore-scripts", `${pkg}@${version}`],
    {
      cwd: home,
      env: { ...process.env, HOME: home },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000,
    },
  );
}

async function registerInSettings(name) {
  const packageEntry = `npm:${name}`;
  let settings = {};
  try {
    settings = JSON.parse(await readFile(piSettingsPath, "utf8"));
  } catch {
    // settings.json doesn't exist yet
  }
  if (!Array.isArray(settings.packages)) settings.packages = [];
  if (settings.packages.includes(packageEntry)) return false;
  settings.packages.push(packageEntry);
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(piSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log(`[externals] registered ${packageEntry} in pi settings.json`);
  return true;
}

async function main() {
  const pinned = await pinnedVersions();
  const summary = {};
  for (const name of EXTERNALS) {
    const version = pinned[name];
    const installed = await installedVersion(name);
    const registered = (await readSettingsPackages()).includes(`npm:${name}`);
    if (!force && installed === version && registered) {
      console.log(`[externals] ${name}@${installed} already installed and registered`);
      summary[name] = installed;
      continue;
    }
    if (installed !== version) {
      await npmInstall(name, version);
    }
    await registerInSettings(name);
    summary[name] = version;
  }
  console.log(`[externals] done ${JSON.stringify(summary)}`);
}

await main();
