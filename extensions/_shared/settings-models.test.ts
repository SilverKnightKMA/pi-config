import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiDefaultModel, readSettingsString } from "./settings-models.ts";

const originalHome = process.env.HOME;

/** Isolate HOME so the global ~/.pi/agent/settings.json never leaks into a test. */
beforeEach(() => {
	const home = mkdtempSync(join(tmpdir(), "settings-models-home-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	process.env.HOME = home;
});

afterEach(() => {
	process.env.HOME = originalHome;
});

function workspace(settings: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "settings-models-"));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify(settings), "utf-8");
	return dir;
}

describe("readSettingsString", () => {
	test("reads a string key from workspace settings", () => {
		const dir = workspace({ factsCuratorModel: "magpie/deepseek" });
		expect(readSettingsString("factsCuratorModel", dir)).toBe("magpie/deepseek");
	});

	test("returns null for a missing key", () => {
		const dir = workspace({ other: 1 });
		expect(readSettingsString("factsCuratorModel", dir)).toBeNull();
	});

	test("ignores non-string values", () => {
		const dir = workspace({ factsCuratorModel: 42 });
		expect(readSettingsString("factsCuratorModel", dir)).toBeNull();
	});
});

describe("readPiDefaultModel", () => {
	test("joins defaultProvider and defaultModel", () => {
		const dir = workspace({ defaultProvider: "magpie", defaultModel: "glm-5.3" });
		expect(readPiDefaultModel(dir)).toBe("magpie/glm-5.3");
	});

	test("does not double the provider when defaultModel already carries it", () => {
		const dir = workspace({ defaultProvider: "magpie", defaultModel: "magpie/glm-5.3" });
		expect(readPiDefaultModel(dir)).toBe("magpie/glm-5.3");
	});

	test("returns null when the provider is missing", () => {
		const dir = workspace({ defaultModel: "glm-5.3" });
		expect(readPiDefaultModel(dir)).toBeNull();
	});

	test("returns null when the model is missing", () => {
		const dir = workspace({ defaultProvider: "magpie" });
		expect(readPiDefaultModel(dir)).toBeNull();
	});

	test("falls back to the global settings when the workspace names none", () => {
		const home = process.env.HOME as string;
		writeFileSync(
			join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ defaultProvider: "magpie", defaultModel: "global-model" }),
			"utf-8",
		);
		const dir = workspace({ other: 1 });
		expect(readPiDefaultModel(dir)).toBe("magpie/global-model");
	});
});
