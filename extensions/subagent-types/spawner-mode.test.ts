import { describe, expect, test } from "bun:test";
import { effectiveSpawner, isPluginEnabled, readSpawnerMode } from "./spawner-mode";

describe("readSpawnerMode", () => {
	test("defaults to auto; workspace wins over user; ignores unknown values", () => {
		expect(readSpawnerMode(null, null)).toBe("auto");
		expect(readSpawnerMode({ subagentTypes: { spawner: "plugin" } }, { subagentTypes: { spawner: "extension" } })).toBe("plugin");
		expect(readSpawnerMode(null, { subagentTypes: { spawner: "extension" } })).toBe("extension");
		expect(readSpawnerMode({ subagentTypes: { spawner: "bogus" } }, null)).toBe("auto");
	});
});

describe("isPluginEnabled", () => {
	test("only enabled:true counts as enabled; all invalid forms fail open to false", () => {
		expect(isPluginEnabled({ plugins: { "paseo-subagents": { enabled: true } } })).toBe(true);
		expect(isPluginEnabled({ plugins: { "paseo-subagents": { enabled: false } } })).toBe(false);
		expect(isPluginEnabled({ plugins: { "other-plugin": { enabled: true } } })).toBe(false);
		expect(isPluginEnabled(null)).toBe(false);
		expect(isPluginEnabled({ plugins: null })).toBe(false);
		expect(isPluginEnabled("junk")).toBe(false);
	});
});

describe("effectiveSpawner", () => {
	test("auto follows plugin state; an explicit mode overrides everything", () => {
		expect(effectiveSpawner("auto", true)).toBe("plugin");
		expect(effectiveSpawner("auto", false)).toBe("extension");
		expect(effectiveSpawner("plugin", false)).toBe("plugin");
		expect(effectiveSpawner("extension", true)).toBe("extension");
	});
});
