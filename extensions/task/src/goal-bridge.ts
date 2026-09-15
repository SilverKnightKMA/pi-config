/**
 * task ⇄ goal file-bridge (v1.4.51 #37).
 * The task ext does NOT import the goal ext — it reads/writes goal-state
 * through a file bridge (single-writer: the goal engine writes state; the
 * task ext only consumes leases). Pure logic mirroring goal/src/goal-state.ts
 * (useLease) — pinned by test.
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

/** The goal currently active for this session (running/paused both keep membership). */
export function activeGoal(sessionId: string): GoalLike | null {
	const g = readGoal(sessionId);
	return g && (g.status === "running" || g.status === "paused") ? g : null;
}

/** Is this goalId still active (blocks reopen) — scans the dir because the task ext does not know the goal's session. */
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

/** v1.4.69 (#61 Phase C): any goal running ANYWHERE (single-waker priority —
	 *  the task wake loop yields while a goal owns main's cadence). */
export function anyGoalRunning(): boolean {
	try {
		for (const f of readdirSync(join(home(), ".pi", "agent", "goal-state"))) {
			if (!f.endsWith(".json")) continue;
			const g = readGoal(f.replace(/\.json$/, ""));
			if (g && g.status === "running") return true;
		}
	} catch {
		// no dir → no goal
	}
	return false;
}

/** v1.4.69 (#61 Phase C): a bridged plan with open steps owns the cadence —
	 *  reads the plan ext's status projection (mode tracking + planId + steps
	 *  remaining). The task wake loop yields to it (priority: goal > plan > task). */
export function planContinuationActive(sessionId: string): boolean {
	if (!sessionId) return false;
	try {
		const raw = JSON.parse(readFileSync(join(home(), ".pi", "agent", "plan-control", `${sessionId}.status.json`), "utf8")) as Record<string, unknown>;
		if (raw.mode !== "tracking" || typeof raw.planId !== "string" || !raw.planId.startsWith("p-")) return false;
		const done = typeof raw.stepsDone === "number" ? raw.stepsDone : 0;
		const total = typeof raw.stepsTotal === "number" ? raw.stepsTotal : 0;
		return total > 0 && done < total;
	} catch {
		return false;
	}
}

/** Consume the lease (exactly once per goal) — the appeal path when judge/cap blocks a done-check amend.
 *  Strict tasks do NOT go through here (the user-only door stays). */
export function tryConsumeLease(sessionId: string, note: string, taskId?: string): LeaseConsume {
	const g = activeGoal(sessionId);
	if (!g) return { ok: false, reason: "no goal running" };
	if (!g.lease.granted) return { ok: false, reason: "lease not granted for this goal" };
	if (g.lease.used >= 1) return { ok: false, reason: "lease already used 1/1 times" };
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
		return { ok: false, reason: "goal-state file not writable" };
	}
}
