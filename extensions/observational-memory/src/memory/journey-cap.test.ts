import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceJourneyCap, splitJourneySections, journeyPath } from "./paths.js";

function mkJourney(root: string, sections: string[]): void {
	writeFileSync(journeyPath(root), sections.join("\n\n"), "utf-8");
}

describe("journey hard cap (v1.4.54 #54)", () => {
	test("splitJourneySections keeps headings attached, drops empty preamble", () => {
		const parts = splitJourneySections("\n\n## A\none\n\n## B\ntwo\n");
		expect(parts.length).toBe(2);
		expect(parts[0].startsWith("## A")).toBe(true);
		expect(parts[1].trim().endsWith("two")).toBe(true);
	});

	test("under budget → untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "omcap-"));
		mkJourney(root, ["## S1", "small"]);
		const r = enforceJourneyCap(root, 1000);
		expect(r.changed).toBe(false);
		expect(readFileSync(journeyPath(root), "utf-8")).toBe("## S1\n\nsmall");
	});

	test("over budget → drops OLDEST first, newest always survives, marker written", () => {
		const root = mkdtempSync(join(tmpdir(), "omcap-"));
		const big = "word ".repeat(400).trim();
		mkJourney(root, ["## OLD-1\n" + big, "## OLD-2\n" + big, "## NEWEST\n" + big]);
		const r = enforceJourneyCap(root, 1000); // budget = 1125 words; 3 sections ≈ 1206 → must shed OLD-1
		expect(r.changed).toBe(true);
		const out = readFileSync(journeyPath(root), "utf-8");
		expect(out).not.toContain("OLD-1");
		expect(out).toContain("NEWEST");
		expect(out).toContain("v1.4.54 cap");
		expect(r.words).toBeLessThanOrEqual(1125 + 20);
	});

	test("never drops below a floor of 50 words even with absurdly small target", () => {
		const root = mkdtempSync(join(tmpdir(), "omcap-"));
		mkJourney(root, ["## ONLY\n" + "x ".repeat(60).trim()]);
		const r = enforceJourneyCap(root, 1);
		// Single section: nothing droppable — stays intact rather than emptied.
		expect(readFileSync(journeyPath(root), "utf-8")).toContain("## ONLY");
		expect(r.changed).toBe(true); // still rewrote with marker
	});

	test("missing journey → no-op", () => {
		const root = mkdtempSync(join(tmpdir(), "omcap-"));
		const r = enforceJourneyCap(root, 1000);
		expect(r.changed).toBe(false);
		expect(r.words).toBe(0);
	});
});
