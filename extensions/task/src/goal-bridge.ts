/**
 * task ⇄ goal file-bridge (v1.4.51 #37).
 * Task ext KHÔNG import goal ext — đọc/ghi goal-state qua file bridge
 * (single-writer: goal engine ghi state; task ext chỉ consume lease).
 * Pure logic song hành với goal/src/goal-state.ts (useLease) — pin bằng test.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface GoalLike {
	v: 1;
	sessionId: string;
	goalId: string;
	status: "running" | "paused" | "done" | "stopped";
	lease: { granted: boolean; used: number; log: Array<{ at: string; taskId?: string; note: string }> };
}

function home(): string {
	return process.env.HOME ?? homedir();
}

function goalPath(sessionId: string): string {
	return join(home(), ".pi", "agent", "goal-state", `${sessionId}.json`);
}

function sanitize(raw: unknown): GoalLike | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.goalId !== "string" || !r.goalId.startsWith("g-")) return null;
	const status = r.status;
	if (typeof status !== "string" || !["running", "paused", "done", "stopped"].includes(status)) return null;
	const lease = (typeof r.lease === "object" && r.lease !== null ? r.lease : {}) as Record<string, unknown>;
	return {
		v: 1,
		sessionId: typeof r.sessionId === "string" ? r.sessionId : "",
		goalId: r.goalId,
		status: status as GoalLike["status"],
		lease: {
			granted: lease.granted !== false,
			used: typeof lease.used === "number" && lease.used > 0 ? 1 : 0,
			log: Array.isArray(lease.log) ? lease.log.slice(-8) : [],
		},
	};
}

export function readGoal(sessionId: string): GoalLike | null {
	try {
		return sanitize(JSON.parse(readFileSync(goalPath(sessionId), "utf8")));
	} catch {
		return null;
	}
}

/** Goal đang active cho session này (running/paused đều giữ membership). */
export function activeGoal(sessionId: string): GoalLike | null {
	const g = readGoal(sessionId);
	return g && (g.status === "running" || g.status === "paused") ? g : null;
}

/** GoalId có còn active không (chặn reopen) — quét dir vì task không biết session của goal. */
export function goalIdActive(goalId: string): boolean {
	try {
		for (const f of readdirSync(join(home(), ".pi", "agent", "goal-state"))) {
			if (!f.endsWith(".json")) continue;
			const g = readGoal(f.replace(/\.json$/, ""));
			if (g && g.goalId === goalId && (g.status === "running" || g.status === "paused")) return true;
		}
	} catch {
		// no dir — no goal
	}
	return false;
}

export type LeaseConsume =
	| { ok: true; goalId: string }
	| { ok: false; reason: string };

/** Tiêu lease (đúng 1 lần/goal) — đường appeal khi judge/cap chặn amend đề.
 *  Strict task KHÔNG qua đây (user-only door giữ nguyên). */
export function tryConsumeLease(sessionId: string, note: string, taskId?: string): LeaseConsume {
	const g = activeGoal(sessionId);
	if (!g) return { ok: false, reason: "không có goal đang chạy" };
	if (!g.lease.granted) return { ok: false, reason: "lease không được cấp cho goal này" };
	if (g.lease.used >= 1) return { ok: false, reason: "lease đã dùng 1/1 lần" };
	const entry = { at: new Date().toISOString(), ...(taskId ? { taskId } : {}), note: note.slice(0, 400) };
	try {
		const file = goalPath(sessionId);
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const lease = (raw.lease ?? {}) as Record<string, unknown>;
		lease.used = 1;
		lease.log = [...(Array.isArray(lease.log) ? lease.log : []), entry].slice(-8);
		raw.lease = lease;
		raw.updatedAt = entry.at;
		const tmp = `${file}.tmp-${process.pid}`;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, JSON.stringify(raw), "utf8");
		renameSync(tmp, file);
		return { ok: true, goalId: g.goalId };
	} catch {
		return { ok: false, reason: "goal-state file không ghi được" };
	}
}
