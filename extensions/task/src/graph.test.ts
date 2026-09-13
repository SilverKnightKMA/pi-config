import { describe, expect, test } from "bun:test";
import { createTask, fieldChanges, MAX_FIELD_CHANGES, type TaskState } from "./graph.ts";


describe("fieldChanges (#45 — update card shows WHAT changed)", () => {
	const empty: TaskState = { tasks: [], nextId: 1 };
	const base = createTask(empty, "Việc A", "đề gốc", [], 1);
	if (base.error || !base.task) throw new Error("setup failed");
	const t0 = base.task;

	test("no-op update → empty list", () => {
		expect(fieldChanges(t0, { ...t0 })).toEqual([]);
	});

	test("subject + blockedBy change → exactly those fields, status omitted", () => {
		const next = { ...t0, subject: "Việc A (đã đổi)", blockedBy: [7, 8] };
		const out = fieldChanges(t0, next);
		expect(out.map((f) => f.field)).toEqual(["subject", "blockedBy"]);
		expect(out[0]).toMatchObject({ from: "Việc A", to: "Việc A (đã đổi)" });
		expect(out[1]).toMatchObject({ from: "—", to: "7,8" });
	});

	test("doneCheck rewrite by agent → amend marker surfaces the trail", () => {
		const next = { ...t0, description: "đề mới", descAmendments: 1 };
		const out = fieldChanges(t0, next);
		expect(out[0].field).toContain("đã sửa đề");
		expect(out[0].from).toBe("đề gốc");
		expect(out[0].to).toBe("đề mới");
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
