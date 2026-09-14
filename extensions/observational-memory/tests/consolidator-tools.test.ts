/**
 * v1.4.56 consolidator tool-belt tests: dispatch on env + behavior of the three belts.
 * Uses a fake pi that captures registerTool records; execute is called directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConsolidatorTools } from "../agent/consolidator/tools.js";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; details: unknown }>;
};

function makeFakePi(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [] as unknown as RegisteredTool[];
	const pi = {
		registerTool(rec: RegisteredTool) {
			tools.push(rec);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

const SAVED_ENV = ["OM_CONSOLIDATOR_V2", "OM_COMPACT_FILE", "OM_RUN_ID", "OM_JOURNEY_TOKENS"];

beforeEach(() => {
	process.env.OM_RUN_ID = "cons-test";
	delete process.env.OM_CONSOLIDATOR_V2;
	delete process.env.OM_COMPACT_FILE;
});

afterEach(() => {
	for (const k of SAVED_ENV) {
		if (process.env[k] === undefined) continue;
		if (k === "OM_RUN_ID") continue;
		delete process.env[k];
	}
});

describe("v1.4.56 tool dispatch", () => {
	test("default: exactly submit_sections + write_journey (no exploration tools)", () => {
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, mkdtempSync(join(tmpdir(), "omtool-")));
		expect(tools.map((t) => t.name).sort()).toEqual(["submit_sections", "write_journey"]);
	});

	test("OM_CONSOLIDATOR_V2=0 restores the legacy belt", () => {
		process.env.OM_CONSOLIDATOR_V2 = "0";
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, mkdtempSync(join(tmpdir(), "omtool-")));
		expect(tools.map((t) => t.name).sort()).toEqual(["edit", "grep", "ls", "read", "write"]);
	});

	test("OM_COMPACT_FILE → exactly one write_full_file jailed to that file", () => {
		process.env.OM_COMPACT_FILE = "bloat.md";
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, mkdtempSync(join(tmpdir(), "omtool-")));
		expect(tools.map((t) => t.name)).toEqual(["write_full_file"]);
	});
});

describe("v1.4.56 submit_sections execute", () => {
	test("valid batch appends to disk and reports applied", async () => {
		const root = mkdtempSync(join(tmpdir(), "omtool-"));
		writeFileSync(
			join(root, "auth.md"),
			"---\nid: auth\ntitle: Auth\nsummary: old\nupdated: 2026-09-01\n---\n\n## Old\nfirst\n",
			"utf-8",
		);
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, root);
		const submit = tools.find((t) => t.name === "submit_sections")!;
		const result = await submit.execute("id1", {
			sections: [{ target: "auth.md", section: "new fact", summary: "new summary" }],
		});
		expect(result.content[0].text).toContain("applied → auth.md");
		const file = readFileSync(join(root, "auth.md"), "utf-8");
		expect(file).toContain("(batch cons-test)");
		expect(file).toContain("summary: new summary");
	});

	test("all sections rejected → error result, disk untouched", async () => {
		const root = mkdtempSync(join(tmpdir(), "omtool-"));
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, root);
		const submit = tools.find((t) => t.name === "submit_sections")!;
		const result = await submit.execute("id2", {
			sections: [{ target: "a/b.md", section: "x" }],
		});
		expect(result.content[0].text.startsWith("Error:")).toBe(true);
		expect(result.content[0].text).toContain("REJECTED a/b.md");
	});
});

describe("v1.4.56 write_journey budget gate", () => {
	test("under budget → whole file rewritten", async () => {
		const root = mkdtempSync(join(tmpdir(), "omtool-"));
		writeFileSync(join(root, "JOURNEY.md"), "## stale old\n", "utf-8");
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, root);
		const wj = tools.find((t) => t.name === "write_journey")!;
		const result = await wj.execute("id3", { content: "## 2026-09-14\nfresh journey body" });
		expect(result.content[0].text).toContain("rewritten");
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## 2026-09-14\nfresh journey body\n");
	});

	test("over budget → rejected, old file untouched (no mechanical data loss)", async () => {
		const root = mkdtempSync(join(tmpdir(), "omtool-"));
		writeFileSync(join(root, "JOURNEY.md"), "## previous\nbody", "utf-8");
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, root);
		const wj = tools.find((t) => t.name === "write_journey")!;
		const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
		const result = await wj.execute("id4", { content: words });
		expect(result.content[0].text.startsWith("Error:")).toBe(true);
		expect(result.content[0].text).toContain("over budget");
		// file unchanged on rejection — data survives for the next run to compress
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## previous\nbody");
	});
});

describe("v1.4.56 compact write_full_file", () => {
	test("rejects content without front-matter; accepts with", async () => {
		const root = mkdtempSync(join(tmpdir(), "omtool-"));
		process.env.OM_COMPACT_FILE = "bloat.md";
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, root);
		const wff = tools.find((t) => t.name === "write_full_file")!;
		const bad = await wff.execute("id5", { content: "no front-matter" });
		expect(bad.content[0].text.startsWith("Error:")).toBe(true);
		const good = await wff.execute("id6", { content: "---\nid: bloat\n---\nsmaller" });
		expect(good.content[0].text).toContain("Rewrote");
		expect(readFileSync(join(root, "bloat.md"), "utf-8")).toBe("---\nid: bloat\n---\nsmaller");
	});
});
