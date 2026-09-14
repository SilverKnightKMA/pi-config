import { describe, expect, test } from "bun:test";
import { splitJourneySections } from "./paths.js";

describe("journey sections (v1.4.56 — cap removed, gate lives in write_journey)", () => {
	test("splitJourneySections keeps headings attached, drops empty preamble", () => {
		const parts = splitJourneySections("\n\n## A\none\n\n## B\ntwo\n");
		expect(parts.length).toBe(2);
		expect(parts[0].startsWith("## A")).toBe(true);
		expect(parts[1].trim().endsWith("two")).toBe(true);
	});

	test("splitJourneySections returns [] for empty/whitespace-only journey", () => {
		expect(splitJourneySections("").length).toBe(0);
		expect(splitJourneySections("\n\n   \n").length).toBe(0);
	});
});
