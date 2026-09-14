import { describe, expect, test } from "bun:test";
import {
	GOAL_BACKOFF_LADDER,
	goalDone,
	makeGoalId,
	memberTasks,
	recordEpoch,
	spinning,
	confirmGoal,
	reviseGoal,
	setProposal,
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
	test("start (v1.4.52): lease granted, epoch 0, DRAFT — chạy chỉ sau confirm", () => {
		const st = startGoal("s1", "port X", NOW);
		expect(st.lease.granted).toBe(true);
		expect(st.lease.used).toBe(0);
		expect(st.epoch).toBe(0);
		expect(st.status).toBe("draft");
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

	test("v1.4.51 membership động: snapshot ∪ stamped; done khi sạch nợ", () => {
		const st = startGoal("s1", "a", NOW, { memberIds: [1, 2] });
		// board: 1 xong, 2 mở, 3 stamped chưa xong (sinh trong goal), 4 ngoài goal
		const board = [
			{ id: 1, status: "completed" },
			{ id: 2, status: "in_progress" },
			{ id: 3, status: "pending", goalId: st.goalId },
			{ id: 4, status: "pending", goalId: "g-khac-999" },
		];
		expect(memberTasks(st, board).map((t) => t.id)).toEqual([1, 2, 3]);
		expect(goalDone(st, board)).toBe(false);
		expect(goalDone(st, [
			{ id: 1, status: "completed" },
			{ id: 2, status: "cancelled" },
			{ id: 3, status: "completed", goalId: st.goalId },
		])).toBe(true);
	});

	test("v1.4.51 spinning: 2 epoch liền 0 completed → dừng sớm", () => {
		let st = startGoal("s1", "a", NOW, { memberIds: [1] });
		st = recordEpoch(st, 1, NOW, 3, 0);
		expect(spinning(st)).toBe(false); // mới 1 epoch
		st = recordEpoch(st, 2, NOW, 2, 0);
		expect(spinning(st)).toBe(true); // tạo 5 task nhưng 0 xong
		st = recordEpoch(st, 3, NOW, 0, 1);
		expect(spinning(st)).toBe(false); // có task xong → tiến độ thật
	});

	test("v1.4.51 goalId unique + wrap-up kế toán tạo/xong", () => {
		const a = makeGoalId("s1", NOW);
		const b = makeGoalId("s1", new Date(Date.parse(NOW) + 5).toISOString());
		expect(a).not.toBe(b);
		expect(a.startsWith("g-")).toBe(true);
		let st = startGoal("s1", "a", NOW, { memberIds: [1, 2, 3] });
		st = recordEpoch(st, 1, NOW, 2, 1);
		const r = wrapUpReport(st);
		expect(r).toContain("2 tạo / 1 xong / 3 member");
		expect(r).toContain("ep1: +2 tạo / 1 xong");
		expect(r).toContain("snapshot: #1 #2 #3");
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

describe("goal v1.4.52 — draft init + confirm khóa membership", () => {
	const NOW = "2026-09-14T10:00:00Z";
	test("startGoal mặc định draft; goal_propose chỉ ghi bảng, không chạy", () => {
		const st = startGoal("s1", "yêu cầu thô", NOW);
		expect(st.status).toBe("draft");
		const withP = setProposal(st, { anchor: "repo xanh + test pass", includeIds: [3, 3, 7, 0], excludeIds: [], rationale: "3&7 liên quan X", proposedAt: NOW });
		expect(withP.status).toBe("draft");
		expect(withP.proposal?.includeIds).toEqual([3, 7]); // dedupe + lọc id<=0
		expect(withP.epoch).toBe(0);
	});
	test("confirmGoal: include mode lọc theo task còn mở; exclude mode lấy phần bù", () => {
		const st = startGoal("s1", "a", NOW);
		const p = setProposal(st, { anchor: "xong", includeIds: [1, 2, 99], excludeIds: [], rationale: "r", proposedAt: NOW });
		const run = confirmGoal(p, [1, 2, 4, 5], NOW);
		expect(run.status).toBe("running");
		expect(run.memberIds).toEqual([1, 2]); // 99 không mở → loại
		expect(run.proposal).toBeUndefined();
		const p2 = setProposal(st, { anchor: "xong", includeIds: [], excludeIds: [4], rationale: "r", proposedAt: NOW });
		expect(confirmGoal(p2, [1, 2, 4, 5], NOW).memberIds).toEqual([1, 2, 5]);
	});
	test("reviseGoal về draft xóa bảng; anchor đề xuất thắng anchor thô khi confirm", () => {
		const st = startGoal("s1", "thô", NOW);
		const p = setProposal(st, { anchor: "đích đẹp", includeIds: [1], excludeIds: [], rationale: "r", proposedAt: NOW });
		const run = confirmGoal(p, [1], NOW);
		expect(run.anchor).toBe("đích đẹp");
		const rv = reviseGoal(run, NOW);
		expect(rv.status).toBe("draft");
		expect(rv.proposal).toBeUndefined();
	});
});
