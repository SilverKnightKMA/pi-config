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
		const closed = updateTask(state, 1, { status: "completed", evidence: "done (e2e)" }, 2);
		state = closed.state;
		const r = applyControlAction(state, { v: 1, action: "reopen", id: 1 }, 3);
		assert.equal(r.applied, true);
		const t = r.state.tasks.find((x) => x.id === 1)!;
		assert.equal(t.status, "in_progress");
		// #294 P1: reopening clears stale evidence — the next completion must bring
		// fresh evidence in its own patch (inherited evidence cannot re-close).
		assert.equal(t.evidence, null);
	});

	test("reopen of a completed task with a re-opened blocker falls back to pending", () => {
		const a = createTask(EMPTY_STATE, "blocker", "dc", [], Date.now());
		let state = a.state;
		const b = createTask(state, "main", "dc", [1], Date.now());
		state = b.state;
		state = updateTask(state, 1, { status: "completed", evidence: "ok1" }, 1).state;
		state = updateTask(state, 2, { status: "completed", evidence: "ok2" }, 1).state;
		// blocker reopened by the user → task 2 now has an open blocker
		state = applyControlAction(state, { v: 1, action: "reopen", id: 1 }, 2).state;
		const r = applyControlAction(state, { v: 1, action: "reopen", id: 2 }, 3);
		assert.equal(r.applied, true);
		assert.equal(r.state.tasks.find((x) => x.id === 2)!.status, "pending");
	});

	test("reopen refuses a task that is already open", () => {
		const state = seeded();
		const r = applyControlAction(state, { v: 1, action: "reopen", id: 1 }, 1);
		assert.equal(r.applied, false);
		assert.match(r.note, /no reopen needed/);
	});
});

describe("control: applyControlAction", () => {
	test("unpark reopens a parked task as in_progress and clears the appeal reason", () => {
		let state = seeded();
		state = updateTask(state, 1, { evidence: "e" }, 1).state;
		state = updateTask(state, 1, { status: "parked", appealReason: "dispute" }, 2).state;
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
		assert.match(r.note, /pending — still blocked/);
	});

	test("unpark refuses a task that is not parked", () => {
		const state = seeded();
		const r = applyControlAction(state, { v: 1, action: "unpark", id: 1 }, 2);
		assert.equal(r.applied, false);
		assert.match(r.note, /not in parked status/);
	});

	test("strict flips the flag without touching verifyAmendments", () => {
		let state = seeded({ lane: "judgment", probes: [], strict: false });
		const r = applyControlAction(state, { v: 1, action: "strict", id: 1, value: true }, 2);
		assert.equal(r.applied, true);
		assert.equal(r.state.tasks[0]!.verify!.strict, true);
		assert.equal(r.state.tasks[0]!.verifyAmendments, 0); // does not consume the amend budget (still 0 from create)
		// lowering works too — via the bridge (user)
		const r2 = applyControlAction(r.state, { v: 1, action: "strict", id: 1, value: false }, 3);
		assert.equal(r2.state.tasks[0]!.verify!.strict, false);
	});

	test("strict on a task without verify spec is a no-op note", () => {
		const state = seeded();
		const r = applyControlAction(state, { v: 1, action: "strict", id: 1, value: true }, 2);
		assert.equal(r.applied, false);
		assert.match(r.note, /has no verify spec/);
	});
});

// v1.4.37: the user reopening (unpark/reopen) = a fresh judging cycle — reset counters,
// otherwise the old 3-round cap re-parks immediately without calling the judge (live #13 2026-09-12)
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
		// #294 P1: stale evidence cleared on reopen (was "e" before the port).
		expect(t.evidence).toBe(null);
	});
});

// ── v1.4.38 doneCheck guard (amend) ─────────────────────────────────────
describe("control: doneCheck amend (user-only door, v1.4.38)", () => {
	test("valid amend payload parses; empty/malformed description rejected", () => {
		const ok = parseControlPayload('{"v":1,"action":"amend","id":5,"description":"  new  "}');
		assert.equal(ok?.action, "amend");
		assert.equal(ok?.description, "new");
		assert.equal(parseControlPayload('{"v":1,"action":"amend","id":5,"description":""}'), null);
		assert.equal(parseControlPayload('{"v":1,"action":"amend","id":5}'), null);
		// length cap 2000 guards against packet bloat
		const long = parseControlPayload(`{"v":1,"action":"amend","id":5,"description":"${"x".repeat(3000)}"}`);
		assert.equal(long?.description.length, 2000);
	});

	test("amend by user rewrites description, keeps old sheet in trail, does not consume the cap", () => {
		const state = seeded();
		const res = applyControlAction(
			state,
			{ v: 1, action: "amend", id: 1, description: "user's new brief" },
			Date.now(),
		);
		assert.equal(res.applied, true);
		const t = res.state.tasks[0]!;
		assert.equal(t.description, "user's new brief");
		assert.equal(t.descHistory?.length, 1);
		assert.equal(t.descHistory?.[0]?.by, "user");
		assert.equal(t.descHistory?.[0]?.from, "done-check");
		assert.equal(t.descAmendments, undefined); // user edits do not count
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
		const a1 = updateTask(state, 1, { description: "agent brief v1", descAmend: { by: "agent" } }, 2);
		assert.equal(a1.state.tasks[0]?.descAmendments, 1);
		const a2 = updateTask(a1.state, 1, { description: "user brief", descAmend: { by: "user" } }, 3);
		assert.equal(a2.state.tasks[0]?.descAmendments, 1, "user amend costs no budget");
		assert.equal(a2.state.tasks[0]?.descHistory?.length, 2);
		assert.equal(a2.state.tasks[0]?.descHistory?.[1]?.from, "agent brief v1");
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

describe("#272 proposal-decide dId — cancel-proposal KEEP flips status (v1.4.141)", () => {
	function stateWithCancelProposal(blocked = false): TaskState {
		let st = createTask(EMPTY_STATE, "t", "brief", [], 1000).state!;
		if (blocked) {
			st = createTask(st, "blocker", "b", [], 1000).state!;
			st.tasks[0] = { ...st.tasks[0], blockedBy: [2] };
		}
		const t = st.tasks[0];
		st.tasks[0] = { ...t, status: "proposed_cancel" as const };
		return st;
	}
	const hookOk = (dId: string, decision: "approved" | "rejected") => ({ taskId: 1, kind: "cancel-proposal" });
	test("KEEP (rejected): proposed_cancel task flips back in_progress (unblocked)", () => {
		const st = stateWithCancelProposal(false);
		const r = applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, dId: "d-1", decision: "rejected" }, 3000, { decideEntry: hookOk });
		expect(r.applied).toBe(true);
		expect(r.state.tasks[0].status).toBe("in_progress");
		expect(r.note).toContain("#1 kept");
	});
	test("KEEP (rejected) with open blocker: flips to pending, not in_progress", () => {
		const st = stateWithCancelProposal(true);
		const r = applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, dId: "d-1", decision: "rejected" }, 3000, { decideEntry: hookOk });
		expect(r.applied).toBe(true);
		expect(r.state.tasks[0].status).toBe("pending");
		expect(r.note).toContain("still blocked");
	});
	test("amend kind rejected: status untouched (no flip outside cancel-proposal)", () => {
		const st = stateWithCancelProposal(false);
		const r = applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, dId: "d-2", decision: "rejected" }, 3000, { decideEntry: () => ({ taskId: 1, kind: "amend" }) });
		expect(r.applied).toBe(true);
		expect(r.state.tasks[0].status).toBe("proposed_cancel"); // unchanged
	});
});

describe("proposal-decide (v1.4.53 — approval board when amend is blocked)", () => {
	function stateWithProposal(strict = false): TaskState {
		let st = createTask(EMPTY_STATE, "t", "original brief", [], 1000, strict ? { lane: "state", strict: true, probes: [{ pattern: "ls", expect: "x" }] } : undefined).state!;
		const t = st.tasks[0];
		st.tasks[0] = { ...t, proposals: [{ id: "p1", at: 2000, from: "original brief", to: "new brief", reason: "cap 2/2", status: "pending" }] };
		return st;
	}
	test("apply: new brief applied, does NOT consume descAmendments, descHistory records user-proposal", () => {
		const st = stateWithProposal();
		const r = applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, proposalId: "p1", decision: "apply" }, 3000);
		expect(r.applied).toBe(true);
		const t = r.state.tasks[0];
		expect(t.description).toBe("new brief");
		expect(t.descAmendments ?? 0).toBe(0);
		expect(t.descHistory?.at(-1)?.by).toBe("user-proposal");
		expect(t.proposals?.[0].status).toBe("applied");
		expect(t.proposals?.[0].decidedAt).toBe(3000);
	});
	test("reject: brief unchanged, proposal marked rejected + note", () => {
		const st = stateWithProposal();
		const r = applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, proposalId: "p1", decision: "reject", note: "insufficient grounds" }, 3000);
		expect(r.applied).toBe(true);
		const t = r.state.tasks[0];
		expect(t.description).toBe("original brief");
		expect(t.proposals?.[0].status).toBe("rejected");
		expect(t.proposals?.[0].note).toBe("insufficient grounds");
	});
	test("wrong id / already decided → not applied", () => {
		const st = stateWithProposal();
		expect(applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, proposalId: "pX", decision: "apply" }, 3000).applied).toBe(false);
		const done = applyControlAction(st, { v: 1, action: "proposal-decide", id: 1, proposalId: "p1", decision: "apply" }, 3000);
		const again = applyControlAction(done.state, { v: 1, action: "proposal-decide", id: 1, proposalId: "p1", decision: "apply" }, 3500);
		expect(again.applied).toBe(false);
	});
	test("parseControlPayload: full pair passes, missing decision fails", () => {
		const ok = parseControlPayload(JSON.stringify({ v: 1, action: "proposal-decide", id: 1, proposalId: "p1", decision: "apply" }));
		expect(ok?.action).toBe("proposal-decide");
		expect(ok?.decision).toBe("apply");
		expect(parseControlPayload(JSON.stringify({ v: 1, action: "proposal-decide", id: 1, proposalId: "p1" }))).toBeNull();
	});
});
