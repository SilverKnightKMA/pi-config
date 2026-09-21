/** facts-core store tests — P1a (plan 2026-09-21, step #174). Pure, red-green. */
import { describe, expect, test } from "bun:test";
import {
	buildFactLine,
	expireTtlFacts,
	factContainsSecret,
	formatFact,
	matchFactsByKeywords,
	newFactId,
	parseFactLine,
	parseFactsFile,
	renderFactsBlock,
	selectFactsForInject,
	serializeFacts,
	tombstoneFact,
	updateFactInPlace,
	type Fact,
} from "./store.ts";

const L = (s: string) => parseFactLine(s)!;

describe("parse / serialize roundtrip", () => {
	test("live line", () => {
		const f = L("[convention][2026-09-21][P1] test runner is bun (#a1b2c3)");
		expect(f).toMatchObject({ category: "convention", date: "2026-09-21", priority: "P1", text: "test runner is bun", id: "a1b2c3" });
		expect(f.ttl).toBeUndefined();
		expect(f.tombstoned).toBeUndefined();
	});

	test("ttl + tombstone suffixes in fixed order", () => {
		const f = L("[ops][2026-09-01][P3] door port 40579 (#d4e5f6) ttl=2026-10-01 tombstoned=2026-10-02 reason=ttl-expired");
		expect(f.ttl).toBe("2026-10-01");
		expect(f.tombstoned).toBe("2026-10-02");
		expect(f.reason).toBe("ttl-expired");
	});

	test("tombstone without ttl", () => {
		const f = L("[decision][2026-09-05][P2] drop @pify/memory whole (#abc123) tombstoned=2026-09-20 reason=superseded");
		expect(f.tombstoned).toBe("2026-09-20");
		expect(f.reason).toBe("superseded");
	});

	test("serialize(parse(x)) === x for all shapes", () => {
		const lines = [
			"[identity][2026-08-30][P1] prefers plain Vietnamese + house analogies (#f0e1d2)",
			"[ops][2026-09-01][P3] door port 40579 (#d4e5f6) ttl=2026-10-01",
			"[decision][2026-09-05][P2] drop whole package (#abc123) tombstoned=2026-09-20 reason=superseded",
		];
		expect(serializeFacts(parseFactsFile(lines.join("\n")))).toBe(lines.join("\n"));
	});
});

describe("reject rules (fail-closed)", () => {
	test("malformed lines are dropped, not thrown", () => {
		const bad = [
			"", // empty
			"random note without format",
			"[convention][21-09-01][P1] bad date (#a1b2c3)",
			"[nope][2026-09-01][P1] unknown category (#a1b2c3)",
			"[convention][2026-09-01][P9] unknown priority (#a1b2c3)",
			"[convention][2026-09-01][P1] missing id",
			"[convention][2026-09-01][P1] bad id len (#a1b2c)",
		];
		expect(parseFactsFile(bad.join("\n"))).toEqual([]);
	});

	test("secret-bearing fact never parses in", () => {
		expect(factContainsSecret("key sk-ant-AAAABBBBCCCCDDDD1234 here")).toBe(true);
		const content = "[ops][2026-09-01][P1] token sk-ant-AAAABBBBCCCCDDDD1234 (#a1b2c3)";
		expect(parseFactsFile(content)).toEqual([]);
	});

	test("buildFactLine rejects bad input with null", () => {
		expect(buildFactLine({ category: "nope", date: "2026-09-21", priority: "P1", text: "x" })).toBeNull();
		expect(buildFactLine({ category: "ops", date: "2026-13-99", priority: "P1", text: "x" })).toBeNull();
		expect(buildFactLine({ category: "ops", date: "2026-09-21", priority: "P1", text: "  " })).toBeNull();
		expect(buildFactLine({ category: "ops", date: "2026-09-21", priority: "P1", text: "a\nb" })).toBeNull();
		expect(buildFactLine({ category: "ops", date: "2026-09-21", priority: "P1", text: "sk-ant-AAAABBBBCCCCDDDD1234" })).toBeNull();
		expect(buildFactLine({ category: "ops", date: "2026-02-30", priority: "P1", text: "not a real day" })).toBeNull();
	});

	test("buildFactLine ok path with fixed id", () => {
		expect(buildFactLine({ category: "ops", date: "2026-09-21", priority: "P1", text: "ok", id: "beef01" })).toBe(
			"[ops][2026-09-21][P1] ok (#beef01)",
		);
	});
});

describe("newFactId", () => {
	test("unique against existing set", () => {
		const taken = new Set(["000000", "000001"]);
		let calls = 0;
		const seq = () => {
			calls++;
			return calls <= 2 ? 0 / 16 : 0.5; // "000000", "000001", then cccccc-ish
		};
		const id = newFactId(taken, seq);
		expect(id).not.toBe("000000");
		expect(id).not.toBe("000001");
		expect(id).toMatch(/^[a-f0-9]{6}$/);
	});
});

describe("edit-in-place by id", () => {
	test("patch replaces the SAME line — no duplicate id, no append", () => {
		const facts = [
			L("[convention][2026-09-01][P1] test bằng bun (#a1b2c3)"),
			L("[preference][2026-09-02][P2] prefers bun over node (#f0e1d2)"),
		];
		const { facts: out, changed } = updateFactInPlace(facts, "a1b2c3", {
			text: "test bằng npm",
			date: "2026-09-21",
		});
		expect(changed).toBe(true);
		expect(out).toHaveLength(2);
		expect(out[0].text).toBe("test bằng npm");
		expect(out[0].date).toBe("2026-09-21");
		expect(out[1].id).toBe("f0e1d2");
		expect(out.filter((f) => f.id === "a1b2c3")).toHaveLength(1);
	});

	test("unknown id / empty patch / tombstoned target = no-op", () => {
		const facts = [L("[ops][2026-09-01][P1] alive (#a1b2c3)")];
		expect(updateFactInPlace(facts, "zzzzzz", { text: "x" }).changed).toBe(false);
		expect(updateFactInPlace(facts, "a1b2c3", {}).changed).toBe(false);
		const dead = [L("[ops][2026-09-01][P1] gone (#a1b2c3) tombstoned=2026-09-10 reason=superseded")];
		expect(updateFactInPlace(dead, "a1b2c3", { text: "x" }).changed).toBe(false);
	});

	test("invalid patched line (secret smuggled) = fail-closed no-op", () => {
		const facts = [L("[ops][2026-09-01][P1] alive (#a1b2c3)")];
		expect(updateFactInPlace(facts, "a1b2c3", { text: "sk-ant-AAAABBBBCCCCDDDD1234" }).changed).toBe(false);
		expect(facts[0].text).toBe("alive"); // input untouched
	});
});

describe("lifecycle: ttl + tombstone", () => {
	test("ttl reached -> tombstoned reason=ttl-expired, text kept", () => {
		const facts = [
			L("[ops][2026-09-01][P3] door port 40579 (#d4e5f6) ttl=2026-09-21"),
			L("[ops][2026-09-01][P3] future (#b1b2b3) ttl=2026-12-31"),
			L("[convention][2026-09-01][P1] no ttl (#c1c2c3)"),
		];
		const { facts: out, expired } = expireTtlFacts(facts, "2026-09-21");
		expect(expired).toEqual(["d4e5f6"]);
		const dead = out.find((f) => f.id === "d4e5f6")!;
		expect(dead.tombstoned).toBe("2026-09-21");
		expect(dead.reason).toBe("ttl-expired");
		expect(dead.text).toBe("door port 40579"); // recovery span: original kept
		expect(dead.date).toBe("2026-09-01");
		expect(out.find((f) => f.id === "b1b2b3")!.tombstoned).toBeUndefined();
		expect(out.find((f) => f.id === "c1c2c3")!.tombstoned).toBeUndefined();
	});

	test("idempotent: second run expires nothing", () => {
		const facts = [L("[ops][2026-09-01][P3] x (#d4e5f6) ttl=2026-09-21")];
		const once = expireTtlFacts(facts, "2026-09-21");
		expect(expireTtlFacts(once.facts, "2026-09-22").expired).toEqual([]);
	});

	test("tombstoneFact keeps everything, adds verdict fields", () => {
		const f = L("[decision][2026-09-05][P2] keep design (#abc123)");
		const t = tombstoneFact(f, "2026-09-20", "contradicted");
		expect(t.text).toBe("keep design");
		expect(formatFact(t)).toBe(
			"[decision][2026-09-05][P2] keep design (#abc123) tombstoned=2026-09-20 reason=contradicted",
		);
	});
});

describe("keyword match (trigger support)", () => {
	const facts = [
		L("[convention][2026-09-01][P1] test bằng bun (#a1b2c3)"),
		L("[preference][2026-09-02][P2] bun over node (#f0e1d2)"),
		L("[convention][2026-09-01][P1] gone (#dead00) tombstoned=2026-09-10 reason=superseded"),
	];

	test("requires EVERY keyword, live only by default, best score first", () => {
		const hits = matchFactsByKeywords(facts, ["bun", "node"]);
		expect(hits.map((h) => h.fact.id)).toEqual(["f0e1d2"]);
		expect(hits[0].score).toBe(2);
	});

	test("all-keyword miss returns empty; tombstoned excluded unless asked", () => {
		expect(matchFactsByKeywords(facts, ["bun", "npm"])).toEqual([]);
		expect(matchFactsByKeywords(facts, ["gone"], { includeTombstoned: true })).toHaveLength(1);
	});
});

describe("PUSH inject selection", () => {
	const mk = (id: string, priority: "P1" | "P2" | "P3", date: string, text: string): Fact =>
		({ id, category: "project", date, priority, text });

	test("P1 before P2 before P3; newest first inside a tier", () => {
		const facts = [
			mk("a1", "P2", "2026-09-01", "p2 old"),
			mk("a2", "P1", "2026-09-10", "p1 new"),
			mk("a3", "P1", "2026-09-20", "p1 newest"),
			mk("a4", "P3", "2026-09-05", "p3"),
			mk("a5", "P2", "2026-09-15", "p2 new"),
		];
		const sel = selectFactsForInject(facts, { maxLines: 10, maxChars: 10000 });
		expect(sel.map((f) => f.id)).toEqual(["a3", "a2", "a5", "a1", "a4"]);
	});

	test("tombstoned never injected", () => {
		const facts: Fact[] = [
			{ ...mk("a1", "P1", "2026-09-01", "dead"), tombstoned: "2026-09-10", reason: "superseded" },
			mk("a2", "P1", "2026-09-02", "alive"),
		];
		expect(selectFactsForInject(facts, { maxLines: 10, maxChars: 10000 }).map((f) => f.id)).toEqual(["a2"]);
	});

	test("cuts by BOTH maxLines and maxChars", () => {
		const facts = [
			mk("a1", "P1", "2026-09-01", "short"),
			mk("a2", "P1", "2026-09-02", "a".repeat(100)),
			mk("a3", "P1", "2026-09-03", "also short"),
		];
		const byLines = selectFactsForInject(facts, { maxLines: 2, maxChars: 10000 });
		expect(byLines).toHaveLength(2);
		const byChars = selectFactsForInject(facts, { maxLines: 10, maxChars: 60 });
		expect(byChars.some((f) => f.id === "a2")).toBe(false); // 100-char line over budget
		expect(byChars.every((f) => formatFact(f).length + 1 <= 60)).toBe(true);
	});
});

describe("renderFactsBlock", () => {
	test("header + one line per fact; empty -> empty string", () => {
		const block = renderFactsBlock([
			L("[preference][2026-09-02][P1] prefers bun over node (#f0e1d2)"),
		]);
		expect(block.split("\n")[0]).toContain("Facts");
		expect(block).toContain("prefers bun over node (#f0e1d2)");
		expect(renderFactsBlock([])).toBe("");
	});
});
