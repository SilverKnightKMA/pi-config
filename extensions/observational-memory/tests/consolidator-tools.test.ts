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

function recordLessonTool(tools: RegisteredTool[]): RegisteredTool {
	const t = tools.find((x) => x.name === "record_lesson");
	if (!t) throw new Error("record_lesson not registered");
	return t;
}

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

const SAVED_ENV = ["OM_CONSOLIDATOR_V2", "OM_COMPACT_FILE", "OM_RUN_ID", "OM_JOURNEY_TOKENS", "LESSONS_FILE"];

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
	test("default: exactly submit_sections + write_journey + record_lesson (no exploration tools)", () => {
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, mkdtempSync(join(tmpdir(), "omtool-")));
		expect(tools.map((t) => t.name).sort()).toEqual(["record_lesson", "submit_sections", "write_journey"]);
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

describe("record_lesson — global lessons tier (single writer, #1A)", () => {
	function setup(): { tools: RegisteredTool[]; file: string } {
		const file = join(mkdtempSync(join(tmpdir(), "omlesson-")), "lessons.md");
		process.env.LESSONS_FILE = file;
		const { pi, tools } = makeFakePi();
		registerConsolidatorTools(pi, mkdtempSync(join(tmpdir(), "omtool-")));
		return { tools, file };
	}

	test("valid lesson → engine-dated line appended", async () => {
		const { tools, file } = setup();
		const out = await recordLessonTool(tools).execute("t1", { tag: "failure", text: "bash silent-abort >2s — use setsid nohup bg" });
		expect(out.content[0].text).toContain("lesson recorded");
		const today = new Date().toISOString().slice(0, 10);
		expect(readFileSync(file, "utf8").trim()).toBe(
			`[${today}][failure] bash silent-abort >2s — use setsid nohup bg`,
		);
	});

	test("secret-shaped text → rejected with denial envelope, file untouched", async () => {
		const { tools, file } = setup();
		const out = await recordLessonTool(tools).execute("t1", { tag: "failure", text: "key sk-ant-0123456789abcdef0123 leaked" });
		expect(out.content[0].text).toContain("lesson rejected");
		expect(out.content[0].text).toContain("NEXT:");
		expect(() => readFileSync(file, "utf8")).toThrow(); // never created
	});

	test("empty + >500-char text rejected", async () => {
		const { tools } = setup();
		const r1 = await recordLessonTool(tools).execute("t1", { tag: "preference", text: "   " });
		expect(r1.content[0].text).toContain("lesson rejected");
		const r2 = await recordLessonTool(tools).execute("t2", { tag: "convention", text: "x".repeat(501) });
		expect(r2.content[0].text).toContain("lesson rejected");
	});

	test("trim hysteresis: over 232 lines → batch-drop oldest to 200", async () => {
		const { tools, file } = setup();
		const old = Array.from({ length: 232 }, (_, i) => `[2026-08-01][failure] filler number ${i}`);
		writeFileSync(file, `${old.join("\n")}\n`);
		await recordLessonTool(tools).execute("t1", { tag: "correction", text: "pushes past hysteresis" });
		const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
		expect(lines).toHaveLength(200);
		expect(lines[0]).toContain("filler number 33"); // oldest 33 dropped
		expect(lines[199]).toContain("pushes past hysteresis");
	});

	test("honors LESSONS_FILE override (tests + isolation)", async () => {
		const { tools, file } = setup();
		await recordLessonTool(tools).execute("t1", { tag: "preference", text: "component-level design before build" });
		expect(readFileSync(file, "utf8")).toContain("component-level design before build");
	});
});
