import { describe, expect, test } from "bun:test";
import {
	GOAL_BACKOFF_LADDER,
	GOAL_EPOCH_MAX,
	backoffSec,
	nextEpoch,
	pauseGoal,
	resumeGoal,
	sanitizeGoalState,
	shouldWake,
	startGoal,
	stopGoal,
	useLease,
	wrapUpReport,
} from "./goal-state.js";

const NOW = "2026-09-14T00:00:00.000Z";

describe("goal-state (#37)", () => {
	test("start: lease MẶC ĐẶN granted, epoch 0, running", () => {
		const st = startGoal("s1", "port X", NOW);
		expect(st.lease.granted).toBe(true);
		expect(st.lease.used).toBe(0);
		expect(st.epoch).toBe(0);
		expect(st.status).toBe("running");
	});

	test("lease: đúng 1 lần, lần 2 chặn cứng, chết khi goal xong", () => {
		let st = startGoal("s1", "a", NOW);
		const r1 = useLease(st, "judge đòi doneCheck khác", NOW, "#9");
		expect(r1.ok).toBe(true);
		if (r1.ok) {
			expect(r1.state.lease.used).toBe(1);
			expect(r1.state.lease.log[0]?.note).toContain("judge");
			st = r1.state;
		}
		const r2 = useLease(st, "lần nữa", NOW);
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.reason).toContain("1/1");
		const dead = stopGoal(st, NOW);
		const r3 = useLease(dead, "sau khi stop", NOW);
		expect(r3.ok).toBe(false);
	});

	test("epoch cap: chạm 20 → done, không đánh thức nữa", () => {
		let st = startGoal("s1", "a", NOW);
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

	test("pause/resume; wrap-up luôn lộ lease", () => {
		const st = pauseGoal(startGoal("s1", "a", NOW), NOW);
		expect(shouldWake(st)).toBe(false);
		expect(resumeGoal(st, NOW).status).toBe("running");
		expect(wrapUpReport(st)).toContain("CHƯA DÙNG");
		const used = useLease(startGoal("s2", "a", NOW), "đổi doneCheck theo judge", NOW, "#12");
		if (used.ok) {
			const r2 = wrapUpReport(used.state);
			expect(r2).toContain("ĐÃ DÙNG 1/1");
			expect(r2).toContain("#12");
		}
	});

	test("sanitize: null với rác; clip log về 8; epoch clamp", () => {
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
