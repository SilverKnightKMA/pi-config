import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	effectiveSpawner,
	isPluginEnabled,
	paseoPresent,
	readSpawnerMode,
	resolveExtOwnsSpawn,
} from "../spawner-mode.ts";

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), "spawner-mode-"));
}

describe("spawner-mode #131 + #187 standalone-clean", () => {
	test("readSpawnerMode: explicit settings win, auto is default", () => {
		expect(readSpawnerMode({ subagentTypes: { spawner: "extension" } }, null)).toBe("extension");
		expect(readSpawnerMode(null, { subagentTypes: { spawner: "plugin" } })).toBe("plugin");
		expect(readSpawnerMode({ subagentTypes: { spawner: "bogus" } }, null)).toBe("auto");
		expect(readSpawnerMode(null, null)).toBe("auto");
	});

	test("isPluginEnabled: fail-open (missing/invalid config → extension keeps spawn)", () => {
		expect(isPluginEnabled(null)).toBe(false);
		expect(isPluginEnabled({ plugins: { "paseo-subagents": { enabled: true } } })).toBe(true);
		expect(isPluginEnabled({ plugins: { "paseo-subagents": { enabled: false } } })).toBe(false);
		expect(isPluginEnabled({ plugins: {} })).toBe(false);
	});

	test("effectiveSpawner: auto follows plugin presence", () => {
		expect(effectiveSpawner("auto", true)).toBe("plugin");
		expect(effectiveSpawner("auto", false)).toBe("extension");
		expect(effectiveSpawner("extension", true)).toBe("extension");
		expect(effectiveSpawner("plugin", false)).toBe("plugin");
	});

	test("#187 paseoPresent: false when no config file and no PASEO_* env", () => {
		const home = tmpHome();
		try {
			expect(paseoPresent(home, { PATH: "/usr/bin", HOME: home })).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("#187 paseoPresent: true when ~/.paseo/config.json exists", () => {
		const home = tmpHome();
		try {
			mkdirSync(join(home, ".paseo"), { recursive: true });
			writeFileSync(join(home, ".paseo", "config.json"), "{}");
			expect(paseoPresent(home, { PATH: "/usr/bin" })).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("#187 paseoPresent: true when any PASEO_* env var is set (no config file)", () => {
		const home = tmpHome();
		try {
			expect(paseoPresent(home, { PASEO_SUBAGENTS_DOOR: "http://127.0.0.1:9" })).toBe(true);
			expect(paseoPresent(home, { PASEO_PARENT_AGENT_ID: "a1" })).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("#187 resolveExtOwnsSpawn: extension mode + no paseo → tools OFF (standalone-clean)", () => {
		// The #44 regression: spawner=auto with no plugin used to register spawn
		// tools whose every path (spawnViaCli + MCP createAgent) needs the daemon.
		expect(resolveExtOwnsSpawn("auto", false, false)).toEqual({ spawner: "extension", extOwnsSpawn: false });
		// Extension mode FORCED by settings is still gated — a dead daemon helps nobody.
		expect(resolveExtOwnsSpawn("extension", false, false)).toEqual({ spawner: "extension", extOwnsSpawn: false });
	});

	test("#187 resolveExtOwnsSpawn: paseo present (config or env) → extension keeps spawn", () => {
		expect(resolveExtOwnsSpawn("auto", false, true)).toEqual({ spawner: "extension", extOwnsSpawn: true });
		expect(resolveExtOwnsSpawn("extension", false, true)).toEqual({ spawner: "extension", extOwnsSpawn: true });
	});

	test("#187 resolveExtOwnsSpawn: plugin owns spawn regardless of daemon hint", () => {
		expect(resolveExtOwnsSpawn("plugin", true, false)).toEqual({ spawner: "plugin", extOwnsSpawn: false });
		expect(resolveExtOwnsSpawn("auto", true, false)).toEqual({ spawner: "plugin", extOwnsSpawn: false });
	});
});
