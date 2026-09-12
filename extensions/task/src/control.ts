/**
 * Control-file bridge for user-only task actions (v1.4.28).
 *
 * PARK is one-way for the model: task_update may put a task INTO parked
 * (appeal, round cap) but may never take it OUT — otherwise the worker just
 * un-parks itself and the user never sees the dispute (user report
 * 2026-09-09: "nếu bị park thì phải là mình xử lý bằng tay, chứ agent vẫn có
 * quyền cập nhật thì nó bypass"). Same doctrine for strict v2 (settled
 * 03:38): raising strict is safe for anyone, LOWERING strict is user-only —
 * so the verify-amendment path may not drop strict either.
 *
 * The only door out is a surface the model cannot touch: the Paseo task
 * panel buttons → plugin RPC writes this control file → the engine watches
 * it, applies the action, and rewrites the file with ackAt (snip bridge
 * pattern, production since v1.4.6).
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { openBlockers, updateTask } from "./graph.ts";
import type { TaskState } from "./types.ts";

export type TaskControlAction = "unpark" | "strict" | "reopen";

export interface TaskControlFile {
	v: 1;
	action: TaskControlAction;
	id: number;
	/** strict only: target value */
	value?: boolean;
	sentAt?: string;
	ackAt?: string;
}

/** Control dir (per-session files inside), mirroring taskStatusPath's HOME rule. */
export function controlDir(): string {
	const home = process.env.HOME || homedir();
	return join(home, ".pi", "agent", "task-control");
}

export function controlFilePath(sessionId: string): string {
	return join(controlDir(), `${sessionId}.json`);
}

export function parseControlPayload(raw: string): TaskControlFile | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	if (d.v !== 1) return null;
	if (d.action !== "unpark" && d.action !== "strict" && d.action !== "reopen") return null;
	if (typeof d.id !== "number" || !Number.isInteger(d.id) || d.id <= 0) return null;
	if (d.value !== undefined && typeof d.value !== "boolean") return null;
	return {
		v: 1,
		action: d.action,
		id: d.id,
		value: d.value,
		sentAt: typeof d.sentAt === "string" ? d.sentAt : undefined,
		ackAt: typeof d.ackAt === "string" ? d.ackAt : undefined,
	};
}

export interface ControlApplyResult {
	state: TaskState;
	note: string;
	applied: boolean;
}

/** Apply a user-surface action to the task state.
 *  Pure: no fs, no clock — the caller owns reading the file and writing the ack. */
export function applyControlAction(state: TaskState, payload: TaskControlFile, now: number): ControlApplyResult {
	const task = state.tasks.find((t) => t.id === payload.id);
	if (!task) return { state, note: `no task #${payload.id}`, applied: false };
	if (payload.action === "unpark") {
		if (task.status !== "parked") {
			return { state, note: `#${payload.id} không ở trạng thái parked`, applied: false };
		}
		// unpark về in_progress; còn blocker thì về pending (blocked task không
		// được in_progress — cùng luật tool layer). User chủ động mở lại = user cấp
		// chu kỳ phán MỚI: reset judgeRounds/failStreak, nếu không cap 3 vòng cũ sẽ
		// park lại ngay mà không gọi judge (live incident task #13 2026-09-12).
		const index = new Map(state.tasks.map((t) => [t.id, t] as const));
		const blocked = openBlockers(task, index).length > 0;
		const result = updateTask(
			state,
			payload.id,
			{ status: blocked ? "pending" : "in_progress", clearAppeal: true, judgeRounds: 0, failStreak: 0 },
			now,
		);
		if (result.error) return { state, note: result.error, applied: false };
		return { state: result.state, note: `#${payload.id} mở lại (${blocked ? "pending — còn blocker" : "in_progress"})`, applied: true };
	}
	if (payload.action === "reopen") {
		// Force reopen (v1.4.35, user request 2026-09-10): user-only button for
		// tasks the model closed — evidence stays on record; status rolls back
		// (blocked → pending, else in_progress). Model keeps its own chat-path
		// reopen via task_update (only PARKED is one-way). Cùng luật reset chu kỳ
		// phán như unpark — tránh cap 3 vòng cũ park lại task user vừa mở.
		if (task.status !== "completed" && task.status !== "cancelled" && task.status !== "parked") {
			return { state, note: `#${payload.id} đang mở (${task.status}) — không cần reopen`, applied: false };
		}
		const index = new Map(state.tasks.map((t) => [t.id, t] as const));
		const blocked = openBlockers(task, index).length > 0;
		const result = updateTask(
			state,
			payload.id,
			{ status: blocked ? "pending" : "in_progress", clearAppeal: true, judgeRounds: 0, failStreak: 0 },
			now,
		);
		if (result.error) return { state, note: result.error, applied: false };
		return { state: result.state, note: `#${payload.id} reopen (${blocked ? "pending — còn blocker" : "in_progress"})`, applied: true };
	}
	// action === "strict"
	if (!task.verify) return { state, note: `#${payload.id} không có verify spec`, applied: false };
	const target = payload.value === undefined ? true : payload.value;
	const result = updateTask(state, payload.id, { strictOverride: target }, now);
	if (result.error) return { state, note: result.error, applied: false };
	return { state: result.state, note: `#${payload.id} strict=${target}`, applied: true };
}

export function ackPayload(payload: TaskControlFile, ackAt: string): string {
	return JSON.stringify({ ...payload, ackAt });
}

export function controlDirFor(base: string): string {
	return dirname(base);
}
