
test("v1.4.65 #64: held — judge holds completion, blocks dependents, never ready, survives sanitize", () => {
	let s = EMPTY_STATE;
	s = createTask(s, "blocker", "", [], 1).state; // #1
	s = createTask(s, "dep", "", [1], 2).state; // #2 blocked by #1
	// pending → held (engine judge branch; via updateTask like any patch.status)
	const held = updateTask(s, 1, { status: "held" }, 5);
	assert.equal(held.task!.status, "held");
	assert.equal(held.error, null);
	// held still blocks dependents (openBlockers counts it — held is not completed/cancelled)
	const idx = new Map(held.state.tasks.map((t) => [t.id, t]));
	assert.ok(openBlockers(held.state.tasks[1]!, idx).includes(1));
	// held is NOT in the ready set
	assert.ok(readyTasks(held.state).every((t) => t.id !== 1));
	// held → in_progress allowed (model keeps working)
	assert.equal(updateTask(held.state, 1, { status: "in_progress" }, 6).task!.status, "in_progress");
	// held → completed requires evidence
	const noEv = updateTask(held.state, 1, { status: "completed" }, 7);
	assert.match(noEv.error ?? "", /requires evidence/);
	// sanitizeState does not drop held
	const st = sanitizeState({ tasks: held.state.tasks, nextId: 3 });
	assert.equal(st.tasks[0]!.status, "held");
});

import { describe, expect, test } from "bun:test";
import assert from "node:assert";
import { createTask, fieldChanges, MAX_FIELD_CHANGES, openBlockers, readyTasks, sanitizeState, type TaskState, updateTask } from "./graph.ts";
import { EMPTY_STATE } from "./types.ts";

describe("goal membership (v1.4.51 #37)", () => {
	test("createTask stamps goalId; sanitizeState drops junk goalIds, keeps the g- form", () => {
		const r = createTask(EMPTY_STATE, "finished overnight work", "", [], 1, undefined, "g-abcd1234-777");
		expect(r.task?.goalId).toBe("g-abcd1234-777");
		const raw = { tasks: [{ id: 1, subject: "a", description: "", status: "pending", goalId: "nope" }], nextId: 2 };
		expect(sanitizeState(raw).tasks[0].goalId).toBeUndefined();
		const raw2 = { tasks: [{ id: 1, subject: "a", description: "", status: "pending", goalId: "g-ok-1" }], nextId: 2 };
		expect(sanitizeState(raw2).tasks[0].goalId).toBe("g-ok-1");
	});
});



describe("fieldChanges (#45 — update card shows WHAT changed)", () => {
	const empty: TaskState = { tasks: [], nextId: 1 };
	const base = createTask(empty, "Task A", "original brief", [], 1);
	if (base.error || !base.task) throw new Error("setup failed");
	const t0 = base.task;

	test("no-op update → empty list", () => {
		expect(fieldChanges(t0, { ...t0 })).toEqual([]);
	});

	test("subject + blockedBy change → exactly those fields, status omitted", () => {
		const next = { ...t0, subject: "Task A (changed)", blockedBy: [7, 8] };
		const out = fieldChanges(t0, next);
		expect(out.map((f) => f.field)).toEqual(["subject", "blockedBy"]);
		expect(out[0]).toMatchObject({ from: "Task A", to: "Task A (changed)" });
		expect(out[1]).toMatchObject({ from: "—", to: "7,8" });
	});

	test("doneCheck rewrite by agent → amend marker surfaces the trail", () => {
		const next = { ...t0, description: "new brief", descAmendments: 1 };
		const out = fieldChanges(t0, next);
		expect(out[0].field).toContain("brief amended");
		expect(out[0].from).toBe("original brief");
		expect(out[0].to).toBe("new brief");
	});

	test("status-only flip → single status line (old card's only content)", () => {
		const out = fieldChanges(t0, { ...t0, status: "in_progress" as const });
		expect(out).toEqual([{ field: "status", from: "pending", to: "in_progress" }]);
	});

	test("long values truncate to ~80 chars", () => {
		const long = "x".repeat(300);
		const out = fieldChanges(t0, { ...t0, subject: long });
		expect(out[0].to.length).toBeLessThanOrEqual(80);
	});

	test("cap at MAX_FIELD_CHANGES lines", () => {
		const next = {
			...t0,
			subject: "s2",
			description: "d2",
			blockedBy: [9],
			status: "in_progress" as const,
			judgeRounds: 1,
			appealReason: "vip",
		};
		expect(fieldChanges(t0, next).length).toBeLessThanOrEqual(MAX_FIELD_CHANGES);
	});

	test("prev undefined (create path) → empty", () => {
		expect(fieldChanges(undefined, t0)).toEqual([]);
	});
});
