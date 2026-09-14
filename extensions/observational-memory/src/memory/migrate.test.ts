import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_MARKER, listNestedMdFiles, migrateNestedTopics } from "./migrate.js";

function nest(root: string, rel: string, content: string): void {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

describe("v1.4.56 one-time nested-topic migration", () => {
	test("moves nested md up to root, regenerates INDEX, writes marker", () => {
		const root = mkdtempSync(join(tmpdir(), "ommig-"));
		nest(root, "01a0522e-x/goal-extension.md", "---\nid: goal-extension\n---\nbody");
		const r = migrateNestedTopics(root);
		expect(r.ran).toBe(true);
		expect(r.moved).toEqual(["01a0522e-x/goal-extension.md"]);
		expect(existsSync(join(root, "goal-extension.md"))).toBe(true);
		expect(existsSync(join(root, "01a0522e-x"))).toBe(false); // emptied dir removed
		expect(existsSync(join(root, MIGRATION_MARKER))).toBe(true);
		expect(readFileSync(join(root, "INDEX.md"), "utf-8")).toContain("goal-extension");
	});

	test("marker prevents a second run (new nested files left alone)", () => {
		const root = mkdtempSync(join(tmpdir(), "ommig-"));
		migrateNestedTopics(root);
		nest(root, "deep/later.md", "x");
		const r2 = migrateNestedTopics(root);
		expect(r2.ran).toBe(false);
		expect(existsSync(join(root, "deep", "later.md"))).toBe(true);
	});

	test("name collision at root → skipped, both files intact", () => {
		const root = mkdtempSync(join(tmpdir(), "ommig-"));
		writeFileSync(join(root, "dup.md"), "root version", "utf-8");
		nest(root, "sub/dup.md", "nested version");
		const r = migrateNestedTopics(root);
		expect(r.moved).toEqual([]);
		expect(r.skipped.length).toBe(1);
		expect(readFileSync(join(root, "dup.md"), "utf-8")).toBe("root version");
		expect(existsSync(join(root, "sub", "dup.md"))).toBe(true);
	});

	test("nested reserved names (INDEX.md/JOURNEY.md) are left in place", () => {
		const root = mkdtempSync(join(tmpdir(), "ommig-"));
		nest(root, "sub/INDEX.md", "generated strays stay");
		nest(root, "sub/journey.md", "reserved");
		const r = migrateNestedTopics(root);
		expect(r.moved).toEqual([]);
		expect(r.skipped.length).toBe(2);
	});

	test("dot-directories (.runs) and root-level md are untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "ommig-"));
		writeFileSync(join(root, "topic.md"), "root topic", "utf-8");
		nest(root, ".runs/inner/note.md", "ipc");
		expect(listNestedMdFiles(root)).toEqual([]);
		const r = migrateNestedTopics(root);
		expect(r.moved).toEqual([]);
		expect(existsSync(join(root, ".runs", "inner", "note.md"))).toBe(true);
		expect(readFileSync(join(root, "topic.md"), "utf-8")).toBe("root topic");
	});

	test("missing root → no-op", () => {
		const root = join(mkdtempSync(join(tmpdir(), "ommig-")), "never-created");
		expect(migrateNestedTopics(root).ran).toBe(false);
	});
});
