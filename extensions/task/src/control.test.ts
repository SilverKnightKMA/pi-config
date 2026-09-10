/**
 * Pure tests for the user-only control bridge (v1.4.28).
 * Contract: model may park (appeal/cap), only the user surface (control file)
 * may un-park; strict lowering likewise never passes through the model.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import { ackPayload, applyControlAction, parseControlPayload } from "./control.ts";
import { createTask, updateTask } from "./graph.ts";
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
