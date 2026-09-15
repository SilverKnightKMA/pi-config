import { describe, expect, test } from "bun:test";
import {
	applyControlAction,
	emptyPlan,
	markStepDone,
	parseControlPayload,
	parseSteps,
	planFilePath,
	planStatusPayload,
	planStatusText,
	sanitizePlanState,
	replayPlan,
	slugFromPlan,
	reconcilePlan,
	planToolGate,
	deriveFromTasks,
	planBridgePayload,
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

// ── v1.4.60 (#62): auto-close + currentStep projection ──────────────────

describe("plan auto-close (#62)", () => {
	const base: import("./plan.ts").PlanState = {
		mode: "tracking",
		planFile: ".pi/plans/2026-09-14-x.md",
		steps: [
			{ index: 1, text: "step one", done: true },
			{ index: 2, text: "step two", done: false },
		],
	};

	test("last step done in index wiring flips mode to complete", async () => {
		// covered end-to-end in index.test.ts; here we pin the pure helpers
		const payload = planStatusPayload(base, "sess-1", "2026-09-14T00:00:00Z");
		expect(payload.mode).toBe("tracking");
		expect(payload.steps).toEqual(base.steps);
		expect(payload.stepsDone).toBe(1);
		expect(payload.currentStep).toEqual({ index: 2, text: "step two" });
		expect(payload.completedAt).toBeNull();
	});

	test("complete payload: currentStep null + completedAt set", () => {
		const done: import("./plan.ts").PlanState = {
			...base,
			mode: "complete",
			completedAt: "2026-09-14T12:00:00Z",
			steps: base.steps.map((s) => ({ ...s, done: true })),
		};
		const payload = planStatusPayload(done, "sess-1");
		expect(payload.mode).toBe("complete");
		expect(payload.currentStep).toBeNull();
		expect(payload.completedAt).toBe("2026-09-14T12:00:00Z");
	});

	test("sanitizePlanState accepts complete + completedAt", () => {
		const st = sanitizePlanState({ mode: "complete", steps: [{ index: 1, text: "a", done: true }], completedAt: "T1" });
		expect(st?.mode).toBe("complete");
		expect(st?.completedAt).toBe("T1");
		expect(sanitizePlanState({ mode: "bogus" })).toBeNull();
	});

	test("applyControlAction: on from complete re-enters planning; off clears", () => {
		const done = { ...base, mode: "complete" as const, completedAt: "T1" };
		expect(applyControlAction(done, "on").state.mode).toBe("active");
		const off = applyControlAction(done, "off");
		expect(off.state.mode).toBe("inactive");
		expect(off.state.steps).toHaveLength(0);
	});

	test("planStatusText shows COMPLETE line", () => {
		const txt = planStatusText({ ...base, mode: "complete", completedAt: "2026-09-14T12:00:00Z", steps: base.steps.map((s) => ({ ...s, done: true })) });
		expect(txt).toContain("COMPLETE 2026-09-14T12:00:00Z");
		expect(txt).toContain("closed automatically");
	});
});

// ── v1.4.67 (#47 Phase A): reconcile drift repair + awaiting planText ────

describe("reconcilePlan drift repair (#47 Phase A)", () => {
	const stale: import("./plan.ts").PlanState = {
		mode: "tracking",
		planFile: ".pi/plans/2026-09-14-old.md",
		steps: [
			{ index: 1, text: "a", done: true },
			{ index: 2, text: "b", done: true },
		],
	};

	test("tracking with every step done flips to complete + completedAt", () => {
		const r = reconcilePlan(stale, null, "2026-09-15T00:00:00Z");
		expect(r.changed).toBe(true);
		expect(r.state.mode).toBe("complete");
		expect(r.state.completedAt).toBe("2026-09-15T00:00:00Z");
	});

	test("second call is idempotent (no change, keeps completedAt)", () => {
		const first = reconcilePlan(stale, null, "T1");
		const second = reconcilePlan(first.state, null, "T2");
		expect(second.changed).toBe(false);
		expect(second.state.completedAt).toBe("T1");
	});

	test("open steps stay tracking", () => {
		const open = { ...stale, steps: [{ index: 1, text: "a", done: true }, { index: 2, text: "b", done: false }] };
		const r = reconcilePlan(open, "# p\n1. a\n2. b\n");
		expect(r.changed).toBe(false);
		expect(r.state.mode).toBe("tracking");
	});

	test("empty steps re-derived from the plan file (done:false, stays honest)", () => {
		const hollow: import("./plan.ts").PlanState = { mode: "tracking", steps: [] };
		const r = reconcilePlan(hollow, "# Plan\n\nprose\n\n1. first\n2. second\n");
		expect(r.changed).toBe(true);
		expect(r.state.steps.map((s) => s.text)).toEqual(["first", "second"]);
		expect(r.state.steps.every((s) => !s.done)).toBe(true);
		expect(r.state.mode).toBe("tracking");
	});

	test("inactive/awaiting never touched", () => {
		expect(reconcilePlan({ mode: "inactive", steps: [] }, "x").changed).toBe(false);
		const awaiting = { mode: "awaiting" as const, steps: [{ index: 1, text: "a", done: true }] };
		expect(reconcilePlan(awaiting, null).changed).toBe(false);
	});

	test("payload: awaiting carries planText (capped); tracking omits it", () => {
		const awaiting: import("./plan.ts").PlanState = { mode: "awaiting", steps: [{ index: 1, text: "a", done: false }] };
		const withText = planStatusPayload(awaiting, "s", "T", "x".repeat(20_000));
		expect(withText.planText).toHaveLength(12_000);
		const tracked = planStatusPayload({ ...stale }, "s", "T", "body");
		expect(tracked.planText).toBeUndefined();
	});
});

// ── v1.4.68 (#47 Phase B): task bridge payload + derive + taskRef ────────

describe("plan task bridge (#47 Phase B)", () => {
	const bridged: import("./plan.ts").PlanState = {
		mode: "tracking",
		planFile: ".pi/plans/2026-09-15-x.md",
		planId: "p-sess1-abc",
		steps: [
			{ index: 1, text: "step one", done: false },
			{ index: 2, text: "step two", done: false },
		],
	};

	test("planBridgePayload: null without planId; tracking carries steps; off empties them", () => {
		expect(planBridgePayload({ mode: "tracking", steps: [] }, "s", "tracking")).toBeNull();
		const t = planBridgePayload(bridged, "sess1", "tracking")!;
		expect(t.planId).toBe("p-sess1-abc");
		expect(t.steps.map((s) => s.index)).toEqual([1, 2]);
		const off = planBridgePayload(bridged, "sess1", "off")!;
		expect(off.status).toBe("off");
		expect(off.steps).toHaveLength(0);
	});

	test("deriveFromTasks: completed step-task marks done; pending/in_progress do not", () => {
		const board = [
			{ id: 7, status: "completed", planId: "p-sess1-abc", stepIndex: 1 },
			{ id: 8, status: "in_progress", planId: "p-sess1-abc", stepIndex: 2 },
		];
		const r = deriveFromTasks(bridged, board);
		expect(r.changed).toBe(true);
		expect(r.state.steps[0].done).toBe(true);
		expect(r.state.steps[1].done).toBe(false);
	});

	test("deriveFromTasks: monotonic — done stays done even if the board row vanishes", () => {
		const once = deriveFromTasks(bridged, [{ id: 7, status: "completed", planId: "p-sess1-abc", stepIndex: 1 }]).state;
		const twice = deriveFromTasks(once, []); // torn/empty projection read
		expect(twice.state.steps[0].done).toBe(true);
		expect(twice.changed).toBe(false);
	});

	test("deriveFromTasks: held task ≠ done (judge still holds the step)", () => {
		const r = deriveFromTasks(bridged, [{ id: 8, status: "held", planId: "p-sess1-abc", stepIndex: 2 }]);
		expect(r.changed).toBe(false);
	});

	test("deriveFromTasks: foreign planId ignored; no planId → unchanged", () => {
		expect(deriveFromTasks(bridged, [{ id: 9, status: "completed", planId: "p-other", stepIndex: 1 }]).changed).toBe(false);
		expect(deriveFromTasks({ mode: "tracking", steps: bridged.steps }, [{ id: 9, status: "completed", planId: "p-sess1-abc", stepIndex: 1 }]).changed).toBe(false);
	});

	test("all steps derived done + reconcilePlan → plan auto-completes (the #15 loop)", () => {
		let st = bridged;
		st = deriveFromTasks(st, [
			{ id: 7, status: "completed", planId: "p-sess1-abc", stepIndex: 1 },
			{ id: 8, status: "completed", planId: "p-sess1-abc", stepIndex: 2 },
		]).state;
		const r = reconcilePlan(st, null, "T9");
		expect(r.state.mode).toBe("complete");
		expect(r.state.completedAt).toBe("T9");
	});

	test("payload steps carry taskRef from the board", () => {
		const payload = planStatusPayload(bridged, "sess1", "T", undefined, [
			{ id: 7, status: "in_progress", planId: "p-sess1-abc", stepIndex: 1 },
			{ id: 8, status: "held", planId: "p-sess1-abc", stepIndex: 2 },
		]);
		expect(payload.steps[0].taskRef).toEqual({ id: 7, status: "in_progress" });
		expect(payload.steps[1].taskRef).toEqual({ id: 8, status: "held" });
	});

	test("sanitizePlanState keeps planId (p- prefix) and drops junk", () => {
		const st = sanitizePlanState({ mode: "tracking", planId: "p-sess1-abc", steps: [] });
		expect(st?.planId).toBe("p-sess1-abc");
		const bad = sanitizePlanState({ mode: "tracking", planId: "x-1", steps: [] });
		expect(bad?.planId).toBeUndefined();
	});
});

describe("planToolGate — mode entry is user-only (v1.4.70)", () => {
	test("enter_plan_mode is NEVER a model tool — blocked in every mode", () => {
		for (const m of ["inactive", "active", "awaiting", "tracking", "complete"] as const) {
			const g = planToolGate(m, "enter_plan_mode");
			expect(g.allowed).toBe(false);
		}
		const g = planToolGate("inactive", "enter_plan_mode");
		if (!g.allowed) {
			expect(g.door).toContain("/plan on");
			expect(g.next).toContain("ask the user");
		}
	});

	test("write_plan allowed only while drafting (active/awaiting)", () => {
		expect(planToolGate("active", "write_plan").allowed).toBe(true);
		expect(planToolGate("awaiting", "write_plan").allowed).toBe(true);
		expect(planToolGate("inactive", "write_plan").allowed).toBe(false); // mode not opened by user
		expect(planToolGate("tracking", "write_plan").allowed).toBe(false); // live plan — no clobber
		expect(planToolGate("complete", "write_plan").allowed).toBe(false); // historical — no clobber
	});

	test("exit_plan_mode only while drafting; plan_step_done only while tracking", () => {
		expect(planToolGate("active", "exit_plan_mode").allowed).toBe(true);
		expect(planToolGate("awaiting", "exit_plan_mode").allowed).toBe(true);
		expect(planToolGate("tracking", "exit_plan_mode").allowed).toBe(false);
		expect(planToolGate("tracking", "plan_step_done").allowed).toBe(true);
		expect(planToolGate("inactive", "plan_step_done").allowed).toBe(false);
	});

	test("non-plan tools pass the gate untouched (read-only allowlist handles them)", () => {
		for (const t of ["read", "bash", "edit", "task_update", "goal_propose"]) {
			expect(planToolGate("tracking", t).allowed).toBe(true);
		}
	});
});
