/**
 * v1.4.56 consolidator kickoff tests: outline + RECENT TAIL views (never whole files),
 * journey last-section view, and the no-search contract line.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConsolidatorPrompt, TOPIC_TAIL_CHARS } from "../src/hooks/consolidator-trigger.js";
import type { Observation } from "../src/ledger/index.js";

function obs(timestamp: string, content: string): Observation {
	return { timestamp, content, tokenCount: Math.ceil(content.length / 4) };
}

function seed(root: string): { bigBody: string } {
	const filler = "old facts about the past. ".repeat(500);
	const bigBody =
		"---\nid: big\ntitle: Big\nsummary: big topic\nupdated: 2026-09-01\n---\n\n## Early\n" +
		filler +
		"\n\n## Recent\nthe tail fact MARKER-xyz.\n";
	writeFileSync(join(root, "big.md"), bigBody, "utf-8");
	writeFileSync(
		join(root, "JOURNEY.md"),
		"## Early history\nlong ago things happened\n\n## 2026-09-14\nmost recent arc details\n",
		"utf-8",
	);
	return { bigBody };
}

describe("v1.4.56 buildConsolidatorPrompt", () => {
	test("carries heading outline + RECENT TAIL, elides the head, mentions both tools", () => {
		const root = mkdtempSync(join(tmpdir(), "omprompt-"));
		const { bigBody } = seed(root);
		const prompt = buildConsolidatorPrompt(root, [obs("2026-09-14T10:00:00", "the new fact")], 1000);

		expect(prompt).toContain("HEADING OUTLINE");
		expect(prompt).toContain("## Early");
		expect(prompt).toContain("## Recent");
		expect(prompt).toContain("RECENT TAIL");
		// tail verbatim — the newest sections, where dedupe judgment happens
		expect(prompt).toContain("the tail fact MARKER-xyz.");
		// head elided for oversized topics
		expect(prompt).toContain("(older sections elided)");
		expect(prompt).toContain(bigBody.slice(-TOPIC_TAIL_CHARS));
		expect(prompt).not.toContain(bigBody.slice(0, 2000));
		// the no-search contract + both tools named
		expect(prompt).toContain("ALL INPUTS ARE IN THIS PROMPT");
		expect(prompt).toContain("submit_sections");
		expect(prompt).toContain("write_journey");
		// journey: headings + last section only
		expect(prompt).toContain("## 2026-09-14\nmost recent arc details");
		expect(prompt).not.toContain("## Early history\nlong ago things happened");
		// the observation to fold
		expect(prompt).toContain("2026-09-14T10:00:00");
		expect(prompt).toContain("the new fact");
	});

	test("journey budget stated in words and no mechanical-cap language", () => {
		const root = mkdtempSync(join(tmpdir(), "omprompt-"));
		seed(root);
		const prompt = buildConsolidatorPrompt(root, [], 1000);
		expect(prompt).toContain("~750 words"); // 1000 tokens * 3/4
		expect(prompt).not.toContain("hard-caps");
		expect(prompt).not.toContain("engine caps");
	});

	test("empty memory: works with no topics and no journey", () => {
		const root = mkdtempSync(join(tmpdir(), "omprompt-"));
		const prompt = buildConsolidatorPrompt(root, [obs("2026-09-14T11:00:00", "first fact ever")], 1000);
		expect(prompt).toContain("first fact ever");
		expect(prompt).toContain("(no journey yet; start one)");
	});
});
