import { describe, expect, test } from "bun:test";
import {
	GOAL_BACKOFF_LADDER,
	goalDone,
	makeGoalId,
	memberTasks,
	creditProgress,
	recordEpoch,
	spinning,
	wakeAccount,
	confirmGoal,
	reviseGoal,
	setProposal,
	GOAL_EPOCH_MAX,
	backoffSec,
	nextEpoch,
	pauseGoal,
	resumeGoal,
	sanitizeGoalState,
	recordProposal,
	shouldWake,
	startGoal,
	stopGoal,
	useLease,
	wrapUpReport,
} from "./goal-state.js";

const NOW = "2026-09-14T00:00:00.000Z";

describe("goal-state (#37)", () => {
	test("start (v1.4.52): lease granted, epoch 0, DRAFT — runs only after confirm", () => {
		const st = startGoal("s1", "port X", NOW);
		expect(st.lease.granted).toBe(true);
		expect(st.lease.used).toBe(0);
		expect(st.epoch).toBe(0);
		expect(st.status).toBe("draft");
	});

	test("lease: exactly once, second attempt hard-blocked, dies when the goal ends", () => {
		let st = startGoal("s1", "a", NOW);
		const r1 = useLease(st, "judge demands a different doneCheck", NOW, "#9");
		expect(r1.ok).toBe(true);
		if (r1.ok) {
			expect(r1.state.lease.used).toBe(1);
			expect(r1.state.lease.log[0]?.note).toContain("judge");
			st = r1.state;
		}
		const r2 = useLease(st, "one more", NOW);
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.reason).toContain("1/1");
		const dead = stopGoal(st, NOW);
		const r3 = useLease(dead, "after stop", NOW);
		expect(r3.ok).toBe(false);
	});

	test("epoch cap: hitting 20 → done, no more wakes", () => {
		let st = confirmGoal(setProposal(startGoal("s1", "a", NOW), { anchor: "a", includeIds: [1], excludeIds: [], rationale: "r", proposedAt: NOW }), [1], NOW);
		for (let i = 0; i < GOAL_EPOCH_MAX - 1; i++) st = nextEpoch(st, NOW);
		expect(st.status).toBe("running");
		st = nextEpoch(st, NOW);
		expect(st.epoch).toBe(GOAL_EPOCH_MAX);
		expect(st.status).toBe("done");
		expect(shouldWake(st)).toBe(false);
	});

	test("backoff ladder 5→80 cap", () => {
		expect(GOAL_BACKOFF_LADDER).toEqual([5, 10, 20, 40, 80]);
		expect(backoffSec(0)).toBe(5);
		expect(backoffSec(4)).toBe(80);
		expect(backoffSec(99)).toBe(80);
	});

	test("pause/resume; wrap-up always exposes the lease", () => {
		const st = pauseGoal(startGoal("s1", "a", NOW), NOW);
		expect(shouldWake(st)).toBe(false);
		expect(resumeGoal(st, NOW).status).toBe("running");
		expect(wrapUpReport(st)).toContain("NOT USED YET");
		const used = useLease(startGoal("s2", "a", NOW), "change doneCheck per judge", NOW, "#12");
		if (used.ok) {
			const r2 = wrapUpReport(used.state);
			expect(r2).toContain("USED 1/1");
			expect(r2).toContain("#12");
		}
	});

	test("v1.4.51 dynamic membership: snapshot ∪ stamped; done when the board is clear", () => {
		const st = startGoal("s1", "a", NOW, { memberIds: [1, 2] });
		// board: 1 done, 2 open, 3 stamped not done (born inside the goal), 4 outside the goal
		const board = [
			{ id: 1, status: "completed" },
			{ id: 2, status: "in_progress" },
			{ id: 3, status: "pending", goalId: st.goalId },
			{ id: 4, status: "pending", goalId: "g-other-999" },
		];
		expect(memberTasks(st, board).map((t) => t.id)).toEqual([1, 2, 3]);
		expect(goalDone(st, board)).toBe(false);
		expect(goalDone(st, [
			{ id: 1, status: "completed" },
			{ id: 2, status: "cancelled" },
			{ id: 3, status: "completed", goalId: st.goalId },
		])).toBe(true);
	});

	test("v1.4.51 spinning: 2 consecutive epochs with 0 completed → stop early", () => {
		let st = startGoal("s1", "a", NOW, { memberIds: [1] });
		st = recordEpoch(st, 1, NOW, 3, 0);
		expect(spinning(st)).toBe(false); // only 1 epoch so far
		st = recordEpoch(st, 2, NOW, 2, 0);
		expect(spinning(st)).toBe(true); // 5 tasks created but 0 done
		st = recordEpoch(st, 3, NOW, 0, 1);
		expect(spinning(st)).toBe(false); // a task done → real progress
	});

	test("v1.4.51 goalId unique + wrap-up create/done accounting", () => {
		const a = makeGoalId("s1", NOW);
		const b = makeGoalId("s1", new Date(Date.parse(NOW) + 5).toISOString());
		expect(a).not.toBe(b);
		expect(a.startsWith("g-")).toBe(true);
		let st = startGoal("s1", "a", NOW, { memberIds: [1, 2, 3] });
		st = recordEpoch(st, 1, NOW, 2, 1);
		const r = wrapUpReport(st);
		expect(r).toContain("2 created / 1 done / 3 members");
		expect(r).toContain("ep1: +2 created / 1 done");
		expect(r).toContain("snapshot: #1 #2 #3");
	});

	test("sanitize: null on junk; clip log to 8; epoch clamp", () => {
		expect(sanitizeGoalState(null)).toBeNull();
		expect(sanitizeGoalState({ v: 2 })).toBeNull();
		const st = sanitizeGoalState({
			v: 1, sessionId: "s", anchor: "a", status: "running",
			epoch: 99,
			lease: { granted: true, used: 3, log: Array.from({ length: 12 }, (_, i) => ({ at: NOW, note: `n${i}` })) },
		});
		expect(st).not.toBeNull();
		if (st) {
			expect(st.epoch).toBe(GOAL_EPOCH_MAX);
			expect(st.lease.used).toBe(1);
			expect(st.lease.log.length).toBe(8);
		}
	});
});

	describe("goal v1.4.52 — draft init + confirm locks membership", () => {
	const NOW = "2026-09-14T10:00:00Z";
	test("startGoal defaults to draft; goal_propose only records the table, does not run", () => {
		const st = startGoal("s1", "raw request", NOW);
		expect(st.status).toBe("draft");
		const withP = setProposal(st, { anchor: "repo green + tests pass", includeIds: [3, 3, 7, 0], excludeIds: [], rationale: "3&7 related to X", proposedAt: NOW });
		expect(withP.status).toBe("draft");
		expect(withP.proposal?.includeIds).toEqual([3, 7]); // dedupe + drop id<=0
		expect(withP.epoch).toBe(0);
	});
	test("confirmGoal: include mode filters to still-open tasks; exclude mode takes the complement", () => {
		const st = startGoal("s1", "a", NOW);
		const p = setProposal(st, { anchor: "done", includeIds: [1, 2, 99], excludeIds: [], rationale: "r", proposedAt: NOW });
		const run = confirmGoal(p, [1, 2, 4, 5], NOW);
		expect(run.status).toBe("running");
		expect(run.memberIds).toEqual([1, 2]); // 99 not open → dropped
		expect(run.proposal).toBeUndefined();
		const p2 = setProposal(st, { anchor: "done", includeIds: [], excludeIds: [4], rationale: "r", proposedAt: NOW });
		expect(confirmGoal(p2, [1, 2, 4, 5], NOW).memberIds).toEqual([1, 2, 5]);
	});
	test("reviseGoal returns to draft and clears the table; the proposed anchor beats the raw anchor on confirm", () => {
		const st = startGoal("s1", "raw", NOW);
		const p = setProposal(st, { anchor: "a nice destination", includeIds: [1], excludeIds: [], rationale: "r", proposedAt: NOW });
		const run = confirmGoal(p, [1], NOW);
		expect(run.anchor).toBe("a nice destination");
		const rv = reviseGoal(run, NOW);
		expect(rv.status).toBe("draft");
		expect(rv.proposal).toBeUndefined();
	});
	// #88 (2026-09-16): the proposal table must survive the disk→RAM roundtrip.
	// Regression: sanitizeGoalState rebuilt the object without `proposal`, so
	// /goal confirm failed "draft without a proposal" while the disk file had it.
	test("#88 sanitize roundtrip KEEPS the proposal table (draft survives reload)", () => {
		const st = startGoal("s1", "raw anchor", NOW);
		const p = setProposal(st, { anchor: "approved destination", includeIds: [34, 43, 82], excludeIds: [1, 84], rationale: "user picked the build table", proposedAt: NOW });
		const reloaded = sanitizeGoalState(JSON.parse(JSON.stringify(p)));
		expect(reloaded).not.toBeNull();
		expect(reloaded!.status).toBe("draft");
		expect(reloaded!.proposal).toBeDefined();
		expect(reloaded!.proposal!.anchor).toBe("approved destination");
		expect(reloaded!.proposal!.includeIds).toEqual([34, 43, 82]);
		expect(reloaded!.proposal!.excludeIds).toEqual([1, 84]);
		expect(reloaded!.proposal!.rationale).toBe("user picked the build table");
		expect(reloaded!.proposal!.proposedAt).toBe(NOW);
		// and the confirm that failed live now works straight off the sanitized state
		const run = confirmGoal(reloaded!, [34, 43, 82, 100], NOW);
		expect(run.status).toBe("running");
		expect(run.memberIds).toEqual([34, 43, 82]);
	});
	test("#88 sanitize drops a malformed proposal without killing the state", () => {
		const st = startGoal("s1", "raw anchor", NOW);
		const p = setProposal(st, { anchor: "ok", includeIds: [1], excludeIds: [], rationale: "r", proposedAt: NOW });
		const broken = { ...(JSON.parse(JSON.stringify(p)) as Record<string, unknown>), proposal: { anchor: 42 } };
		const reloaded = sanitizeGoalState(broken);
		expect(reloaded).not.toBeNull();
		expect(reloaded!.status).toBe("draft");
		expect(reloaded!.proposal).toBeUndefined();
	});
	// #89 (2026-09-16): mid-turn completions must reach the epoch accounting.
	// Incident: goal auto-stopped "spinning: 2 epochs 0 done" while #34/#43 completed
	// mid-turn — settle() had absorbed them into board.completed, so the wake delta was 0.
	test("#89 creditProgress + spinning: pending credit blocks the spinning stop", () => {
		let st = startGoal("s1", "finish 8 tasks", NOW);
		st = confirmGoal(st, [34, 43], NOW);
		st = recordEpoch(st, 1, NOW, 0, 0);
		st = recordEpoch(st, 2, NOW, 0, 0);
		expect(spinning(st)).toBe(true); // genuinely stalled → stops (unchanged)
		const credited = creditProgress(st, 2); // both members completed mid-turn
		expect(credited.credited).toBe(2);
		expect(credited.pendingCompleted).toBe(2);
		expect(spinning(credited)).toBe(false); // #89: progress RIGHT NOW → no stop
		// no-op when the board has not moved
		expect(creditProgress(credited, 2)).toBe(credited);
	});
	test("#89 wakeAccount flushes pending credit into the consumed epoch record", () => {
		let st = startGoal("s1", "finish 8 tasks", NOW);
		st = confirmGoal(st, [34, 43], NOW);
		st = recordEpoch(st, 1, NOW, 0, 0);
		st = recordEpoch(st, 2, NOW, 0, 0);
		st = creditProgress(st, 1); // one member completed mid-turn (settle path)
		const after = wakeAccount(st, 2, 0, NOW); // wake: second member completed in the last instant
		expect(after.epoch).toBe(1); // nextEpoch bumped 0→1 (recordEpoch n is a label, not the counter)
		expect(after.epochs.at(-1)!.completed).toBe(2); // BOTH completions credited
		expect(after.pendingCompleted).toBe(0); // flushed, not lost
		expect(after.credited).toBe(2);
		expect(spinning(after)).toBe(false);
	});
	test("#89 sanitize keeps credited/pendingCompleted across the disk roundtrip", () => {
		let st = startGoal("s1", "a", NOW);
		st = confirmGoal(st, [1], NOW);
		st = creditProgress(st, 1);
		const reloaded = sanitizeGoalState(JSON.parse(JSON.stringify(st)));
		expect(reloaded!.credited).toBe(1);
		expect(reloaded!.pendingCompleted).toBe(1);
	});
});
