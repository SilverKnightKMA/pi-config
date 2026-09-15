import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyStagedSections,
	buildFrontMatter,
	checkJourneyBudget,
	countWords,
	deriveTitle,
	journeyWordBudget,
	normalizeTarget,
	sanitizeSection,
	sanitizeSummary,
	type StagedSection,
} from "./staging.js";

describe("staging jail — normalizeTarget (v1.4.56)", () => {
	test("accepts flat kebab-case slugs, lowercases input", () => {
		expect(normalizeTarget("user-preferences.md")).toBe("user-preferences.md");
		expect(normalizeTarget("  Deploy-Pipeline.MD ")).toBe("deploy-pipeline.md");
	});

	test("rejects paths, reserved names, and malformed slugs", () => {
		expect(normalizeTarget("dir/x.md")).toBeUndefined();
		expect(normalizeTarget("01a0522e-x/goal-extension.md")).toBeUndefined();
		expect(normalizeTarget("../escape.md")).toBeUndefined();
		expect(normalizeTarget("INDEX.md")).toBeUndefined();
		expect(normalizeTarget("JOURNEY.md")).toBeUndefined();
		expect(normalizeTarget("sp ace.md")).toBeUndefined();
		expect(normalizeTarget("noext")).toBeUndefined();
		expect(normalizeTarget("")).toBeUndefined();
	});
});

describe("staging sanitizers", () => {
	test("sanitizeSection strips an accidental front-matter block", () => {
		const r = sanitizeSection("---\nid: x\n---\nreal body");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.text).toBe("real body");
	});

	test("sanitizeSection rejects empty and over-cap sections (no silent truncation)", () => {
		expect(sanitizeSection("   ").ok).toBe(false);
		const over = sanitizeSection("x".repeat(8_001));
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.reason).toContain("8000");
	});

	test("sanitizeSummary caps at 140 chars with ellipsis, collapses whitespace", () => {
		expect(sanitizeSummary("a".repeat(200))?.length).toBe(140);
		expect(sanitizeSummary("  a   b  ")).toBe("a b");
		expect(sanitizeSummary("")).toBeUndefined();
	});

	test("buildFrontMatter + deriveTitle shape", () => {
		expect(deriveTitle("user-preferences")).toBe("User Preferences");
		const fm = buildFrontMatter({ id: "auth", title: "Auth", summary: "s", updated: "2026-09-14T10:00" });
		expect(fm.startsWith("---\nid: auth\n")).toBe(true);
		expect(fm).toContain("updated: 2026-09-14T10:00\n---\n");
	});
});

describe("applyStagedSections (engine-append contract)", () => {
	function seed(root: string): void {
		writeFileSync(
			join(root, "auth.md"),
			"---\nid: auth\ntitle: Auth\nsummary: old summary\nupdated: 2026-09-01\n---\n\n## Old\nfirst section\n",
			"utf-8",
		);
	}

	test("appends with engine heading, bumps updated, replaces summary when given", () => {
		const root = mkdtempSync(join(tmpdir(), "omstg-"));
		seed(root);
		const items: StagedSection[] = [
			{ target: "auth.md", section: "token auth now uses scope `om.admin`.", summary: "OM token scopes" },
		];
		const out = applyStagedSections(root, "cons-T1", "2026-09-14T10:00", items);
		expect(out.applied).toEqual([{ target: "auth.md", created: false }]);
		expect(out.rejected).toEqual([]);
		const file = readFileSync(join(root, "auth.md"), "utf-8");
		expect(file).toContain("## 2026-09-14T10:00 (batch cons-T1)\ntoken auth now uses scope `om.admin`.");
		expect(file).toContain("updated: 2026-09-14T10:00");
		expect(file).toContain("summary: OM token scopes");
		expect(file).toContain("## Old\nfirst section"); // prior content intact
	});

	test("creates a brand-new topic with engine-built front-matter", () => {
		const root = mkdtempSync(join(tmpdir(), "omstg-"));
		const out = applyStagedSections(root, "cons-T2", "2026-09-14T11:00", [
			{ target: "deploy-pipeline.md", section: "First fact about deploys." },
		]);
		expect(out.applied).toEqual([{ target: "deploy-pipeline.md", created: true }]);
		const file = readFileSync(join(root, "deploy-pipeline.md"), "utf-8");
		expect(file.startsWith("---\nid: deploy-pipeline\n")).toBe(true);
		expect(file).toContain("title: Deploy Pipeline");
		expect(file).toContain("## 2026-09-14T11:00 (batch cons-T2)\nFirst fact about deploys.");
	});

	test("rejects path targets and reserved names without touching disk", () => {
		const root = mkdtempSync(join(tmpdir(), "omstg-"));
		const out = applyStagedSections(root, "cons-T3", "2026-09-14T12:00", [
			{ target: "nested/goal-extension.md", section: "x" },
			{ target: "INDEX.md", section: "x" },
		]);
		expect(out.applied).toEqual([]);
		expect(out.rejected.length).toBe(2);
		expect(existsSync(join(root, "nested"))).toBe(false);
	});

	test("rejects appending into a file without front-matter (no blind appends)", () => {
		const root = mkdtempSync(join(tmpdir(), "omstg-"));
		writeFileSync(join(root, "raw.md"), "no front-matter here\n", "utf-8");
		const out = applyStagedSections(root, "cons-T4", "2026-09-14T13:00", [{ target: "raw.md", section: "x" }]);
		expect(out.applied).toEqual([]);
		expect(out.rejected[0]?.reason).toContain("front-matter");
	});

	test("mixed batch: good items apply, bad items reject, order preserved", () => {
		const root = mkdtempSync(join(tmpdir(), "omstg-"));
		seed(root);
		const out = applyStagedSections(root, "cons-T5", "2026-09-14T14:00", [
			{ target: "auth.md", section: "good" },
			{ target: "bad/slug.md", section: "bad" },
		]);
		expect(out.applied.length).toBe(1);
		expect(out.rejected.length).toBe(1);
	});
});

describe("JOURNEY budget gate (replaces v1.4.54 enforceJourneyCap)", () => {
	test("journeyWordBudget: tokens→words with tolerance, floor 50", () => {
		expect(journeyWordBudget(1000)).toBe(750); // 1000 * 3 / 4 — v1.4.62 drops tolerance (upstream ~750 words)
		expect(journeyWordBudget(1)).toBe(50);
	});

	test("checkJourneyBudget: under passes, over reports overBy", () => {
		const under = checkJourneyBudget("one two three", 1000);
		expect(under.ok).toBe(true);
		expect(under.overBy).toBe(0);
		const words = Array.from({ length: 950 }, (_, i) => `w${i}`).join(" ");
		const over = checkJourneyBudget(words, 1000);
		expect(over.ok).toBe(false);
		expect(over.overBy).toBe(950 - over.budget);
		expect(countWords(words)).toBe(950);
	});
});
