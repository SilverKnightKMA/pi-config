import { describe, expect, test } from "bun:test";
import {
	applyControlAction,
	emptyPlan,
	markStepDone,
	parseControlPayload,
	parseSteps,
	planFilePath,
	planStatusText,
	replayPlan,
	slugFromPlan,
} from "./plan";

describe("slugFromPlan", () => {
	test("first heading slugified; fallback plan; Vietnamese normalized", () => {
		expect(slugFromPlan("# Migrate DB Now!")).toBe("migrate-db-now");
		expect(slugFromPlan("no heading")).toBe("plan");
		expect(slugFromPlan("# Đánh giá Endpoint")).toBe("danh-gia-endpoint");
	});
});

describe("planFilePath — collision counter", () => {
	test("first free name wins; -2 then -3", () => {
		const today = new Date();
		const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		expect(planFilePath([], "alpha")).toBe(`${stamp}-alpha.md`);
		expect(planFilePath([`${stamp}-alpha.md`], "alpha")).toBe(`${stamp}-alpha-2.md`);
		expect(planFilePath([`${stamp}-alpha.md`, `${stamp}-alpha-2.md`], "alpha")).toBe(`${stamp}-alpha-3.md`);
	});
});

describe("parseSteps — top-level only, ports the 40×200 caps", () => {
	test("numbered + bulleted top-level; nested excluded; prose ignored", () => {
		const md = [
			"# Plan",
			"intro prose",
			"1. First step",
			"2) Second step",
			"   - nested detail under two",
			"* Third (bullet)",
			"plain line",
		].join("\n");
		const steps = parseSteps(md);
		expect(steps.map((s) => s.text)).toEqual(["First step", "Second step", "Third (bullet)"]);
		expect(steps.map((s) => s.index)).toEqual([1, 2, 3]);
	});

	test("caps at 40 steps and 200 chars", () => {
		const many = Array.from({ length: 60 }, (_, i) => `${i + 1}. step ${i + 1}`).join("\n");
		expect(parseSteps(many)).toHaveLength(40);
		const long = parseSteps(`1. ${"x".repeat(400)}`);
		expect(long[0].text.length).toBe(200);
	});
});

describe("markStepDone", () => {
	const state = { ...emptyPlan(), steps: parseSteps("1. a\n2. b\n3. c") };
	test("marks done with evidence; unknown index lists open steps", () => {
		const r = markStepDone(state, 2, "ran bun test — 93 pass");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.open).toBe(2);
		expect(state.steps[1].done).toBe(true);
		expect(state.steps[1].evidence).toContain("93 pass");
		const bad = markStepDone(state, 9);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("Open steps: 1, 3");
	});
});

describe("applyControlAction — the user-only doors", () => {
	test("approve only from awaiting; model-submitted state cannot self-approve", () => {
		const active = { ...emptyPlan(), mode: "active" as const };
		const refused = applyControlAction(active, "approve");
		expect(refused.state.mode).toBe("active");
		expect(refused.note).toContain("Nothing to approve");
		const awaiting = { ...emptyPlan(), mode: "awaiting" as const, steps: parseSteps("1. x") };
		const ok = applyControlAction(awaiting, "approve");
		expect(ok.state.mode).toBe("tracking");
	});

	test("revise returns to active; off clears steps and mode", () => {
		const awaiting = { ...emptyPlan(), mode: "awaiting" as const, steps: parseSteps("1. x") };
		expect(applyControlAction(awaiting, "revise").state.mode).toBe("active");
		const off = applyControlAction(awaiting, "off");
		expect(off.state.mode).toBe("inactive");
		expect(off.state.steps).toEqual([]);
	});
});

describe("parseControlPayload + planStatusText", () => {
	test("v1 actions pass; junk rejected", () => {
		expect(parseControlPayload({ v: 1, action: "approve", sentAt: "t" })?.action).toBe("approve");
		expect(parseControlPayload({ v: 2, action: "approve", sentAt: "t" })).toBeNull();
		expect(parseControlPayload({ v: 1, action: "self-destruct", sentAt: "t" })).toBeNull();
	});

	test("awaiting status names the user-only doors", () => {
		const text = planStatusText({ ...emptyPlan(), mode: "awaiting", steps: parseSteps("1. x") });
		expect(text).toContain("/plan approve");
		expect(text).toContain("cannot approve");
	});
});

describe("replayPlan — full snapshots, last wins", () => {
	test("sequence of entries replays to the final mode", () => {
		const state = replayPlan([
			{ type: "custom", customType: "plan-state", data: { mode: "active", steps: parseSteps("1. a") } },
			{ type: "custom", customType: "plan-state", data: { mode: "awaiting", steps: parseSteps("1. a"), planFile: "/x/a.md" } },
			{ type: "custom", customType: "other", data: { mode: "inactive" } },
			{ type: "custom", customType: "plan-state", data: { mode: "tracking", steps: parseSteps("1. a"), planFile: "/x/b.md" } },
		]);
		expect(state.mode).toBe("tracking");
		expect(state.planFile).toBe("/x/b.md");
	});
});
