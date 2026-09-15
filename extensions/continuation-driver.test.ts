import { describe, expect, test } from "bun:test";
import {
	continuationOwnedByHigherKind,
	decide,
	ladderDelaySec,
	nextStreak,
	planBudget,
	type KindFacts,
} from "./continuation-driver.ts";

const facts = (over: Partial<KindFacts>): KindFacts => ({
	kind: "plan",
	active: true,
	openWork: 3,
	rounds: 0,
	budget: 12,
	noProgressStreak: 0,
	...over,
});

describe("continuation-driver decide (#61 Phase C)", () => {
	test("inactive kind never wakes", () => {
		expect(decide(facts({ active: false })).action).toBe("none");
	});

	test("settled with pending work → wake on ladder delay 5s", () => {
		const d = decide(facts({ openWork: 2 }));
		expect(d.action).toBe("wake");
		expect(d.delaySec).toBe(5);
	});

	test("ladder climbs 5→10→20→40→80 then clamps (1-based round about to run)", () => {
		expect([1, 2, 3, 4, 5, 9, 20].map(ladderDelaySec)).toEqual([5, 10, 20, 40, 80, 80, 80]);
	});

	test("budget exhausted → wrapup, no wake", () => {
		const d = decide(facts({ rounds: 12, budget: 12 }));
		expect(d.action).toBe("wrapup");
		expect(d.reason).toContain("12/12");
	});

	test("3 no-progress wakes → early wrapup even under budget", () => {
		const d = decide(facts({ rounds: 4, budget: 12, noProgressStreak: 3 }));
		expect(d.action).toBe("wrapup");
		expect(d.reason).toContain("no progress");
	});

	test("plan budget shrinks with open steps: 5→10, 2→6, 8→12, 0→6", () => {
		expect(planBudget(5)).toBe(10);
		expect(planBudget(2)).toBe(6);
		expect(planBudget(8)).toBe(12);
		expect(planBudget(0)).toBe(6);
	});

	test("nextStreak: same signature stacks, change resets", () => {
		expect(nextStreak(0, "a", "a")).toBe(1);
		expect(nextStreak(2, "a", "a")).toBe(3);
		expect(nextStreak(2, "a", "b")).toBe(0);
	});

	test("higher-kind ownership: goal or bridged-open plan owns; task yields", () => {
		expect(continuationOwnedByHigherKind(true, false)).toBe(true);
		expect(continuationOwnedByHigherKind(false, true)).toBe(true);
		expect(continuationOwnedByHigherKind(false, false)).toBe(false);
	});

	test("two kinds active decide independently — one turn serves both (budgets not pooled)", () => {
		const goal = decide(facts({ kind: "goal", budget: 20, rounds: 19 }));
		const task = decide(facts({ kind: "task", budget: 10, rounds: 3 }));
		expect(goal.action).toBe("wake"); // 20th epoch
		expect(task.action).toBe("wake"); // task budget untouched by goal rounds
	});
});
