/** facts_recall backend tests — P1c (#176). Pure. */
import { describe, expect, test } from "bun:test";
import { parseFactLine } from "./store.ts";
import { recallFacts, renderRecallReport } from "./recall.ts";

const F = (s: string) => parseFactLine(s)!;
const facts = [
	F("[preference][2026-09-02][P1] user prefers bun over node for test runs (#aaa001)"),
	F("[convention][2026-09-01][P1] test runner is bun in this repo (#aaa002)"),
	F("[ops][2026-09-01][P3] door port 40579 (#aaa003) ttl=2026-12-31"),
	F("[decision][2026-08-30][P2] dropped @pify/memory whole package (#aaa004) tombstoned=2026-09-20 reason=superseded"),
];

describe("recallFacts", () => {
	test("all-keywords (AND) pass: every keyword must appear", () => {
		const r = recallFacts(facts, { query: "bun node" });
		expect(r.mode).toBe("all-keywords");
		expect(r.hits.map((h) => h.fact.id)).toEqual(["aaa001"]);
		expect(r.live).toBe(3);
		expect(r.tombstoned).toBe(1);
	});

	test("any-keyword fallback when AND misses everything", () => {
		const r = recallFacts(facts, { query: "door npm" });
		expect(r.mode).toBe("any-keyword");
		expect(r.hits.some((h) => h.fact.id === "aaa003")).toBe(true);
		expect(r.hits.every((h) => !h.matchedAll)).toBe(true);
	});

	test("tombstoned excluded by default, included on flag", () => {
		expect(recallFacts(facts, { query: "@pify/memory" }).hits).toHaveLength(0);
		const r = recallFacts(facts, { query: "@pify/memory", includeTombstoned: true });
		expect(r.hits.map((h) => h.fact.id)).toEqual(["aaa004"]);
		expect(r.hits[0].fact.tombstoned).toBe("2026-09-20");
	});

	test("category filter narrows the pool", () => {
		const r = recallFacts(facts, { query: "bun", category: "convention" });
		expect(r.hits.map((h) => h.fact.id)).toEqual(["aaa002"]);
		expect(recallFacts(facts, { query: "bun", category: "identity" }).hits).toHaveLength(0);
	});

	test("unknown category → error note, not a throw", () => {
		const r = recallFacts(facts, { query: "x", category: "nope" });
		expect(r.mode).toBe("unknown-category");
		expect(r.note).toContain("nope");
	});

	test("empty query → error note", () => {
		expect(recallFacts(facts, { query: "   " }).mode).toBe("empty-query");
	});

	test("hit cap at 30", () => {
		const many = Array.from({ length: 50 }, (_, i) =>
			F(`[ops][2026-09-01][P2] fact about caching number ${i} (#${i.toString(16).padStart(6, "0")})`),
		);
		const r = recallFacts(many, { query: "caching" });
		expect(r.hits).toHaveLength(30);
	});
});

describe("renderRecallReport", () => {
	test("live/dead flags + partial marker in output", () => {
		const out = renderRecallReport(recallFacts(facts, { query: "bun", category: "convention" }));
		expect(out).toContain("[live] [convention][2026-09-01][P1] test runner is bun in this repo (#aaa002)");
		const partial = renderRecallReport(recallFacts(facts, { query: "door npm" }));
		expect(partial).toContain("mode=any-keyword");
		expect(partial).toContain("(partial match)");
		const dead = renderRecallReport(recallFacts(facts, { query: "@pify/memory", includeTombstoned: true }));
		expect(dead).toContain("[dead:superseded]");
	});

	test("zero-hit message is informative, not an error", () => {
		const out = renderRecallReport(recallFacts(facts, { query: "zzz-never" }));
		expect(out).toContain("0 hit(s)");
		expect(out).toContain("no matching fact");
	});
});
