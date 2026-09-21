/** memory-curator core tests — P3 (#180). Pure. */
import { describe, expect, test } from "bun:test";
import { parseFactLine, serializeFacts } from "./store.ts";
import {
	applyPlan,
	buildReceipt,
	curatorThresholds,
	extractJson,
	initialCuratorState,
	sha256Content,
	shouldRunCurator,
	validatePlan,
} from "./curator-core.ts";

const F = (s: string) => parseFactLine(s)!;
const facts = [
	F("[convention][2026-09-01][P1] test runner: bun (#aaa001)"),
	F("[preference][2026-09-02][P2] prefers plain Vietnamese (#aaa002)"),
	F("[ops][2026-09-03][P3] port 34091 (#aaa003)"),
	F("[decision][2026-08-30][P2] drop whole package (#aaa004)"),
	F("[project][2026-09-05][P1] memory part 2 hybrid (#aaa005)"),
];
const T = curatorThresholds({});

describe("curatorThresholds", () => {
	test("defaults + env knobs + kill switch", () => {
		expect(T).toMatchObject({ enabled: true, minLines: 10, minTokens: 2_000_000, minSessions: 15, floorDays: 30, quotaPct: 20, maxProposals: 5 });
		expect(curatorThresholds({ FACTS_CURATOR: "0" }).enabled).toBe(false);
		expect(curatorThresholds({ FACTS_CURATOR_MIN_LINES: "3" }).minLines).toBe(3);
	});
});

describe("shouldRunCurator (usage-triggered, NOT scheduled)", () => {
	const base = { factsBaseline: 5, lessonsBaseline: 8 };
	const snap = (o: Partial<Parameters<typeof shouldRunCurator>[1]>) => ({
		factLines: 5,
		lessonLines: 8,
		tokensSinceRun: 0,
		sessionsSinceRun: 0,
		...o,
	});

	test("below thresholds → no run", () => {
		expect(shouldRunCurator({ ...initialCuratorState(), ...base }, snap({}), T)).toEqual({ run: false, reason: "below-thresholds" });
	});
	test("≥10 changed lines → run (lines)", () => {
		expect(shouldRunCurator({ ...initialCuratorState(), ...base }, snap({ factLines: 15 }), T)).toEqual({ run: true, reason: "lines" });
	});
	test("≥2M tokens → run (tokens)", () => {
		expect(shouldRunCurator({ ...initialCuratorState(), ...base }, snap({ tokensSinceRun: 2_000_000 }), T)).toEqual({ run: true, reason: "tokens" });
	});
	test("≥15 sessions → run (sessions)", () => {
		expect(shouldRunCurator({ ...initialCuratorState(), ...base }, snap({ sessionsSinceRun: 15 }), T)).toEqual({ run: true, reason: "sessions" });
	});
	test("30-day floor → run (floor)", () => {
		const old = { ...initialCuratorState(new Date("2026-08-01T00:00:00Z")), ...base };
		expect(shouldRunCurator(old, snap({}), T, new Date("2026-09-01T00:00:00Z"))).toEqual({ run: true, reason: "floor" });
	});
	test("disabled → never runs", () => {
		expect(shouldRunCurator({ ...initialCuratorState(), ...base }, snap({ tokensSinceRun: 99_999_999 }), { ...T, enabled: false })).toEqual({ run: false, reason: "disabled" });
	});
});

describe("extractJson", () => {
	test("clean parse, prose-wrapped parse, garbage → null", () => {
		expect(extractJson('{"verdicts":[]}')).toEqual({ verdicts: [] });
		expect(extractJson('Sure!\n```json\n{"verdicts":[]}\n```\ndone')).toEqual({ verdicts: [] });
		expect(extractJson("no json here at all")).toBeNull();
	});
});

describe("validatePlan (fail-closed whole plan)", () => {
	const plan = (verdicts: unknown[], proposals?: unknown[]) => JSON.stringify({ verdicts, ...(proposals ? { proposals } : {}) });

	test("valid plan passes", () => {
		const v = validatePlan(plan([{ id: "aaa001", verdict: "SUPERSEDED", evidence: "user switched runner to npm (trigger.log 2026-09-21)" }]), facts, T);
		expect(v.ok).toBe(true);
	});

	test("unknown id / bad verdict / missing evidence / duplicate id all refuse", () => {
		expect(validatePlan(plan([{ id: "zzzzzz", verdict: "KEEP", evidence: "x" }]), facts, T).ok).toBe(false);
		expect(validatePlan(plan([{ id: "aaa001", verdict: "MAYBE", evidence: "x" }]), facts, T).ok).toBe(false);
		expect(validatePlan(plan([{ id: "aaa001", verdict: "KEEP" }]), facts, T).ok).toBe(false);
		expect(
			validatePlan(
				plan([
					{ id: "aaa001", verdict: "KEEP", evidence: "x" },
					{ id: "aaa001", verdict: "KEEP", evidence: "y" },
				]),
				facts,
				T,
			).ok,
		).toBe(false);
	});

	test("already-tombstoned target refused", () => {
		const dead = [F("[ops][2026-09-01][P1] gone (#aaa001) tombstoned=2026-09-10 reason=superseded")];
		expect(validatePlan(plan([{ id: "aaa001", verdict: "DORMANT", evidence: "x" }]), dead, T).ok).toBe(false);
	});

	test("quota: >20% of live lines mutating → refuse; exactly 20% passes", () => {
		// 5 live → quota floor(5*0.2)=1
		expect(validatePlan(plan([
			{ id: "aaa001", verdict: "SUPERSEDED", evidence: "x" },
			{ id: "aaa002", verdict: "DORMANT", evidence: "y" },
		]), facts, T).ok).toBe(false);
		expect(validatePlan(plan([{ id: "aaa001", verdict: "SUPERSEDED", evidence: "x" }]), facts, T).ok).toBe(true);
	});

	test("proposal validation: invalid line or missing source refused", () => {
		expect(
			validatePlan(plan([], [{ category: "nope", date: "2026-09-21", priority: "P1", text: "x", source: "s" }]), facts, T).ok,
		).toBe(false);
		expect(
			validatePlan(plan([], [{ category: "ops", date: "2026-09-21", priority: "P1", text: "ok", source: "" }]), facts, T).ok,
		).toBe(false);
	});

	test("garbage JSON refused", () => {
		expect(validatePlan("not json", facts, T).ok).toBe(false);
	});
});

describe("applyPlan", () => {
	test("KEEP no-op; verdict tombstones with curator:<verdict> reason; proposal appended with fresh id", () => {
		const plan = {
			verdicts: [
				{ id: "aaa001", verdict: "SUPERSEDED" as const, evidence: "runner switched" },
				{ id: "aaa002", verdict: "KEEP" as const, evidence: "still true" },
			],
			proposals: [{ category: "ops" as const, date: "2026-09-21", priority: "P3", text: "door port 40579", source: "chat 2026-09-21" }],
		};
		const r = applyPlan(facts, plan, "2026-09-21");
		expect(r.tombstoned).toBe(1);
		expect(r.proposalsAdded).toBe(1);
		const dead = r.facts.find((f) => f.id === "aaa001")!;
		expect(dead.tombstoned).toBe("2026-09-21");
		expect(dead.reason).toBe("curator:superseded");
		expect(dead.text).toBe("test runner: bun"); // recovery span kept
		expect(r.facts.find((f) => f.id === "aaa002")!.tombstoned).toBeUndefined();
		expect(r.facts).toHaveLength(6);
		// round-trip: serialized output still parses
		expect(serializeFacts(r.facts).split("\n")).toHaveLength(6);
	});
});

describe("receipts", () => {
	test("pre/post hash + outcome recorded", () => {
		const pre = sha256Content(serializeFacts(facts));
		const r = applyPlan(facts, { verdicts: [{ id: "aaa001", verdict: "DORMANT", evidence: "x" }], proposals: [] }, "2026-09-21");
		const post = sha256Content(serializeFacts(r.facts));
		const receipt = buildReceipt({ trigger: "lines", outcome: "ok", appliedVerdicts: r.tombstoned, proposalsAdded: 0, preHash: pre, postHash: post, packBytes: 1234 });
		expect(receipt.preHash).not.toBe(receipt.postHash);
		expect(receipt.ts).toBeTruthy();
	});
});
