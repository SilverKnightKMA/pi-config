import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeGoal, goalIdActive, tryConsumeLease } from "./goal-bridge.ts";

const HOME = mkdtempSync(join(tmpdir(), "goal-bridge-"));
const SID = "sess-1111";
function writeGoalFile(status: string, lease: { granted?: boolean; used?: number }): void {
	const dir = join(HOME, ".pi", "agent", "goal-state");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${SID}.json`), JSON.stringify({
		v: 1, sessionId: SID, goalId: "g-sess1111-1000", anchor: "a", status,
		epoch: 1, lease, memberIds: [], epochs: [], board: { members: 0, completed: 0 },
		createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z",
	}), "utf8");
}

beforeAll(() => { process.env.HOME = HOME; });
afterAll(() => { rmSync(HOME, { recursive: true, force: true }); });

describe("task⇄goal bridge (v1.4.51 #37)", () => {
	test("không có goal → activeGoal null, consume từ chối", () => {
		expect(activeGoal(SID)).toBeNull();
		const r = tryConsumeLease(SID, "note");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("không có goal");
	});

	test("goal running: lease dùng đúng 1 lần, lần 2 chặn, log có taskId", () => {
		writeGoalFile("running", { granted: true, used: 0 });
		expect(goalIdActive("g-sess1111-1000")).toBe(true);
		const r1 = tryConsumeLease(SID, "judge đòi đề khác", "#9");
		expect(r1.ok).toBe(true);
		if (r1.ok) expect(r1.goalId).toBe("g-sess1111-1000");
		const r2 = tryConsumeLease(SID, "lần nữa", "#9");
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.reason).toContain("1/1");
		// log ghi taskId
		const raw = JSON.parse(readFileSync(join(HOME, ".pi/agent/goal-state", `${SID}.json`), "utf8"));
		expect(raw.lease.used).toBe(1);
		expect(raw.lease.log[0].taskId).toBe("#9");
	});

	test("goal done → lease chết, goalIdActive false (được reopen lại)", () => {
		writeGoalFile("done", { granted: true, used: 0 });
		expect(goalIdActive("g-sess1111-1000")).toBe(false);
		const r = tryConsumeLease(SID, "muộn rồi", "#9");
		expect(r.ok).toBe(false);
	});

	test("lease không được cấp → từ chối ngay", () => {
		writeGoalFile("running", { granted: false, used: 0 });
		const r = tryConsumeLease(SID, "note", "#1");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("không được cấp");
	});
});
