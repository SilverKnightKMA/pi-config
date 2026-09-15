import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import { applyPlanBridge, sanitizePlanBridge } from "./plan-bridge.ts";
import { EMPTY_STATE } from "./types.ts";
import { replayBranch, sanitizeState } from "./graph.ts";

const SID = "sess-plan1";

function trackingPayload(steps: Array<[number, string]>) {
	return {
		v: 1 as const,
		sessionId: SID,
		planId: "p-sess-plan1-abc",
		status: "tracking" as const,
		planFile: "/tmp/plans/x.md",
		steps: steps.map(([index, text]) => ({ index, text })),
	};
}

describe("plan-bridge sanitize (#47 Phase B)", () => {
	test("accepts tracking with steps; passes planFile through", () => {
		const p = sanitizePlanBridge(trackingPayload([[1, "a"], [2, "b"]]));
		assert.ok(p);
		expect(p.status).toBe("tracking");
		expect(p.planId).toBe("p-sess-plan1-abc");
		expect(p.planFile).toBe("/tmp/plans/x.md");
		expect(p.steps).toHaveLength(2);
	});

	test("rejects v≠1, bad planId prefix, tracking without steps", () => {
		expect(sanitizePlanBridge({ ...trackingPayload([[1, "a"]]), v: 2 })).toBeNull();
		expect(sanitizePlanBridge({ ...trackingPayload([[1, "a"]]), planId: "g-1" })).toBeNull();
		expect(sanitizePlanBridge(trackingPayload([]))).toBeNull();
	});

	test("off with empty steps is valid (cancel signal)", () => {
		const p = sanitizePlanBridge({ ...trackingPayload([[1, "a"]]), status: "off", steps: [] });
		assert.ok(p);
		expect(p.status).toBe("off");
		expect(p.steps).toHaveLength(0);
	});

	test("consumedAt survives sanitize (watcher idempotency gate)", () => {
		const p = sanitizePlanBridge({ ...trackingPayload([[1, "a"]]), consumedAt: "T" });
		assert.ok(p);
		expect(p.consumedAt).toBe("T");
	});
});

describe("applyPlanBridge (#47 Phase B)", () => {
	test("tracking creates exactly N strict judgment step-tasks, stamped planId+stepIndex", () => {
		const payload = sanitizePlanBridge(trackingPayload([[1, "write A"], [2, "write B"], [3, "write C"]]))!;
		const next = applyPlanBridge(EMPTY_STATE, payload, 1000);
		expect(next.tasks).toHaveLength(3);
		for (const t of next.tasks) {
			expect(t.subject.startsWith("[plan ")).toBe(true);
			expect(t.verify?.lane).toBe("judgment");
			expect(t.verify?.strict).toBe(true);
			expect(t.planId).toBe("p-sess-plan1-abc");
			expect(typeof t.stepIndex).toBe("number");
			expect(t.status).toBe("pending");
		}
		expect(next.tasks.map((t) => t.stepIndex)).toEqual([1, 2, 3]);
		expect(next.nextId).toBe(4);
	});

	test("re-consuming the same payload creates nothing (idempotent by planId+stepIndex)", () => {
		const payload = sanitizePlanBridge(trackingPayload([[1, "a"], [2, "b"]]))!;
		const once = applyPlanBridge(EMPTY_STATE, payload, 1000);
		const twice = applyPlanBridge(once, payload, 2000);
		expect(twice.tasks).toHaveLength(2);
		expect(twice).toBe(once);
	});

	test("two different plans stamp separately (no cross-eating)", () => {
		const p1 = sanitizePlanBridge(trackingPayload([[1, "a"]]))!;
		const p2 = sanitizePlanBridge({ ...trackingPayload([[1, "b"]]), planId: "p-other-xyz" })!;
		const once = applyPlanBridge(EMPTY_STATE, p1, 1000);
		const twice = applyPlanBridge(once, p2, 2000);
		expect(twice.tasks).toHaveLength(2);
	});

	test("off cancels open step-tasks, keeps completed ones", () => {
		const payload = sanitizePlanBridge(trackingPayload([[1, "a"], [2, "b"], [3, "c"]]))!;
		let state = applyPlanBridge(EMPTY_STATE, payload, 1000);
		// step 1 completed (with evidence — judge path lives in index.ts wiring)
		const completed = sanitizeState({
			...state,
			tasks: state.tasks.map((t) =>
				t.stepIndex === 1 ? { ...t, status: "completed", evidence: "cmd + output cited" } : t,
			),
		});
		const off = sanitizePlanBridge({ ...payload, status: "off", steps: [] })!;
		const next = applyPlanBridge(completed, off, 3000);
		const byIdx = new Map(next.tasks.map((t) => [t.stepIndex, t.status]));
		expect(byIdx.get(1)).toBe("completed"); // one-way stays
		expect(byIdx.get(2)).toBe("cancelled");
		expect(byIdx.get(3)).toBe("cancelled");
	});

	test("created state survives ledger round-trip (sanitizeState keeps the stamps)", () => {
		const payload = sanitizePlanBridge(trackingPayload([[1, "a"]]))!;
		const next = applyPlanBridge(EMPTY_STATE, payload, 1000);
		const round = sanitizeState(JSON.parse(JSON.stringify(next)));
		expect(round.tasks[0].planId).toBe("p-sess-plan1-abc");
		expect(round.tasks[0].stepIndex).toBe(1);
		expect(round.tasks[0].verify?.strict).toBe(true);
		// replayBranch shape is entry-based; sanitizeState is what preserves fields
		expect(Array.isArray(round.tasks)).toBe(true);
	});
});

describe("plan-bridge optional dependencies (#86 — after N marker, never forced)", () => {
	function depPayload() {
		return sanitizePlanBridge({
			...trackingPayload([[1, "core"], [2, "tests (after 1)"], [3, "ship (after 1,2)"]]),
			steps: [
				{ index: 1, text: "core" },
				{ index: 2, text: "tests", dependsOn: [1] },
				{ index: 3, text: "ship", dependsOn: [1, 2] },
			],
		})!;
	}

	test("sanitize keeps backward refs; drops forward/self/out-of-range silently", () => {
		const p = sanitizePlanBridge({
			...trackingPayload([[1, "a"], [2, "b"], [3, "c"]]),
			steps: [
				{ index: 1, text: "a", dependsOn: [2] },
				{ index: 2, text: "b", dependsOn: [2, 7, "x"] as never },
				{ index: 3, text: "c", dependsOn: [1, 1, 2] },
			],
		})!;
		expect(p.steps[0].dependsOn).toBeUndefined(); // forward (2 ≥ own 1)
		expect(p.steps[1].dependsOn).toBeUndefined(); // self + out-of-range + junk
		expect(p.steps[2].dependsOn).toEqual([1, 2]); // dedup keeps valid pair
	});

	test("applyPlanBridge wires blockedBy from step indices to created task ids", () => {
		const next = applyPlanBridge(EMPTY_STATE, depPayload(), 1000);
		const t1 = next.tasks.find((t) => t.stepIndex === 1)!;
		const t2 = next.tasks.find((t) => t.stepIndex === 2)!;
		const t3 = next.tasks.find((t) => t.stepIndex === 3)!;
		expect(t1.blockedBy ?? []).toEqual([]);
		expect(t2.blockedBy).toEqual([t1.id]);
		expect(t3.blockedBy).toEqual([t1.id, t2.id]);
	});

	test("re-consume is idempotent — same edges, no duplicates, identical state object", () => {
		const once = applyPlanBridge(EMPTY_STATE, depPayload(), 1000);
		const twice = applyPlanBridge(once, depPayload(), 2000);
		expect(twice.tasks).toHaveLength(3);
		expect(twice).toBe(once);
	});

	test("flat payload (no dependsOn) stays edge-free — the old shape is untouched", () => {
		const next = applyPlanBridge(EMPTY_STATE, sanitizePlanBridge(trackingPayload([[1, "a"], [2, "b"]]))!, 1000);
		for (const t of next.tasks) expect(t.blockedBy ?? []).toEqual([]);
	});
});
