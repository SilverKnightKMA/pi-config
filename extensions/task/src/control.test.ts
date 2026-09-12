/**
 * Pure tests for the user-only control bridge (v1.4.28).
 * Contract: model may park (appeal/cap), only the user surface (control file)
 * may un-park; strict lowering likewise never passes through the model.
 */
import { describe, expect, it, test } from "bun:test";
import assert from "node:assert/strict";

import { ackPayload, applyControlAction, parseControlPayload } from "./control.ts";
import { createTask, sanitizeState, updateTask } from "./graph.ts";
import { EMPTY_STATE, type TaskState } from "./types.ts";

function seeded(verify?: object): TaskState {
	const created = createTask(EMPTY_STATE, "t", "done-check", [], Date.now(), verify as never);
	return created.state;
}

describe("control: parseControlPayload", () => {
	test("valid unpark + strict payloads parse", () => {
		const a = parseControlPayload('{"v":1,"action":"unpark","id":3,"sentAt":"t1"}');
		assert.equal(a?.action, "unpark");
		assert.equal(a?.id, 3);
		const b = parseControlPayload('{"v":1,"action":"strict","id":3,"value":false}');
		assert.equal(b?.value, false);
		const c = parseControlPayload('{"v":1,"action":"reopen","id":7}');
		assert.equal(c?.action, "reopen");
		assert.equal(c?.id, 7);
	});

	test("malformed / wrong version / bad ids are rejected", () => {
		assert.equal(parseControlPayload("not json"), null);
		assert.equal(parseControlPayload('{"v":2,"action":"unpark","id":1}'), null);
		assert.equal(parseControlPayload('{"v":1,"action":"delete","id":1}'), null);
		assert.equal(parseControlPayload('{"v":1,"action":"unpark","id":"x"}'), null);
		assert.equal(parseControlPayload('{"v":1,"action":"strict","id":1,"value":"yes"}'), null);
	});

	test("ack round-trip adds ackAt and keeps the rest", () => {
		const p = parseControlPayload('{"v":1,"action":"strict","id":2,"value":true,"sentAt":"s1"}')!;
		const acked = JSON.parse(ackPayload(p, "a1"));
		assert.equal(acked.ackAt, "a1");
		assert.equal(acked.sentAt, "s1");
		assert.equal(acked.value, true);
	});
});

describe("control: applyControlAction — reopen (v1.4.35)", () => {
	test("reopen rolls a completed task back to in_progress, evidence stays", () => {
		let state = seeded();
		const done = updateTask(state, 1, { status: "in_progress" }, 1);
		state = done.state;
		const closed = updateTask(state, 1, { status: "completed", evidence: "đã xong (e2e)" }, 2);
		state = closed.state;
		const r = applyControlAction(state, { v: 1, action: "reopen", id: 1 }, 3);
		assert.equal(r.applied, true);
		const t = r.state.tasks.find((x) => x.id === 1)!;
		assert.equal(t.status, "in_progress");
		assert.equal(t.evidence, "đã xong (e2e)");
	});

	test("reopen of a completed task with a re-opened blocker falls back to pending", () => {
		const a = createTask(EMPTY_STATE, "blocker", "dc", [], Date.now());
		let state = a.state;
		const b = createTask(state, "main", "dc", [1], Date.now());
		state = b.state;
		state = updateTask(state, 1, { status: "completed", evidence: "ok1" }, 1).state;
		state = updateTask(state, 2, { status: "completed", evidence: "ok2" }, 1).state;
		// blocker được user mở lại → task 2 giờ có blocker mở
		state = applyControlAction(state, { v: 1, action: "reopen", id: 1 }, 2).state;
		const r = applyControlAction(state, { v: 1, action: "reopen", id: 2 }, 3);
		assert.equal(r.applied, true);
		assert.equal(r.state.tasks.find((x) => x.id === 2)!.status, "pending");
	});

	test("reopen refuses a task that is already open", () => {
		const state = seeded();
		const r = applyControlAction(state, { v: 1, action: "reopen", id: 1 }, 1);
		assert.equal(r.applied, false);
		assert.match(r.note, /không cần reopen/);
	});
});

describe("control: applyControlAction", () => {
	test("unpark reopens a parked task as in_progress and clears the appeal reason", () => {
		let state = seeded();
		state = updateTask(state, 1, { evidence: "e" }, 1).state;
		state = updateTask(state, 1, { status: "parked", appealReason: "tranh chấp" }, 2).state;
		const r = applyControlAction(state, { v: 1, action: "unpark", id: 1 }, 3);
		assert.equal(r.applied, true);
		const t = r.state.tasks[0]!;
		assert.equal(t.status, "in_progress");
		assert.equal(t.appealReason, undefined);
	});

	test("unpark of a blocked parked task falls back to pending", () => {
		let state = seeded();
		state = createTask(state, "blocker", "", [], 1).state;
		// task 2 blocked by 1 (never completed)
		state = updateTask(state, 2, { blockedBy: [1] }, 1).state;
		state = updateTask(state, 2, { status: "parked", appealReason: "x" }, 2).state;
		const r = applyControlAction(state, { v: 1, action: "unpark", id: 2 }, 3);
		assert.equal(r.state.tasks[1]!.status, "pending");
		assert.match(r.note, /pending — còn blocker/);
	});

	test("unpark refuses a task that is not parked", () => {
		const state = seeded();
		const r = applyControlAction(state, { v: 1, action: "unpark", id: 1 }, 2);
		assert.equal(r.applied, false);
		assert.match(r.note, /không ở trạng thái parked/);
	});

	test("strict flips the flag without touching verifyAmendments", () => {
		let state = seeded({ lane: "judgment", probes: [], strict: false });
		const r = applyControlAction(state, { v: 1, action: "strict", id: 1, value: true }, 2);
		assert.equal(r.applied, true);
		assert.equal(r.state.tasks[0]!.verify!.strict, true);
		assert.equal(r.state.tasks[0]!.verifyAmendments, 0); // không tốn budget amend (vẫn 0 từ lúc tạo)
		// và hạ cũng được — qua bridge (user)
		const r2 = applyControlAction(r.state, { v: 1, action: "strict", id: 1, value: false }, 3);
		assert.equal(r2.state.tasks[0]!.verify!.strict, false);
	});

	test("strict on a task without verify spec is a no-op note", () => {
		const state = seeded();
		const r = applyControlAction(state, { v: 1, action: "strict", id: 1, value: true }, 2);
		assert.equal(r.applied, false);
		assert.match(r.note, /không có verify spec/);
	});
});

// v1.4.37: user mở lại (unpark/reopen) = cấp chu kỳ phán mới — reset counter,
// không thì cap 3 vòng cũ park lại ngay không gọi judge (live #13 2026-09-12)
describe("control: un-park/reopen resets the judge cycle", () => {
	it("unpark resets judgeRounds + failStreak on a capped parked task", () => {
		const base: TaskState = EMPTY_STATE;
		const r1 = createTask(base, "capped", "d", [], 1000);
		const r2 = updateTask(r1.state, 1, { status: "parked", judgeRounds: 3, failStreak: 2 }, 2000);
		const r3 = applyControlAction(r2.state, { v: 1, action: "unpark", id: 1 }, 3000);
		const t = r3.state.tasks.find((x) => x.id === 1)!;
		expect(t.status).toBe("in_progress");
		expect(t.judgeRounds).toBe(0);
		expect(t.failStreak).toBe(0);
		expect(t.appealReason).toBeUndefined();
	});

	it("reopen of a completed task also resets the cycle", () => {
		const base: TaskState = EMPTY_STATE;
		const r1 = createTask(base, "done", "d", [], 1000);
		const r2 = updateTask(r1.state, 1, { status: "completed", evidence: "e", judgeRounds: 3, failStreak: 0 }, 2000);
		const r3 = applyControlAction(r2.state, { v: 1, action: "reopen", id: 1 }, 3000);
		const t = r3.state.tasks.find((x) => x.id === 1)!;
		expect(t.status).toBe("in_progress");
		expect(t.judgeRounds).toBe(0);
		expect(t.evidence).toBe("e");
	});
});

// ── v1.4.38 doneCheck guard (amend) ─────────────────────────────────────
describe("control: doneCheck amend (user-only door, v1.4.38)", () => {
	test("valid amend payload parses; empty/malformed description rejected", () => {
		const ok = parseControlPayload('{"v":1,"action":"amend","id":5,"description":"  mới  "}');
		assert.equal(ok?.action, "amend");
		assert.equal(ok?.description, "mới");
		assert.equal(parseControlPayload('{"v":1,"action":"amend","id":5,"description":""}'), null);
		assert.equal(parseControlPayload('{"v":1,"action":"amend","id":5}'), null);
		// length cap 2000 chống phình packet
		const long = parseControlPayload(`{"v":1,"action":"amend","id":5,"description":"${"x".repeat(3000)}"}`);
		assert.equal(long?.description.length, 2000);
	});

	test("amend by user rewrites description, keeps old sheet in trail, does not consume the cap", () => {
		const state = seeded();
		const res = applyControlAction(
			state,
			{ v: 1, action: "amend", id: 1, description: "đề mới của user" },
			Date.now(),
		);
		assert.equal(res.applied, true);
		const t = res.state.tasks[0]!;
		assert.equal(t.description, "đề mới của user");
		assert.equal(t.descHistory?.length, 1);
		assert.equal(t.descHistory?.[0]?.by, "user");
		assert.equal(t.descHistory?.[0]?.from, "done-check");
		assert.equal(t.descAmendments, undefined); // user sửa không đếm
	});

	test("amend with identical description is a no-op", () => {
		const state = seeded();
		const res = applyControlAction(state, { v: 1, action: "amend", id: 1, description: "done-check" }, Date.now());
		assert.equal(res.applied, false);
	});
});

describe("graph: descAmend accounting (v1.4.38)", () => {
	test("agent rewrite increments descAmendments and trails old→new; user rewrite trails but does not count", () => {
		const state = seeded();
		const a1 = updateTask(state, 1, { description: "đề agent lần 1", descAmend: { by: "agent" } }, 2);
		assert.equal(a1.state.tasks[0]?.descAmendments, 1);
		const a2 = updateTask(a1.state, 1, { description: "đề user", descAmend: { by: "user" } }, 3);
		assert.equal(a2.state.tasks[0]?.descAmendments, 1, "user amend không tốn ngân sách");
		assert.equal(a2.state.tasks[0]?.descHistory?.length, 2);
		assert.equal(a2.state.tasks[0]?.descHistory?.[1]?.from, "đề agent lần 1");
	});

	test("descHistory capped at 5 entries, each side truncated to 400 chars", () => {
		let state = seeded();
		for (let i = 0; i < 7; i++) {
			const r = updateTask(state, 1, { description: "d".repeat(900) + i, descAmend: { by: "agent" } }, i + 10);
			state = r.state;
		}
		const t = state.tasks[0]!;
		assert.equal(t.descHistory?.length, 5);
		assert.equal(t.descHistory?.[0]?.to.length, 400);
	});

	test("description update WITHOUT descAmend flag stays silent (internal paths)", () => {
		const state = seeded();
		const r = updateTask(state, 1, { description: "silent" }, 5);
		assert.equal(r.state.tasks[0]?.descAmendments, undefined);
		assert.equal(r.state.tasks[0]?.descHistory, undefined);
	});

	test("sanitizeState round-trips descAmendments + descHistory and drops junk", () => {
		const state = seeded();
		const amended = updateTask(state, 1, { description: "v2", descAmend: { by: "agent" } }, 9).state;
		const restored = sanitizeState(JSON.parse(JSON.stringify(amended)) as Record<string, unknown>);
		assert.equal(restored.tasks[0]?.descAmendments, 1);
		assert.equal(restored.tasks[0]?.descHistory?.[0]?.to, "v2");
		const junk = sanitizeState({ tasks: [{ id: 1, subject: "s", descHistory: [{ at: 1, by: "robot", from: "", to: "" }] }], nextId: 2 });
		assert.equal(junk.tasks[0]?.descHistory, undefined);
	});
});
