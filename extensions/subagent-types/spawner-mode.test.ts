import { describe, expect, test } from "bun:test";
import { effectiveSpawner, isPluginEnabled, readSpawnerMode } from "./spawner-mode";

describe("readSpawnerMode", () => {
	test("mặc định auto; ws thắng user; giá trị lạ bỏ qua", () => {
		expect(readSpawnerMode(null, null)).toBe("auto");
		expect(readSpawnerMode({ subagentTypes: { spawner: "plugin" } }, { subagentTypes: { spawner: "extension" } })).toBe("plugin");
		expect(readSpawnerMode(null, { subagentTypes: { spawner: "extension" } })).toBe("extension");
		expect(readSpawnerMode({ subagentTypes: { spawner: "bogus" } }, null)).toBe("auto");
	});
});

describe("isPluginEnabled", () => {
	test("enabled:true mới tính bật; mọi dạng lỗi fail-open false", () => {
		expect(isPluginEnabled({ plugins: { "paseo-subagents": { enabled: true } } })).toBe(true);
		expect(isPluginEnabled({ plugins: { "paseo-subagents": { enabled: false } } })).toBe(false);
		expect(isPluginEnabled({ plugins: { "other-plugin": { enabled: true } } })).toBe(false);
		expect(isPluginEnabled(null)).toBe(false);
		expect(isPluginEnabled({ plugins: null })).toBe(false);
		expect(isPluginEnabled("junk")).toBe(false);
	});
});

describe("effectiveSpawner", () => {
	test("auto theo plugin; ép mode thắng tất cả", () => {
		expect(effectiveSpawner("auto", true)).toBe("plugin");
		expect(effectiveSpawner("auto", false)).toBe("extension");
		expect(effectiveSpawner("plugin", false)).toBe("plugin");
		expect(effectiveSpawner("extension", true)).toBe("extension");
	});
});
