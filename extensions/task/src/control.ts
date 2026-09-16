/**
 * Control-file bridge for user-only task actions (v1.4.28).
 *
 * PARK is one-way for the model: task_update may put a task INTO parked
 * (appeal, round cap) but may never take it OUT — otherwise the worker just
 * un-parks itself and the user never sees the dispute (user report
 * 2026-09-09: "if something is parked I must handle it by hand — if the
 * agent still has update rights it just bypasses"). Same doctrine for strict v2 (settled
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

export type TaskControlAction = "unpark" | "strict" | "reopen" | "amend" | "proposal-decide" | "cancel";

export interface TaskControlFile {
	v: 1;
	action: TaskControlAction;
	id: number;
	/** strict only: target value */
	value?: boolean;
	/** amend only (v1.4.38): the new done-check text, authored by the user. */
	description?: string;
	/** proposal-decide only (v1.4.53). */
	proposalId?: string;
	decision?: "apply" | "reject";
	note?: string;
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
	if (d.action !== "unpark" && d.action !== "strict" && d.action !== "reopen" && d.action !== "amend" && d.action !== "proposal-decide") return null;
	if (typeof d.id !== "number" || !Number.isInteger(d.id) || d.id <= 0) return null;
	if (d.value !== undefined && typeof d.value !== "boolean") return null;
	// proposal-decide (v1.4.53): the user clicks ✓/✗ on a done-check amendment proposal
	if (d.action === "proposal-decide") {
		if (typeof d.proposalId !== "string" || !d.proposalId) return null;
		if (d.decision !== "apply" && d.decision !== "reject") return null;
		return {
			v: 1,
			action: "proposal-decide",
			id: d.id,
			proposalId: d.proposalId,
			decision: d.decision,
			note: typeof d.note === "string" ? d.note.slice(0, 1000) : undefined,
			sentAt: typeof d.sentAt === "string" ? d.sentAt : undefined,
			ackAt: typeof d.ackAt === "string" ? d.ackAt : undefined,
		};
	}
	// amend: the new brief must be a non-empty string, truncated to 2000 chars (guards against packet bloat)
	if (d.action === "amend") {
		if (typeof d.description !== "string" || !d.description.trim()) return null;
		return {
			v: 1,
			action: "amend",
			id: d.id,
			description: d.description.trim().slice(0, 2000),
			sentAt: typeof d.sentAt === "string" ? d.sentAt : undefined,
			ackAt: typeof d.ackAt === "string" ? d.ackAt : undefined,
		};
	}
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
	// v1.4.88 cancel (user-only): the panel/chat-user force-cancel. The model
	// path NEVER reaches here (tool-layer guard refuses decisionOf pairs), so a
	// [CHỜ USER QUYẾT] stage can only be dropped by a genuine user action.
	// Cancelling A here also genuinely cancels its pending pairs (user origin).
	if (payload.action === "cancel") {
		if (task.status === "completed") {
			return { state, note: `#${payload.id} already completed — cancel not applicable`, applied: false };
		}
		const r = updateTask(state, payload.id, { status: "cancelled" }, now);
		if (r.error) return { state, note: r.error, applied: false };
		let next = r.state;
		for (const t of next.tasks) {
			if (t.decisionOf === payload.id && t.status === "pending") {
				const casc = updateTask(next, t.id, { status: "cancelled" }, now);
				if (!casc.error) next = casc.state;
			}
		}
		return { state: next, note: `#${payload.id} cancelled (user)`, applied: true };
	}
	if (payload.action === "unpark") {
		if (task.status !== "parked") {
			return { state, note: `#${payload.id} not in parked status`, applied: false };
		}
		// unpark goes to in_progress; with an open blocker it goes to pending (a
		// blocked task may not be in_progress — same law as the tool layer). The
		// user proactively reopening = the user grants a NEW judging cycle: reset
		// judgeRounds/failStreak, otherwise the old 3-round cap re-parks it
		// immediately without calling the judge (live incident task #13 2026-09-12).
		const index = new Map(state.tasks.map((t) => [t.id, t] as const));
		const blocked = openBlockers(task, index).length > 0;
		const result = updateTask(
			state,
			payload.id,
			{ status: blocked ? "pending" : "in_progress", clearAppeal: true, judgeRounds: 0, failStreak: 0 },
			now,
		);
		if (result.error) return { state, note: result.error, applied: false };
		return { state: result.state, note: `#${payload.id} reopened (${blocked ? "pending — still blocked" : "in_progress"})`, applied: true };
	}
	if (payload.action === "reopen") {
		// Force reopen (v1.4.35, user request 2026-09-10): user-only button for
		// tasks the model closed — evidence stays on record; status rolls back
		// (blocked → pending, else in_progress). Model keeps its own chat-path
		// reopen via task_update (only PARKED is one-way). Same cycle-reset rule
		// as unpark — avoids the old 3-round cap re-parking a task the user just reopened.
		if (task.status !== "completed" && task.status !== "cancelled" && task.status !== "parked") {
			return { state, note: `#${payload.id} already open (${task.status}) — no reopen needed`, applied: false };
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
		return { state: result.state, note: `#${payload.id} reopen (${blocked ? "pending — still blocked" : "in_progress"})`, applied: true };
	}
	if (payload.action === "proposal-decide") {
		// v1.4.53: the user approves/rejects a done-check amendment proposal on the panel.
		// apply = the user-amend path: does NOT consume the descAmendments cap, descHistory by 'user-proposal'.
		const p = (task.proposals ?? []).find((x) => x.id === payload.proposalId && x.status === "pending");
		if (!p) return { state, note: `#${payload.id} has no pending proposal ${payload.proposalId ?? "?"}`, applied: false };
		const decided = (task.proposals ?? []).map((x) =>
			x.id === p.id ? { ...x, status: payload.decision === "apply" ? ("applied" as const) : ("rejected" as const), decidedAt: now, note: payload.note } : x,
		);
		if (payload.decision === "apply") {
			const result = updateTask(state, payload.id, {
				description: p.to,
				descAmend: { by: "user-proposal" },
				proposals: decided,
			}, now);
			if (result.error) return { state, note: result.error, applied: false };
			return { state: result.state, note: `#${payload.id} APPROVED proposal ${p.id} — new brief applied (no cap consumed)`, applied: true };
		}
		const result = updateTask(state, payload.id, { proposals: decided }, now);
		if (result.error) return { state, note: result.error, applied: false };
		return { state: result.state, note: `#${payload.id} REJECTED proposal ${p.id}${payload.note ? ` (note: ${payload.note})` : ""} — brief unchanged`, applied: true };
	}
	if (payload.action === "amend") {
		// v1.4.38 doneCheck guard — the user-only door when the agent is out of
		// budget (cap DESC_AMEND_MAX) or the task is strict. The user owns the
		// contract: edits cost no budget but STILL record descHistory (by user)
		// so the judge sees the brief's entire life, not just the final version.
		const next = payload.description ?? "";
		if (!next || next === task.description) {
			return { state, note: `#${payload.id} new description identical or empty — skipped`, applied: false };
		}
		const result = updateTask(state, payload.id, { description: next, descAmend: { by: "user" } }, now);
		if (result.error) return { state, note: result.error, applied: false };
		return { state: result.state, note: `#${payload.id} doneCheck edited by user (trail keeps the old sheet)`, applied: true };
	}
	// action === "strict"
	if (!task.verify) return { state, note: `#${payload.id} has no verify spec`, applied: false };
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
